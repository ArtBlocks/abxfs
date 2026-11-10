// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployPresentation} from "../script/DeployPresentation.s.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {DWAbxFactory, DWDirectoryStore, DWFileStore, DWRenderer, DWSeed, DWPresentation} from "./DeployWrong.t.sol";

/// @dev `run()`, the entry point `forge script` calls, reading the REAL environment variable names. Every other deploy
///      test goes through `runWith` because `vm.setEnv` is process-global and forge runs tests in parallel; this is the
///      one test that sets these names, and no other test reads them, so it cannot race (AGENTS.md records the
///      exception). The gateway base is not the table's, so a `run()` that ignored or defaulted
///      `ABXFS_GATEWAY_BASE` is caught, and each flag is proven false when unset: the escape hatches are never defaults.
contract DeployRunEnvTest is Test {
    string constant GW = "https://gateway.example";

    function test_runReadsEachVariableIntoItsInputAndEachFlagIntoItsGate() public {
        assertFalse(vm.envExists("ABXFS_ALLOW_UNLISTED_CHAIN"), "unset ABXFS_ALLOW_UNLISTED_CHAIN to run this test");
        assertFalse(vm.envExists("ABXFS_ALLOW_UNLISTED_GATEWAY"), "unset ABXFS_ALLOW_UNLISTED_GATEWAY to run this test");
        DeployProjects d = new DeployProjects();
        DeployProjects.Inputs memory i = DeployProjects.Inputs(address(new DWAbxFactory()), address(new DWRenderer()), address(new DWSeed()), address(new DWDirectoryStore()), address(new DWFileStore()), address(0), GW);
        i.presentation = address(new DWPresentation(i.directoryStore, i.fileStore, GW));
        vm.setEnv("ABX_SERIES_CODE_FACTORY", vm.toString(i.abx));
        vm.setEnv("ABX_METADATA_RENDERER", vm.toString(i.renderer));
        vm.setEnv("ABX_SEED_SOURCE", vm.toString(i.seed));
        vm.setEnv("ABXFS_DIRECTORY_STORE", vm.toString(i.directoryStore));
        vm.setEnv("ABXFS_FILE_STORE", vm.toString(i.fileStore));
        vm.setEnv("ABXFS_PRESENTATION", vm.toString(i.presentation));
        vm.chainId(999);
        // Unset, the gateway base is an error, never a default.
        assertFalse(vm.envExists("ABXFS_GATEWAY_BASE"), "unset ABXFS_GATEWAY_BASE to run this test");
        vm.expectRevert(bytes("vm.envString: environment variable \"ABXFS_GATEWAY_BASE\" not found"));
        d.run();
        vm.setEnv("ABXFS_GATEWAY_BASE", GW);

        // Unset, each flag is false: the escape hatches are never defaults.
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, 999));
        d.run();
        vm.setEnv("ABXFS_ALLOW_UNLISTED_CHAIN", "true");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, GW));
        d.run();

        // The chain flag maps to the chain gate, the gateway flag to the gateway gate.
        vm.setEnv("ABXFS_ALLOW_UNLISTED_CHAIN", "false");
        vm.setEnv("ABXFS_ALLOW_UNLISTED_GATEWAY", "true");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, 999));
        d.run();
        vm.setEnv("ABXFS_ALLOW_UNLISTED_CHAIN", "true");
        vm.setEnv("ABXFS_ALLOW_UNLISTED_GATEWAY", "false");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, GW));
        d.run();

        // With both, it deploys exactly what `runWith` would for the same inputs, and a re-run reuses it.
        vm.setEnv("ABXFS_ALLOW_UNLISTED_GATEWAY", "true");
        DeployProjects.Addresses memory want = d.predict(i);
        (address factory, address lens) = d.run();
        assertEq(factory, want.factory, "factory from the env inputs");
        assertEq(lens, want.lens, "lens from the env inputs");
        (address factory2, address lens2) = d.run();
        assertEq(factory2, factory);
        assertEq(lens2, lens);

        // The companion entry point reads these variables in this same env-owning test, avoiding races.
        vm.chainId(31337);
        DWPresentation fixture = DWPresentation(i.presentation);
        vm.setEnv("ABXFS_CONTENT_READER", vm.toString(fixture.reader()));
        vm.setEnv("ABXFS_IPFS_CID_RESOLVER", vm.toString(fixture.ipfsResolver()));
        DeployPresentation presentationScript = new DeployPresentation();
        address at = presentationScript.run();
        assertEq(at, presentationScript.predict(fixture.reader(), fixture.ipfsResolver(), GW));
        assertEq(address(ProjectPresentation(at).reader()), fixture.reader());
        assertEq(address(ProjectPresentation(at).ipfsResolver()), fixture.ipfsResolver());
        assertEq(ProjectPresentation(at).defaultChainBase(), GW);
    }
}
