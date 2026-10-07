// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Reputation} from "./Reputation.sol";

/// @title Calls — yes/no posts with two books: opinion and money.
/// @notice A free vote feeds the crowd bar and reputation. An optional MON
///         stake feeds a parimutuel pool. Money never moves reputation and
///         reputation never moves payouts.
///
/// Lifecycle
///   Open      votes and stakes accepted until `locksAt` (last 10% of life locked)
///   Proposed  after `closesAt` the settler or forwarder names an outcome
///   Finalized anyone, once the 2 hour dispute hold has passed
///   Void      refunds everyone, moves no reputation
///
/// Units: bps = 1/10_000. Weights are in bps (10_000 = a fresh voter at lock).
contract Calls is Base {
    // ---------------------------------------------------------------- types

    enum State { Open, Proposed, Finalized, Void }

    uint8 internal constant YES = 1;
    uint8 internal constant NO = 2;
    uint8 internal constant VOID = 3;

    struct Market {
        address creator;
        uint8 category;
        State state;
        uint8 outcome;
        uint64 opensAt;
        uint64 locksAt;
        uint64 closesAt;
        uint64 proposedAt;
        bytes32 termsHash;
        uint128 yesWeight;
        uint128 noWeight;
        uint128 yesPool;
        uint128 noPool;
        uint32 voteCount;
    }

    struct Position {
        uint8 side;
        bool scored;
        bool claimed;
        uint128 stake;
    }

    // ------------------------------------------------------------ constants

    uint256 internal constant BPS = 10_000;
    /// Votes and stakes lock once 90% of a market's life has passed.
    uint256 public constant LOCK_BPS = 9_000;
    /// Dispute hold between a proposed outcome and finalisation.
    uint64 public constant HOLD = 2 hours;
    /// A market nobody settled can be voided by anyone after this long.
    uint64 public constant STALE_AFTER = 7 days;
    uint64 public constant MIN_LIFE = 5 minutes;
    uint64 public constant MAX_LIFE = 7 days;
    /// Reputation at stake per call, x100. Win pays K*(1-s), loss costs K*s.
    uint256 public constant K = 1_000;
    /// Author's cut of the losing pool.
    uint256 public constant AUTHOR_FEE_BPS = 200;
    uint256 public constant MAX_SCORE_BATCH = 100;

    bytes32 private constant VOTE_TYPEHASH =
        keccak256("Vote(uint256 marketId,bool yes,address voter,uint256 deadline)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    // -------------------------------------------------------------- storage

    Reputation public immutable reputation;
    /// Opens markets after the offchain gate has frozen their terms.
    address public gate;
    /// Most MON one user may stake on one market.
    uint256 public maxStake;

    uint256 public marketCount;
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(address => uint256) public authorFees;

    // --------------------------------------------------------------- events

    event MarketCreated(
        uint256 indexed id, address indexed creator, uint8 category, bytes32 termsHash, uint64 locksAt, uint64 closesAt
    );
    event Voted(uint256 indexed id, address indexed voter, bool yes, uint256 weightBps);
    event Staked(uint256 indexed id, address indexed voter, bool yes, uint256 amount);
    event OutcomeProposed(uint256 indexed id, uint8 outcome, uint64 finalizableAt);
    event OutcomeCorrected(uint256 indexed id, uint8 outcome, uint64 finalizableAt);
    event Finalized(uint256 indexed id, uint8 outcome, uint256 yesWeight, uint256 noWeight);
    event Voided(uint256 indexed id);
    event Scored(uint256 indexed id, address indexed voter, bool won, int256 repDelta);
    event Claimed(uint256 indexed id, address indexed voter, uint256 amount);
    event AuthorFeesWithdrawn(address indexed author, uint256 amount);
    event GateSet(address indexed gate);
    event MaxStakeSet(uint256 maxStake);

    // --------------------------------------------------------------- errors

    error BadWindow();
    error BadCategory();
    error NoSuchMarket();
    error VotingClosed();
    error AlreadyVoted();
    error WrongSide();
    error ZeroStake();
    error OverStakeCap();
    error BadState();
    error MarketStillOpen();
    error HoldNotOver();
    error BadOutcome();
    error NotStale();
    error NothingToClaim();
    error BadSignature();
    error Expired();
    error BatchTooLarge();

    // ---------------------------------------------------------------- setup

    constructor(Reputation reputation_, address gate_, uint256 maxStake_) {
        reputation = reputation_;
        gate = gate_;
        maxStake = maxStake_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PredMon Calls"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Full market record (a public getter for a struct this wide cannot compile).
    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function setGate(address value) external onlyOwner {
        gate = value;
        emit GateSet(value);
    }

    /// @notice Raise or lower the per-user stake cap. Start low, raise after the dry run.
    function setMaxStake(uint256 value) external onlyOwner {
        if (value > type(uint128).max) revert BadWindow();
        maxStake = value;
        emit MaxStakeSet(value);
    }

    // -------------------------------------------------------------- markets

    /// @notice Open a market for a post whose terms the gate has frozen.
    function createMarket(address creator, uint8 category, bytes32 termsHash, uint64 closesAt)
        external
        whenNotPaused
        returns (uint256 id)
    {
        if (msg.sender != gate) revert NotAuthorized();
        if (category >= reputation.CATEGORIES()) revert BadCategory();
        uint64 nowTs = uint64(block.timestamp);
        if (closesAt < nowTs + MIN_LIFE || closesAt > nowTs + MAX_LIFE) revert BadWindow();

        id = ++marketCount;
        Market storage m = _markets[id];
        m.creator = creator;
        m.category = category;
        m.opensAt = nowTs;
        m.closesAt = closesAt;
        m.locksAt = nowTs + uint64((uint256(closesAt - nowTs) * LOCK_BPS) / BPS);
        m.termsHash = termsHash;
        emit MarketCreated(id, creator, category, termsHash, m.locksAt, closesAt);
    }

    // --------------------------------------------------------------- voting

    /// @notice Cast your one free vote.
    function vote(uint256 id, bool yes) external whenNotPaused {
        _vote(id, msg.sender, yes);
    }

    /// @notice The same vote, signed by the user and submitted by anyone, so the
    ///         app can pay the gas. One vote per market makes replay impossible;
    ///         the domain pins it to this chain and this contract.
    function voteBySig(uint256 id, bool yes, address voter, uint256 deadline, bytes calldata sig)
        external
        whenNotPaused
    {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(VOTE_TYPEHASH, id, yes, voter, deadline))
            )
        );
        if (_recover(digest, sig) != voter) revert BadSignature();
        _vote(id, voter, yes);
    }

    function _vote(uint256 id, address voter, bool yes) internal {
        Market storage m = _votable(id);
        Position storage p = positions[id][voter];
        if (p.side != 0) revert AlreadyVoted();

        uint256 w = _weight(voter, m);
        p.side = yes ? YES : NO;
        if (yes) m.yesWeight += uint128(w);
        else m.noWeight += uint128(w);
        m.voteCount += 1;
        emit Voted(id, voter, yes, w);
    }

    /// @notice Reputation factor (1x to 2x, per category) times time factor
    ///         (1.2x at open sliding to 1.0x at lock).
    function _weight(address voter, Market storage m) internal view returns (uint256) {
        uint256 repBps = reputation.voteWeightBps(voter, m.category);
        uint256 span = m.locksAt - m.opensAt;
        uint256 timeBps = BPS;
        if (span > 0 && block.timestamp < m.locksAt) {
            timeBps = BPS + (2_000 * (m.locksAt - block.timestamp)) / span;
        }
        return (repBps * timeBps) / BPS;
    }

    // -------------------------------------------------------------- staking

    /// @notice Back a side with MON. Staking casts your vote on that side if you
    ///         have not voted; you cannot vote one way and stake the other.
    function stake(uint256 id, bool yes) external payable whenNotPaused {
        if (msg.value == 0) revert ZeroStake();
        Market storage m = _votable(id);
        Position storage p = positions[id][msg.sender];
        uint8 side = yes ? YES : NO;

        if (p.side == 0) _vote(id, msg.sender, yes);
        else if (p.side != side) revert WrongSide();

        if (uint256(p.stake) + msg.value > maxStake) revert OverStakeCap();
        p.stake += uint128(msg.value);
        if (yes) m.yesPool += uint128(msg.value);
        else m.noPool += uint128(msg.value);
        emit Staked(id, msg.sender, yes, msg.value);
    }

    // ----------------------------------------------------------- settlement

    /// @notice The settler names an outcome after close. 1 = YES, 2 = NO, 3 = VOID.
    ///         VOID takes effect at once (it only refunds); YES and NO start the hold.
    function proposeOutcome(uint256 id, uint8 outcome) external {
        if (msg.sender != settler) revert NotAuthorized();
        _propose(id, outcome);
    }

    function _handleReport(bytes calldata report) internal override {
        (uint256 id, uint8 outcome) = abi.decode(report, (uint256, uint8));
        _propose(id, outcome);
    }

    function _propose(uint256 id, uint8 outcome) internal {
        Market storage m = _get(id);
        if (m.state != State.Open) revert BadState();
        if (block.timestamp < m.closesAt) revert MarketStillOpen();
        if (outcome == VOID) {
            _void(id, m);
            return;
        }
        if (outcome != YES && outcome != NO) revert BadOutcome();
        m.state = State.Proposed;
        m.outcome = outcome;
        m.proposedAt = uint64(block.timestamp);
        emit OutcomeProposed(id, outcome, m.proposedAt + HOLD);
    }

    /// @notice During the hold the owner may replace a wrong outcome. This
    ///         restarts the hold so everyone can see the correction.
    function correctOutcome(uint256 id, uint8 outcome) external onlyOwner {
        Market storage m = _get(id);
        if (m.state != State.Proposed) revert BadState();
        if (outcome != YES && outcome != NO) revert BadOutcome();
        m.outcome = outcome;
        m.proposedAt = uint64(block.timestamp);
        emit OutcomeCorrected(id, outcome, m.proposedAt + HOLD);
    }

    /// @notice Owner escape hatch: refund a market that cannot be settled.
    function voidMarket(uint256 id) external onlyOwner {
        Market storage m = _get(id);
        if (m.state != State.Open && m.state != State.Proposed) revert BadState();
        _void(id, m);
    }

    /// @notice If nobody settled a market for 7 days after close, anyone can refund it.
    function voidIfStale(uint256 id) external {
        Market storage m = _get(id);
        if (m.state != State.Open) revert BadState();
        if (block.timestamp < uint256(m.closesAt) + STALE_AFTER) revert NotStale();
        _void(id, m);
    }

    /// @notice Make the proposed outcome final once the hold has passed.
    function finalize(uint256 id) external {
        Market storage m = _get(id);
        if (m.state != State.Proposed) revert BadState();
        if (block.timestamp < uint256(m.proposedAt) + HOLD) revert HoldNotOver();

        // A market with votes on one side only was never a contest.
        if (m.yesWeight == 0 || m.noWeight == 0) {
            _void(id, m);
            return;
        }
        m.state = State.Finalized;
        if (m.yesPool > 0 && m.noPool > 0) {
            uint256 losing = m.outcome == YES ? m.noPool : m.yesPool;
            authorFees[m.creator] += (losing * AUTHOR_FEE_BPS) / BPS;
        }
        emit Finalized(id, m.outcome, m.yesWeight, m.noWeight);
    }

    function _void(uint256 id, Market storage m) internal {
        m.state = State.Void;
        emit Voided(id);
    }

    // ------------------------------------------------------------ reputation

    /// @notice Apply reputation for a finalized market. Open to anyone and safe to
    ///         repeat, so a keeper scores everybody and nobody dodges a loss by
    ///         never coming back.
    function score(uint256 id, address[] calldata voters) external {
        if (voters.length > MAX_SCORE_BATCH) revert BatchTooLarge();
        Market storage m = _get(id);
        if (m.state != State.Finalized) revert BadState();
        for (uint256 i = 0; i < voters.length; i++) {
            _score(id, m, voters[i]);
        }
    }

    /// @return applied true if this call scored the voter for the first time.
    function _score(uint256 id, Market storage m, address voter) internal returns (bool applied) {
        Position storage p = positions[id][voter];
        if (p.side == 0 || p.scored) return false;
        p.scored = true;

        bool won = p.side == m.outcome;
        uint256 total = uint256(m.yesWeight) + m.noWeight;
        uint256 sideWeight = p.side == YES ? m.yesWeight : m.noWeight;
        // s: how much of the crowd was on your side at close.
        uint256 s = (sideWeight * BPS) / total;
        int256 delta = won ? int256((K * (BPS - s)) / BPS) : -int256((K * s) / BPS);
        reputation.record(voter, m.category, delta, won);
        emit Scored(id, voter, won, delta);
        return true;
    }

    // ---------------------------------------------------------------- claims

    /// @notice Collect winnings or a refund. Also scores the caller.
    function claim(uint256 id) external nonReentrant {
        Market storage m = _get(id);
        bool scoredNow = m.state == State.Finalized && _score(id, m, msg.sender);

        uint256 amount = claimable(id, msg.sender);
        if (amount == 0) {
            // A free voter has nothing to collect, but being scored is still a result.
            if (!scoredNow) revert NothingToClaim();
            return;
        }
        positions[id][msg.sender].claimed = true;

        _send(msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice What `claim` would pay this user now.
    function claimable(uint256 id, address voter) public view returns (uint256) {
        Market storage m = _markets[id];
        Position storage p = positions[id][voter];
        if (m.state == State.Open || m.state == State.Proposed) return 0;
        if (p.claimed || p.stake == 0) return 0;

        // Void, or money on one side only: nothing to win, so everyone is refunded.
        if (m.state == State.Void || m.yesPool == 0 || m.noPool == 0) return p.stake;
        if (p.side != m.outcome) return 0;

        (uint256 winning, uint256 losing) =
            m.outcome == YES ? (uint256(m.yesPool), uint256(m.noPool)) : (uint256(m.noPool), uint256(m.yesPool));
        uint256 prize = losing - (losing * AUTHOR_FEE_BPS) / BPS;
        return uint256(p.stake) + (uint256(p.stake) * prize) / winning;
    }

    function withdrawAuthorFees() external nonReentrant {
        uint256 amount = authorFees[msg.sender];
        if (amount == 0) revert NothingToClaim();
        authorFees[msg.sender] = 0;
        _send(msg.sender, amount);
        emit AuthorFeesWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------- internals

    function _get(uint256 id) internal view returns (Market storage m) {
        m = _markets[id];
        if (m.creator == address(0)) revert NoSuchMarket();
    }

    function _votable(uint256 id) internal view returns (Market storage m) {
        m = _get(id);
        if (m.state != State.Open || block.timestamp >= m.locksAt) revert VotingClosed();
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // Reject malleable signatures.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
