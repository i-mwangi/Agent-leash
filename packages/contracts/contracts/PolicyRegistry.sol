// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Client policy configuration. Does not restrict native Hedera account transfers.
/// @dev Daily spend accounting belongs to the client; preview does not enforce maxPerDay.
contract PolicyRegistry {
    address public immutable guardian;
    string public agentAccount;
    bool public paused;
    uint256 public maxPerTx;
    uint256 public maxPerDay;
    mapping(string => bool) public allowedTokens;
    error Unauthorized();
    error InvalidGuardian();
    event PauseChanged(bool paused);
    event CapsChanged(uint256 perTx, uint256 perDay);
    event TokenPermissionChanged(string token, bool allowed);

    constructor(address guardian_, string memory account_, uint256 perTx_, uint256 perDay_) {
        if (guardian_ == address(0)) revert InvalidGuardian();
        guardian = guardian_; agentAccount = account_; maxPerTx = perTx_; maxPerDay = perDay_;
    }
    modifier onlyGuardian() { if (msg.sender != guardian) revert Unauthorized(); _; }
    function pause() external onlyGuardian { paused = true; emit PauseChanged(true); }
    function unpause() external onlyGuardian { paused = false; emit PauseChanged(false); }
    function setCaps(uint256 perTx, uint256 perDay) external onlyGuardian {
        maxPerTx = perTx; maxPerDay = perDay; emit CapsChanged(perTx, perDay);
    }
    function setAllowedTokens(string[] calldata tokens, bool allowed) external onlyGuardian {
        for (uint256 i; i < tokens.length; i++) { allowedTokens[tokens[i]] = allowed; emit TokenPermissionChanged(tokens[i], allowed); }
    }
    function preview(string calldata asset, uint256 amount) external view returns (bool, string memory) {
        if (paused) return (false, 'PAUSED');
        if (!allowedTokens[asset]) return (false, 'ASSET_NOT_ALLOWED');
        if (amount == 0) return (false, 'INVALID_AMOUNT');
        if (amount > maxPerTx) return (false, 'OVER_TX_CAP');
        return (true, 'OK');
    }
}
