// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Read-only view of the deployed Calls contract.
interface ICalls {
    struct Market {
        address creator;
        uint8 category;
        uint8 state; // 0 Open, 1 Proposed, 2 Finalized, 3 Void
        uint8 outcome; // 1 YES, 2 NO
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

    function getMarket(uint256 id) external view returns (Market memory);
    function positions(uint256 id, address who) external view returns (uint8 side, bool scored, bool claimed, uint128 stake);
    function HOLD() external view returns (uint64);
}

/// @title Prizes
/// @notice Anyone can put MON on a post as a prize for the winning side. Once the post
///         settles, every voter who was on the winning side can register, and after the
///         registration window the prize is split equally between them. If the post is
///         voided, or nobody on the winning side registers, sponsors take their MON back.
///         The Calls contract is only read, never changed.
contract Prizes {
    ICalls public immutable calls;

    /// Winners have this long after the hold ends to register.
    uint64 public constant REGISTER_WINDOW = 3 days;

    struct Prize {
        uint128 total;
        uint32 winners;
    }

    mapping(uint256 => Prize) public prizes;
    mapping(uint256 => mapping(address => uint128)) public sponsored;
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public paid;
    uint256 private _lock = 1;

    event PrizeAdded(uint256 indexed id, address indexed sponsor, uint256 amount, uint256 total);
    event Registered(uint256 indexed id, address indexed winner);
    event PrizePaid(uint256 indexed id, address indexed winner, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sponsor, uint256 amount);

    error PostNotOpen();
    error ZeroAmount();
    error NotSettled();
    error NotAWinner();
    error AlreadyRegistered();
    error WindowClosed();
    error WindowOpen();
    error NotRegistered();
    error AlreadyPaid();
    error NothingToRefund();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ICalls calls_) {
        calls = calls_;
    }

    /// @notice Add MON to a post's prize. Only while voting is still open, so nobody
    ///         can top up a prize after the winners are known.
    function addPrize(uint256 id) external payable {
        if (msg.value == 0) revert ZeroAmount();
        ICalls.Market memory m = calls.getMarket(id);
        if (m.creator == address(0) || m.state != 0 || block.timestamp >= m.locksAt) revert PostNotOpen();
        prizes[id].total += uint128(msg.value);
        sponsored[id][msg.sender] += uint128(msg.value);
        emit PrizeAdded(id, msg.sender, msg.value, prizes[id].total);
    }

    function registrationEnds(uint256 id) public view returns (uint256) {
        ICalls.Market memory m = calls.getMarket(id);
        return uint256(m.proposedAt) + calls.HOLD() + REGISTER_WINDOW;
    }

    /// @notice Winners put their name down. Votes with or without a stake count.
    function register(uint256 id) external {
        ICalls.Market memory m = calls.getMarket(id);
        if (m.state != 2) revert NotSettled();
        if (block.timestamp >= registrationEnds(id)) revert WindowClosed();
        (uint8 side,,,) = calls.positions(id, msg.sender);
        if (side == 0 || side != m.outcome) revert NotAWinner();
        if (registered[id][msg.sender]) revert AlreadyRegistered();
        registered[id][msg.sender] = true;
        prizes[id].winners += 1;
        emit Registered(id, msg.sender);
    }

    function shareOf(uint256 id) public view returns (uint256) {
        Prize memory p = prizes[id];
        return p.winners == 0 ? 0 : uint256(p.total) / p.winners;
    }

    /// @notice After the window closes, each registered winner collects an equal share.
    function collect(uint256 id) external nonReentrant {
        ICalls.Market memory m = calls.getMarket(id);
        if (m.state != 2) revert NotSettled();
        if (block.timestamp < registrationEnds(id)) revert WindowOpen();
        if (!registered[id][msg.sender]) revert NotRegistered();
        if (paid[id][msg.sender]) revert AlreadyPaid();
        paid[id][msg.sender] = true;
        uint256 amount = shareOf(id);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PrizePaid(id, msg.sender, amount);
    }

    /// @notice Sponsors take their MON back if the post was voided, or if the window
    ///         closed with nobody on the winning side registered.
    function refund(uint256 id) external nonReentrant {
        ICalls.Market memory m = calls.getMarket(id);
        bool voided = m.state == 3;
        bool unclaimed = m.state == 2 && block.timestamp >= registrationEnds(id) && prizes[id].winners == 0;
        if (!voided && !unclaimed) revert NotSettled();
        uint256 amount = sponsored[id][msg.sender];
        if (amount == 0) revert NothingToRefund();
        sponsored[id][msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(id, msg.sender, amount);
    }
}
