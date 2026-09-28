// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import './GuardedHbarVault.sol';

interface Vm { function deal(address who, uint256 newBalance) external; function warp(uint256 timestamp) external; }

contract VaultCaller {
    function callVault(GuardedHbarVault vault, bytes calldata action) external returns (bool) {
        (bool ok,) = address(vault).call(action);
        return ok;
    }
    receive() external payable {}
}

contract GuardedHbarVaultTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));
    VaultCaller private agent;
    VaultCaller private recipient;
    VaultCaller private outsider;
    GuardedHbarVault private vault;

    function setUp() public {
        agent = new VaultCaller();
        recipient = new VaultCaller();
        outsider = new VaultCaller();
        address[] memory recipients = new address[](1);
        recipients[0] = address(recipient);
        vault = new GuardedHbarVault(address(this), address(agent), 1 ether, 2 ether, bytes32(uint256(1)), recipients);
        vm.deal(address(vault), 3 ether);
    }

    function testCapsAllowlistPauseAndRevocation() public {
        bytes memory spend = abi.encodeCall(vault.spend, (payable(address(recipient)), 1 ether));
        require(!agent.callVault(vault, abi.encodeCall(vault.spend, (payable(address(outsider)), 1 ether))), 'unlisted recipient denied');
        require(!outsider.callVault(vault, spend), 'non-agent denied');
        require(!agent.callVault(vault, abi.encodeCall(vault.spend, (payable(address(recipient)), 1 ether + 1))), 'per-tx cap');
        require(agent.callVault(vault, spend), 'first spend');
        require(agent.callVault(vault, spend), 'second spend');
        require(!agent.callVault(vault, spend), 'daily cap');
        require(address(recipient).balance == 2 ether, 'recipient received HBAR');
        vm.warp(block.timestamp + 1 days);
        require(agent.callVault(vault, spend), 'new UTC day resets usage');
    }

    function testPauseAndRevocationWithAvailableBudget() public {
        bytes memory spend = abi.encodeCall(vault.spend, (payable(address(recipient)), 1 ether));
        vault.setPaused(true);
        require(!agent.callVault(vault, spend), 'paused');
        vault.setPaused(false);
        require(agent.callVault(vault, spend), 'unpause restores spend');
        vault.setAgent(address(0));
        require(!agent.callVault(vault, spend), 'revoked with budget remaining');
    }

    function testApprovedTermsCannotBeChanged() public {
        // Removed selectors must fail even for the guardian.
        (bool changed,) = address(vault).call(abi.encodeWithSignature('setRecipient(address,bool)', address(outsider), true));
        require(!changed && !vault.allowedRecipients(address(outsider)), 'recipient terms immutable');
        (changed,) = address(vault).call(abi.encodeWithSignature('setPolicy(uint256,uint256,bytes32)', 2 ether, 3 ether, bytes32(uint256(2))));
        require(!changed, 'caps and hash immutable');
        require(vault.agreementHash() == bytes32(uint256(1)) && vault.maxPerTx() == 1 ether, 'terms preserved');
        address[] memory recipients = vault.recipients();
        require(recipients.length == 1 && recipients[0] == address(recipient), 'full allowlist readable');
        require(!outsider.callVault(vault, abi.encodeCall(vault.setPaused, (true))), 'outsider pause');
    }

    function testGuardianCanRecoverOnlyAfterPause() public {
        require(!outsider.callVault(vault, abi.encodeCall(vault.recover, (payable(address(recipient))))), 'outsider recovery');
        (bool premature,) = address(vault).call(abi.encodeCall(vault.recover, (payable(address(recipient)))));
        require(!premature, 'must pause first');
        vault.setPaused(true);
        vault.recover(payable(address(recipient)));
        require(address(vault).balance == 0 && address(recipient).balance == 3 ether, 'recovered all funds');
    }
}
