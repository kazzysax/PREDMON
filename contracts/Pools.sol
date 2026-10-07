// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Reputation} from "./Reputation.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title Pools — sealed price guesses, paid by closeness.
/// @notice Anyone opens a pool: an asset, a result time and a fixed entry amount.
///         Everyone pays the same amount and submits a sealed guess. After the
///         result price arrives, the closest 30% of guesses share the pot, closer
///         guesses getting more.
///
/// Timeline of one pool
///   now ......... lockTime   entries open (commitment only, guess hidden)
///   lockTime .... resultTime guesses are revealed (reveal window)
///   resultTime .. +24h       price is posted (feed read, settler or forwarder)
///   after price              anyone submits the ranking, closest first
///   ranking done             winners claim; the first entry per user is scored
///
/// A pool refunds everyone if fewer than 3 guesses were revealed, no price
/// arrived in time, or the ranking was never finished. Entries that were never
/// revealed are refunded after the result time.
///
/// Guesses are in the feed's own units (Chainlink USD feeds use 8 decimals).
contract Pools is Base {
    // ---------------------------------------------------------------- types

    struct Pool {
        address creator;
        uint8 asset;
        bool voided;
        bool priced;
        uint64 lockTime;
        uint64 resultTime;
        uint64 pricedAt;
        uint128 entryAmount;
        uint32 entryCount;
        uint32 revealedCount;
        uint32 rankedCount;
        uint32 lastRankedId;
        uint256 price;
        uint256 lastDistance;
    }

    struct Entry {
        address entrant;
        bool revealed;
        bool ranked;
        bool claimed;
        bool scored;
        uint32 rank;
        bytes32 commitment;
        uint256 guess;
    }

    // ------------------------------------------------------------ constants

    uint256 internal constant BPS = 10_000;
    uint8 internal constant CRYPTO = 0;

    uint64 public constant LOCK_BEFORE = 3 hours;
    uint64 public constant MIN_ENTRY_WINDOW = 30 minutes;
    uint64 public constant MAX_HORIZON = 7 days;
    /// Price must be posted within this long after the result time.
    uint64 public constant REPORT_WINDOW = 24 hours;
    /// Ranking must finish within this long after the price is posted.
    uint64 public constant RANK_WINDOW = 72 hours;
    /// Window after the result time in which anyone may settle straight from the feed.
    uint64 public constant FEED_WINDOW = 10 minutes;
    /// A price older than this before the result time is rejected.
    uint64 public constant MAX_STALENESS = 1 days;

    uint32 public constant MAX_ENTRIES = 300;
    uint32 public constant MIN_REVEALED = 3;
    uint256 public constant WINNER_BPS = 3_000;
    uint256 public constant POOLS_PER_DAY = 3;
    uint256 public constant MAX_BATCH = 300;
    /// Reputation at stake per pool, x100: +K for the closest, -K for the furthest.
    int256 public constant K = 1_000;

    // -------------------------------------------------------------- storage

    Reputation public immutable reputation;
    /// Most MON one entry may cost. Start low, raise after the dry run.
    uint256 public maxEntry;

    mapping(uint8 => bool) public assetEnabled;
    /// Optional Chainlink feed per asset, for settling without a trusted poster.
    mapping(uint8 => address) public assetFeed;
    /// How old a feed answer may be, per asset (set near the feed's heartbeat).
    mapping(uint8 => uint64) public assetMaxAge;

    uint256 public poolCount;
    mapping(uint256 => Pool) internal _pools;
    mapping(uint256 => mapping(uint256 => Entry)) internal _entries;
    mapping(uint256 => mapping(address => uint32)) public firstEntry;
    mapping(address => mapping(uint256 => uint256)) public createdOnDay;

    // --------------------------------------------------------------- events

    event PoolCreated(
        uint256 indexed id,
        address indexed creator,
        uint8 asset,
        uint256 entryAmount,
        uint64 lockTime,
        uint64 resultTime
    );
    event Entered(uint256 indexed id, uint256 indexed entryId, address indexed entrant, bytes32 commitment);
    event Revealed(uint256 indexed id, uint256 indexed entryId, address indexed entrant, uint256 guess);
    event PriceReported(uint256 indexed id, uint256 price, uint64 priceTimestamp);
    event RankSubmitted(uint256 indexed id, uint32 rankedCount, uint32 revealedCount);
    event EntryScored(uint256 indexed id, uint256 indexed entryId, address indexed entrant, int256 repDelta, bool won);
    event Claimed(uint256 indexed id, uint256 indexed entryId, address indexed entrant, uint256 amount);
    event PoolVoided(uint256 indexed id);
    event MaxEntrySet(uint256 maxEntry);
    event AssetSet(uint8 indexed asset, bool enabled, address feed, uint64 maxAge);

    // --------------------------------------------------------------- errors

    error BadAsset();
    error BadEntryAmount();
    error BadWindow();
    error DailyLimit();
    error NoSuchPool();
    error EntriesClosed();
    error PoolFull();
    error WrongAmount();
    error RevealClosed();
    error BadReveal();
    error AlreadyRevealed();
    error NotYet();
    error TooLate();
    error AlreadyPriced();
    error NotPriced();
    error BadPrice();
    error NoFeed();
    error Refunding();
    error BadRanking();
    error NotSettled();
    error NothingToClaim();
    error BatchTooLarge();
    error NotEntrant();

    // ---------------------------------------------------------------- setup

    constructor(Reputation reputation_, uint256 maxEntry_) {
        reputation = reputation_;
        maxEntry = maxEntry_;
    }

    function getPool(uint256 id) external view returns (Pool memory) {
        return _pools[id];
    }

    function getEntry(uint256 id, uint256 entryId) external view returns (Entry memory) {
        return _entries[id][entryId];
    }

    /// @notice Raise or lower the most one entry may cost.
    function setMaxEntry(uint256 value) external onlyOwner {
        if (value > type(uint128).max) revert BadEntryAmount();
        maxEntry = value;
        emit MaxEntrySet(value);
    }

    /// @notice Enable an asset, optionally with a Chainlink feed that lets anyone
    ///         settle without relying on a poster. `maxAge` is how stale that
    ///         feed's answer may be at settlement.
    function setAsset(uint8 asset, bool enabled, address feed, uint64 maxAge) external onlyOwner {
        assetEnabled[asset] = enabled;
        assetFeed[asset] = feed;
        assetMaxAge[asset] = maxAge;
        emit AssetSet(asset, enabled, feed, maxAge);
    }

    // --------------------------------------------------------------- creating

    /// @notice Open a pool. Anyone may; three a day each.
    function createPool(uint8 asset, uint64 resultTime, uint256 entryAmount)
        external
        whenNotPaused
        returns (uint256 id)
    {
        if (!assetEnabled[asset]) revert BadAsset();
        if (entryAmount == 0 || entryAmount > maxEntry) revert BadEntryAmount();
        if (
            resultTime < block.timestamp + LOCK_BEFORE + MIN_ENTRY_WINDOW
                || resultTime > block.timestamp + MAX_HORIZON
        ) revert BadWindow();
        if (++createdOnDay[msg.sender][block.timestamp / 1 days] > POOLS_PER_DAY) revert DailyLimit();

        id = ++poolCount;
        Pool storage p = _pools[id];
        p.creator = msg.sender;
        p.asset = asset;
        p.resultTime = resultTime;
        p.lockTime = resultTime - LOCK_BEFORE;
        p.entryAmount = uint128(entryAmount);
        _emitCreated(id, p);
    }

    function _emitCreated(uint256 id, Pool storage p) private {
        emit PoolCreated(id, p.creator, p.asset, p.entryAmount, p.lockTime, p.resultTime);
    }

    // ---------------------------------------------------------------- entering

    /// @notice Enter with a sealed guess. The commitment is
    ///         keccak256(abi.encode(guess, salt, msg.sender, poolId)).
    ///         Pay exactly the pool's entry amount. Buy more entries for more guesses.
    function enter(uint256 id, bytes32 commitment) external payable whenNotPaused returns (uint256 entryId) {
        Pool storage p = _get(id);
        if (p.voided || block.timestamp >= p.lockTime) revert EntriesClosed();
        if (p.entryCount >= MAX_ENTRIES) revert PoolFull();
        if (msg.value != p.entryAmount) revert WrongAmount();

        entryId = ++p.entryCount;
        Entry storage e = _entries[id][entryId];
        e.entrant = msg.sender;
        e.commitment = commitment;
        if (firstEntry[id][msg.sender] == 0) firstEntry[id][msg.sender] = uint32(entryId);
        emit Entered(id, entryId, msg.sender, commitment);
    }

    /// @notice Reveal a guess. Anyone holding the guess and salt may do it, so
    ///         the app can reveal for everyone. Must happen before the result
    ///         time, so nobody can wait for the result before deciding.
    function reveal(uint256 id, uint256 entryId, uint256 guess, bytes32 salt) external {
        Pool storage p = _get(id);
        if (p.voided || block.timestamp < p.lockTime || block.timestamp >= p.resultTime) revert RevealClosed();
        Entry storage e = _entries[id][entryId];
        if (e.entrant == address(0)) revert BadReveal();
        if (e.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(guess, salt, e.entrant, id)) != e.commitment) revert BadReveal();

        e.revealed = true;
        e.guess = guess;
        p.revealedCount += 1;
        emit Revealed(id, entryId, e.entrant, guess);
    }

    // ----------------------------------------------------------------- pricing

    /// @notice Settle straight from the Chainlink feed. No trusted poster needed.
    ///         Open to anyone in the 10 minutes after the result time.
    function settleFromFeed(uint256 id) external {
        Pool storage p = _get(id);
        address feed = assetFeed[p.asset];
        if (feed == address(0)) revert NoFeed();
        if (block.timestamp < p.resultTime) revert NotYet();
        if (block.timestamp > uint256(p.resultTime) + FEED_WINDOW) revert TooLate();

        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (block.timestamp - updatedAt > assetMaxAge[p.asset]) revert BadPrice();
        _setPrice(id, p, uint256(answer), uint64(updatedAt));
    }

    /// @notice The settler posts a price read from the feed at the result time.
    function reportPrice(uint256 id, uint256 price, uint64 priceTimestamp) external {
        if (msg.sender != settler) revert NotAuthorized();
        _reportPrice(id, price, priceTimestamp);
    }

    function _handleReport(bytes calldata report) internal override {
        (uint256 id, uint256 price, uint64 priceTimestamp) = abi.decode(report, (uint256, uint256, uint64));
        _reportPrice(id, price, priceTimestamp);
    }

    function _reportPrice(uint256 id, uint256 price, uint64 priceTimestamp) internal {
        Pool storage p = _get(id);
        if (block.timestamp < p.resultTime) revert NotYet();
        if (price == 0) revert BadPrice();
        // The price must be recent as of the result time and not from the future.
        if (priceTimestamp > block.timestamp) revert BadPrice();
        if (uint256(priceTimestamp) + MAX_STALENESS < p.resultTime) revert BadPrice();
        _setPrice(id, p, price, priceTimestamp);
    }

    function _setPrice(uint256 id, Pool storage p, uint256 price, uint64 priceTimestamp) internal {
        if (p.voided) revert Refunding();
        if (p.priced) revert AlreadyPriced();
        if (_refundAll(p)) revert Refunding();
        p.priced = true;
        p.price = price;
        p.pricedAt = uint64(block.timestamp);
        emit PriceReported(id, price, priceTimestamp);
    }

    // ----------------------------------------------------------------- ranking

    /// @notice Submit entries ordered from closest to furthest, in as many calls
    ///         as needed. The contract checks the order itself, so a wrong list
    ///         reverts. Ties go to the lower entry number.
    ///         Restricted to the settler or owner: the order check cannot tell a
    ///         skipped entry from a late one, so an open caller could jam a pool
    ///         by skipping someone. A jammed pool is refunded after RANK_WINDOW.
    function submitRanking(uint256 id, uint32[] calldata entryIds) external {
        if (msg.sender != settler && msg.sender != owner) revert NotAuthorized();
        if (entryIds.length > MAX_BATCH) revert BatchTooLarge();
        Pool storage p = _get(id);
        if (!p.priced) revert NotPriced();
        if (_refundAll(p)) revert Refunding();

        for (uint256 i = 0; i < entryIds.length; i++) {
            _rankOne(id, p, entryIds[i]);
        }
        emit RankSubmitted(id, p.rankedCount, p.revealedCount);
    }

    function _rankOne(uint256 id, Pool storage p, uint32 eid) private {
        Entry storage e = _entries[id][eid];
        if (!e.revealed || e.ranked) revert BadRanking();
        uint256 d = e.guess >= p.price ? e.guess - p.price : p.price - e.guess;
        if (p.rankedCount > 0 && (d < p.lastDistance || (d == p.lastDistance && eid <= p.lastRankedId))) {
            revert BadRanking();
        }
        e.ranked = true;
        e.rank = p.rankedCount;
        p.rankedCount += 1;
        p.lastDistance = d;
        p.lastRankedId = eid;
    }

    // -------------------------------------------------------------- reputation

    /// @notice Score entries once the ranking is complete. Only a user's first
    ///         entry in a pool counts, so buying more entries cannot buy reputation.
    function scoreEntries(uint256 id, uint32[] calldata entryIds) external {
        if (entryIds.length > MAX_BATCH) revert BatchTooLarge();
        Pool storage p = _get(id);
        if (!_complete(p) || _refundAll(p)) revert NotSettled();
        for (uint256 i = 0; i < entryIds.length; i++) {
            _scoreEntry(id, p, entryIds[i]);
        }
    }

    function _scoreEntry(uint256 id, Pool storage p, uint256 entryId) internal returns (bool applied) {
        Entry storage e = _entries[id][entryId];
        if (!e.revealed || e.scored || firstEntry[id][e.entrant] != entryId) return false;
        e.scored = true;

        int256 n = int256(uint256(p.revealedCount));
        int256 delta = (K * (n - 1 - 2 * int256(uint256(e.rank)))) / (n - 1);
        bool won = e.rank < _winners(p.revealedCount);
        reputation.record(e.entrant, CRYPTO, delta, won);
        emit EntryScored(id, entryId, e.entrant, delta, won);
        return true;
    }

    // ------------------------------------------------------------------ claims

    /// @notice Collect a payout or refund for one of your entries.
    function claim(uint256 id, uint256 entryId) external nonReentrant {
        Pool storage p = _get(id);
        Entry storage e = _entries[id][entryId];
        if (e.entrant != msg.sender) revert NotEntrant();

        bool scoredNow = !_refundAll(p) && _complete(p) && _scoreEntry(id, p, entryId);
        uint256 amount = claimable(id, entryId);
        if (amount == 0) {
            if (!scoredNow) revert NothingToClaim();
            return;
        }
        e.claimed = true;
        _send(msg.sender, amount);
        emit Claimed(id, entryId, msg.sender, amount);
    }

    /// @notice What `claim` would pay for this entry now.
    function claimable(uint256 id, uint256 entryId) public view returns (uint256) {
        Pool storage p = _pools[id];
        Entry storage e = _entries[id][entryId];
        if (e.entrant == address(0) || e.claimed) return 0;

        if (_refundAll(p)) return p.entryAmount;
        // Never revealed: refunded once the reveal window has closed.
        if (!e.revealed) return block.timestamp >= p.resultTime ? p.entryAmount : 0;
        if (!_complete(p)) return 0;

        uint256 w = _winners(p.revealedCount);
        if (e.rank >= w) return 0;
        uint256 pot = uint256(p.revealedCount) * p.entryAmount;
        uint256 totalWeight = (w * (w + 1)) / 2;
        return (pot * (w - e.rank)) / totalWeight;
    }

    // ------------------------------------------------------------------- admin

    /// @notice Owner escape hatch: refund a pool that cannot be settled.
    function voidPool(uint256 id) external onlyOwner {
        Pool storage p = _get(id);
        if (p.voided || _complete(p)) revert NotSettled();
        p.voided = true;
        emit PoolVoided(id);
    }

    // ------------------------------------------------------------------- views

    /// @notice True when everyone gets their entry back.
    function refundAll(uint256 id) external view returns (bool) {
        return _refundAll(_pools[id]);
    }

    function winnerCount(uint256 id) external view returns (uint256) {
        return _winners(_pools[id].revealedCount);
    }

    // ---------------------------------------------------------------- internals

    function _get(uint256 id) internal view returns (Pool storage p) {
        p = _pools[id];
        if (p.creator == address(0)) revert NoSuchPool();
    }

    function _complete(Pool storage p) internal view returns (bool) {
        return p.priced && p.rankedCount == p.revealedCount;
    }

    /// Closest 30% of revealed guesses, at least one.
    function _winners(uint32 revealed) internal pure returns (uint256) {
        uint256 w = (uint256(revealed) * WINNER_BPS) / BPS;
        return w == 0 ? 1 : w;
    }

    function _refundAll(Pool storage p) internal view returns (bool) {
        if (p.voided) return true;
        if (block.timestamp >= p.resultTime && p.revealedCount < MIN_REVEALED) return true;
        if (!p.priced && block.timestamp > uint256(p.resultTime) + REPORT_WINDOW) return true;
        if (p.priced && p.rankedCount < p.revealedCount && block.timestamp > uint256(p.pricedAt) + RANK_WINDOW) {
            return true;
        }
        return false;
    }
}
