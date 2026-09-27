// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Optional HBAR custody. Only funds deposited here are subject to these on-chain rules.
contract GuardedHbarVault {
    address public immutable guardian;
    address public agent;
    bool public paused;
    uint256 public maxPerTx;
    uint256 public maxPerDay;
    bytes32 public agreementHash;
    mapping(address => bool) public allowedRecipients;
    mapping(uint256 => uint256) public spentByUtcDay;
    bool private entered;

    error Unauthorized();
    error InvalidPolicy();
    error Paused();
    error RecipientDenied();
    error AmountDenied();
    error TransferFailed();
    error Reentrant();

    event Deposited(address indexed sender, uint256 amount);
    event Spent(address indexed recipient, uint256 amount, uint256 utcDay);
    event PolicyChanged(uint256 maxPerTx, uint256 maxPerDay, bytes32 agreementHash);
    event RecipientChanged(address indexed recipient, bool allowed);
    event PauseChanged(bool paused);
    event AgentChanged(address indexed agent);
    event Recovered(address indexed recipient, uint256 amount);

    constructor(address guardian_, address agent_, uint256 maxPerTx_, uint256 maxPerDay_, bytes32 agreementHash_) {
        if (guardian_ == address(0) || agent_ == address(0) || guardian_ == agent_ ||
            maxPerTx_ == 0 || maxPerDay_ < maxPerTx_ || agreementHash_ == bytes32(0)) revert InvalidPolicy();
        guardian = guardian_;
        agent = agent_;
        maxPerTx = maxPerTx_;
        maxPerDay = maxPerDay_;
        agreementHash = agreementHash_;
        emit PolicyChanged(maxPerTx_, maxPerDay_, agreementHash_);
    }

    modifier onlyGuardian() { if (msg.sender != guardian) revert Unauthorized(); _; }
    modifier onlyAgent() { if (msg.sender != agent) revert Unauthorized(); _; }

    receive() external payable { emit Deposited(msg.sender, msg.value); }

    function setPolicy(uint256 perTx, uint256 perDay, bytes32 hash) external onlyGuardian {
        if (perTx == 0 || perDay < perTx || hash == bytes32(0)) revert InvalidPolicy();
        maxPerTx = perTx;
        maxPerDay = perDay;
        agreementHash = hash;
        emit PolicyChanged(perTx, perDay, hash);
    }

    function setRecipient(address recipient, bool allowed) external onlyGuardian {
        if (recipient == address(0)) revert InvalidPolicy();
        allowedRecipients[recipient] = allowed;
        emit RecipientChanged(recipient, allowed);
    }

    function setPaused(bool value) external onlyGuardian {
        paused = value;
        emit PauseChanged(value);
    }

    /// @notice Set zero to revoke the agent without changing the guardian's control.
    function setAgent(address replacement) external onlyGuardian {
        if (replacement == guardian) revert InvalidPolicy();
        agent = replacement;
        emit AgentChanged(replacement);
    }

    function spend(address payable recipient, uint256 amount) external onlyAgent {
        if (entered) revert Reentrant();
        if (paused) revert Paused();
        if (!allowedRecipients[recipient]) revert RecipientDenied();
        if (amount == 0 || amount > maxPerTx || amount > address(this).balance) revert AmountDenied();
        uint256 day = block.timestamp / 1 days;
        uint256 used = spentByUtcDay[day];
        if (used > maxPerDay - amount) revert AmountDenied();
        spentByUtcDay[day] = used + amount;
        entered = true;
        (bool ok,) = recipient.call{value: amount}("");
        entered = false;
        if (!ok) revert TransferFailed();
        emit Spent(recipient, amount, day);
    }

    /// @notice Emergency recovery after pausing the agent. Guardian action is not subject to agent caps.
    function recover(address payable recipient) external onlyGuardian {
        if (!paused) revert InvalidPolicy();
        if (recipient == address(0)) revert InvalidPolicy();
        if (entered) revert Reentrant();
        uint256 amount = address(this).balance;
        entered = true;
        (bool ok,) = recipient.call{value: amount}("");
        entered = false;
        if (!ok) revert TransferFailed();
        emit Recovered(recipient, amount);
    }
}
