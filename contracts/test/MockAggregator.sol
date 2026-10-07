// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for a Chainlink price feed. Never deployed to mainnet.
contract MockAggregator {
    uint8 public decimals = 8;
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
