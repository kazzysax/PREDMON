// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver} from "./interfaces/IReceiver.sol";

/// @notice Shared admin plumbing for Calls and Pools: owner, pause, reentrancy
///         guard, the two ways results can arrive (a settler wallet or the
///         Chainlink forwarder), and the receiver hook Chainlink calls.
///
/// Pausing stops new activity only. Claims, refunds, proposals, finalisation
/// and scoring keep working, so a pause can never trap anyone's money.
abstract contract Base is IReceiver {
    address public owner;
    address public pendingOwner;
    /// Server wallet that may post results. Fallback if the forwarder is unavailable.
    address public settler;
    /// Chainlink KeystoneForwarder allowed to deliver reports through onReport.
    address public forwarder;
    /// If set, a report's metadata must name this workflow owner. Without it,
    /// any workflow signed by the DON could write to us through the forwarder.
    address public workflowOwner;
    bool public paused;

    uint256 private _lock = 1;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event PausedSet(bool paused);
    event SettlerSet(address indexed settler);
    event ForwarderSet(address indexed forwarder, address indexed workflowOwner);

    error NotOwner();
    error NotAuthorized();
    error IsPaused();
    error Reentrancy();
    error TransferFailed();
    error BadMetadata();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setSettler(address value) external onlyOwner {
        settler = value;
        emit SettlerSet(value);
    }

    function setForwarder(address forwarder_, address workflowOwner_) external onlyOwner {
        forwarder = forwarder_;
        workflowOwner = workflowOwner_;
        emit ForwarderSet(forwarder_, workflowOwner_);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (forwarder == address(0) || msg.sender != forwarder) revert NotAuthorized();
        if (workflowOwner != address(0)) {
            // Metadata layout: workflowId (32) | workflowName (10) | workflowOwner (20) | reportName (2)
            if (metadata.length < 62) revert BadMetadata();
            if (address(bytes20(metadata[42:62])) != workflowOwner) revert NotAuthorized();
        }
        _handleReport(report);
    }

    function _handleReport(bytes calldata report) internal virtual;

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IReceiver).interfaceId || id == 0x01ffc9a7;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
