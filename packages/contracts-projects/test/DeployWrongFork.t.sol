// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DWPresentation} from "./DeployWrong.t.sol";
import {Test} from "forge-std/Test.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./fork/ContentLayer.sol";

/// @dev The wrong-deployment scenarios from the re-audit (Audit2DeployFork), against the REAL Base Sepolia
///      addresses. Each of them passed `run()` before and must now revert in `preflight`. Nothing is
///      broadcast. Uses `preflight` directly rather than env vars: `vm.setEnv` is process-global and forge
///      runs test contracts in parallel, so env-driven tests would race with Audit2DeployFork.
contract DeployWrongForkTest is Test {
    address constant ABX_F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    // The ABX FS content layer's store pair: what the script's allow-table lists for every listed chain.
    address constant DIR = CONTENT_DIRECTORY_STORE;
    address constant FILES = CONTENT_FILE_STORE;
    string constant GATEWAY = "https://fs.abx.io";

    DeployProjects d;
    address presentationAddress;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        d = new DeployProjects();
        DWPresentation presentation = new DWPresentation(DIR, FILES, GATEWAY);
        presentationAddress = d.expected().presentation;
        address at = presentationAddress;
        vm.etch(at, address(presentation).code);
        DWPresentation(at).setDependencies(presentation.reader(), presentation.ipfsResolver());
    }

    function _good() internal view returns (DeployProjects.Inputs memory) {
        return DeployProjects.Inputs(ABX_F, ABX_RENDERER, ABX_SEED, DIR, FILES, presentationAddress, GATEWAY);
    }

    function test_happyPathOnRealSepoliaAddresses() public view {
        assertEq(block.chainid, 84532);
        d.preflight(_good(), false, false);
    }

    /// Regression of Audit2DeployFork "wrong renderer (FileStore)": was accepted and froze a tokenURI that
    /// can never render.
    function test_wrongRendererRefused() public {
        DeployProjects.Inputs memory i = _good();
        i.renderer = FILES;
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, false, false);
        // Even a deployer who sets BOTH overrides cannot get a non-renderer through: the probe has no override.
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    /// Regression of "stores swapped": tokenURI renders, yet no project could ever publish.
    function test_swappedStoresRefused() public {
        DeployProjects.Inputs memory i = _good();
        (i.directoryStore, i.fileStore) = (FILES, DIR);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, false, false);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    /// Regression of "wrong seed source" and "wrong ABX factory": harmless before (createOrg reverted), but
    /// now refused before anything is deployed.
    function test_wrongSeedAndAbxRefused() public {
        DeployProjects.Inputs memory i = _good();
        i.seed = DIR;
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);

        i = _good();
        i.abx = DIR;
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);

        // A real ABX contract that is the wrong one (the renderer where the factory belongs).
        i = _good();
        i.abx = ABX_RENDERER;
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    /// Regression of "plausible-looking wrong domain passes".
    function test_lookalikeGatewayRefused() public {
        DeployProjects.Inputs memory i = _good();
        i.gatewayBase = "https://fs.abx.io.evil.example";
        DWPresentation(i.presentation).setBase(i.gatewayBase);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, i.gatewayBase));
        d.preflight(i, false, false);
        d.preflight(i, false, true); // admitted only by the explicit flag
    }

    /// A chain outside the table is refused without the explicit flag, even with the real addresses.
    function test_unlistedChainNeedsTheOverride() public {
        vm.chainId(10); // OP Mainnet: not in the table (Ethereum, Sepolia, Base and Arbitrum and their testnets are)
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, 10));
        d.preflight(_good(), false, false);
    }
}
