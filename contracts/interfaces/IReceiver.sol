// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink CRE delivers signed reports to contracts that implement this.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
