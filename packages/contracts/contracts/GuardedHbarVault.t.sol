// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import './GuardedHbarVault.sol';

interface Vm { function deal(address who, uint256 newBalance) external; }

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
        vault = new GuardedHbarVault(address(this), address(agent), 1 ether, 2 ether, bytes32(uint256(1)));
        vm.deal(address(vault), 3 ether);
    }

    function testCapsAllowlistPauseAndRevocation() public {
        bytes memory spend = abi.encodeCall(vault.spend, (payable(address(recipient)), 1 ether));
        require(!agent.callVault(vault, spend), 'recipient denied by default');
        vault.setRecipient(address(recipient), true);
        require(!outsider.callVault(vault, spend), 'non-agent denied');
        require(!agent.callVault(vault, abi.encodeCall(vault.spend, (payable(address(recipient)), 1 ether + 1))), 'per-tx cap');
        require(agent.callVault(vault, spend), 'first spend');
        require(agent.callVault(vault, spend), 'second spend');
        require(!agent.callVault(vault, spend), 'daily cap');
        require(address(recipient).balance == 2 ether, 'recipient received HBAR');
        vault.setPaused(true);
        require(!agent.callVault(vault, spend), 'paused');
        vault.setPaused(false);
        vault.setAgent(address(0));
        require(!agent.callVault(vault, spend), 'revoked agent');
    }

    function testGuardianOnlyConfigurationAndAgreementHash() public {
        require(!outsider.callVault(vault, abi.encodeCall(vault.setPaused, (true))), 'outsider pause');
        require(!outsider.callVault(vault, abi.encodeCall(vault.setPolicy, (2 ether, 3 ether, bytes32(uint256(2))))), 'outsider policy');
        vault.setPolicy(2 ether, 3 ether, bytes32(uint256(2)));
        require(vault.agreementHash() == bytes32(uint256(2)), 'hash anchored');
        require(vault.maxPerTx() == 2 ether && vault.maxPerDay() == 3 ether, 'caps changed');
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
