// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One reputation record shared by Calls and Pools, kept per user per
///         category so a strong sports record does not boost crypto votes.
///
/// Scores are stored x100: 250 reads as +2.50 in the app.
/// Categories: 0 Crypto, 1 Sports, 2 Music, 3 Politics, 4 Other.
/// Other Monad apps can read `score` and `voteWeightBps` freely.
contract Reputation {
    uint256 internal constant BPS = 10_000;
    uint8 public constant CATEGORIES = 5;

    address public owner;
    mapping(address => bool) public writers;

    mapping(address => mapping(uint8 => int256)) public score;
    mapping(address => mapping(uint8 => uint32)) public callsScored;
    mapping(address => mapping(uint8 => uint32)) public callsWon;

    event RepChanged(address indexed user, uint8 indexed category, int256 delta, int256 newScore, bool won);
    event WriterSet(address indexed writer, bool allowed);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error NotWriter();
    error BadCategory();

    constructor() {
        owner = msg.sender;
    }

    function setWriter(address writer, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function setOwner(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    /// @notice Only Calls and Pools may write, and only through settled markets.
    function record(address user, uint8 category, int256 delta, bool won) external {
        if (!writers[msg.sender]) revert NotWriter();
        if (category >= CATEGORIES) revert BadCategory();
        int256 next = score[user][category] + delta;
        score[user][category] = next;
        callsScored[user][category] += 1;
        if (won) callsWon[user][category] += 1;
        emit RepChanged(user, category, delta, next, won);
    }

    /// @notice Vote weight in bps from reputation: 1x (10_000) up to 2x (20_000).
    ///         Floored at 1x so a bad record never mutes anyone.
    function voteWeightBps(address user, uint8 category) external view returns (uint256) {
        int256 r = score[user][category];
        if (r <= 0) return BPS;
        if (uint256(r) >= BPS) return 2 * BPS;
        return BPS + uint256(r);
    }
}
