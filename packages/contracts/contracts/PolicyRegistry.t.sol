// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import './PolicyRegistry.sol';
contract Outsider {
    function attempt(PolicyRegistry policy, bytes calldata action) external returns (bool) {
        (bool ok,) = address(policy).call(action);
        return ok;
    }
}
contract PolicyRegistryTest {
    function testDenyByDefaultAndGuardianControls() public {
        PolicyRegistry p = new PolicyRegistry(address(this), '0.0.123', 100, 500);
        (bool ok,) = p.preview('0.0.429274', 10); require(!ok, 'empty allowlist must deny');
        string[] memory tokens = new string[](1); tokens[0] = '0.0.429274';
        p.setAllowedTokens(tokens, true);
        (ok,) = p.preview(tokens[0], 100); require(ok, 'cap boundary allowed');
        (ok,) = p.preview(tokens[0], 101); require(!ok, 'over cap denied');
        p.pause(); (ok,) = p.preview(tokens[0], 1); require(!ok, 'paused denied');
        p.unpause(); p.setCaps(0, 0); (ok,) = p.preview(tokens[0], 1); require(!ok, 'zero cap denied');
        Outsider outsider = new Outsider();
        require(!outsider.attempt(p, abi.encodeCall(p.pause, ())), 'outsider must not pause');
        require(!outsider.attempt(p, abi.encodeCall(p.unpause, ())), 'outsider must not unpause');
        require(!outsider.attempt(p, abi.encodeCall(p.setCaps, (1000, 5000))), 'outsider must not raise caps');
        require(!outsider.attempt(p, abi.encodeCall(p.setAllowedTokens, (tokens, true))), 'outsider must not allow tokens');
    }
}
