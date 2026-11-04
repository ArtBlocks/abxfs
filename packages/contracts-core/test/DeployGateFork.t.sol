// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {DriftedDeploy} from "./Deploy.t.sol";

/// @dev `Deploy` with its local-chain test exposed.
contract GateHarness is Deploy {
    function isLocal() external returns (bool) {
        return _isLocal();
    }

    function isLocalAsking(string memory method) external returns (bool) {
        return _isLocalAsking(method);
    }

    function answersLocal(bytes memory r) external pure returns (bool) {
        return _answersLocal(r);
    }
}

/// `--chain-id`, `FOUNDRY_CHAIN_ID` or a `chain_id` setting make `block.chainid` read 31337 while a broadcast still goes
/// to, and is signed for, the RPC's real chain. The gate therefore asks the RPC itself. Against any RPC that is not a
/// 31337 chain (CI starts an anvil with `--chain-id 8453`; Base Sepolia works too, read only), with `block.chainid`
/// overridden to 31337, a drifted build is still refused. Takes `ABXFS_GATE_RPC_URL`, else `ABXFS_RPC_URL_84532`;
/// skipped without either.
contract DeployGateForkTest is Test {
    function setUp() public {
        string memory url = vm.envOr("ABXFS_GATE_RPC_URL", vm.envOr("ABXFS_RPC_URL_84532", string("")));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        vm.chainId(31_337);
    }

    function test_aChainIdOverrideDoesNotMakeARealChainLocal() public {
        assertEq(block.chainid, 31_337);
        assertFalse(new GateHarness().isLocal(), "the RPC answers its own chain id, not 31337");
    }

    function test_aFailedChainIdCallIsNotLocal() public {
        assertFalse(new GateHarness().isLocalAsking("abxfs_noSuchMethod"), "an RPC that does not answer is not local");
    }

    function test_aDriftedBuildIsRefusedOnARealChainWhateverBlockChainidSays() public {
        Deploy drifted = new DriftedDeploy(Deploy.Contract.FastLzSstore2Backend, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.UnexpectedAddress.selector,
                "FastLzSstore2Backend",
                drifted.predict().fastLzSstore2Backend,
                drifted.pinned().fastLzSstore2Backend
            )
        );
        drifted.run();
    }
}

/// The other side of the rule, against an RPC that IS a 31337 chain (CI starts a default anvil): it is local, and the
/// same node is not local when the call fails. Takes `ABXFS_LOCAL_RPC_URL`; skipped without it.
contract LocalChainForkTest is Test {
    function setUp() public {
        string memory url = vm.envOr("ABXFS_LOCAL_RPC_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
    }

    function test_an31337RpcIsLocalAndAFailedCallIsNot() public {
        assertEq(block.chainid, 31_337);
        GateHarness h = new GateHarness();
        assertTrue(h.isLocal(), "the RPC answers 31337");
        assertFalse(h.isLocalAsking("abxfs_noSuchMethod"), "the same node, when the call fails, is not local");
    }
}
