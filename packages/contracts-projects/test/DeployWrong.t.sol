// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Lens} from "../src/Lens.sol";

/// @dev Stand-ins that answer exactly the probe surface, so each wrong-deployment scenario can be run
///      without a fork. Each is a different contract so a swapped or substituted one is a real mistake.
contract DWAbxFactory {
    address public immutable implementation = address(this);

    function predictDeterministicAddress(bytes32 salt) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(salt)))));
    }

    function isAbxClone(address) external pure returns (bool) {
        return false;
    }
}

contract DWRenderer {
    function specVersion() external pure returns (uint256) {
        return 12;
    }
}

contract DWSeed {
    function seed(uint256 n, address a) external pure returns (bytes32) {
        return keccak256(abi.encode(n, a));
    }
}

contract DWDirectoryStore {
    function directoryExists(bytes32) external pure returns (bool) {
        return false;
    }
}

contract DWFileStore {
    function fileExists(bytes32) external pure returns (bool) {
        return false;
    }
}

/// @dev A contract that answers every selector with a word (a catch-all), as a proxy or a lazy mock would.
contract DWCatchAll {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(0));
    }
}

/// @dev No-fork scenarios. The allow-table is exercised on a listed chain with addresses that are not in it,
///      and the probes on an unlisted chain with both overrides set, so each check is tested alone.
contract DeployWrongMockTest is Test {
    DeployProjects d;
    DWAbxFactory abx;
    DWRenderer renderer;
    DWSeed seed;
    DWDirectoryStore dir;
    DWFileStore files;
    string constant GW = "https://fs.abx.io";

    function setUp() public {
        d = new DeployProjects();
        abx = new DWAbxFactory();
        renderer = new DWRenderer();
        seed = new DWSeed();
        dir = new DWDirectoryStore();
        files = new DWFileStore();
    }

    function _in() internal view returns (DeployProjects.Inputs memory) {
        return DeployProjects.Inputs(address(abx), address(renderer), address(seed), address(dir), address(files), GW);
    }

    /// @dev Run with both overrides on, so only the probes and the gateway format can fail.
    function _probesOnly(DeployProjects.Inputs memory i) internal view {
        d.preflight(i, true, true);
    }

    function _tail(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 j; j < out.length; ++j) out[j] = err[j + 4];
    }

    function test_happyPathWithOverrides() public {
        vm.chainId(999);
        _probesOnly(_in());
    }

    function test_wrongRendererIsCaught() public {
        DeployProjects.Inputs memory i = _in();
        i.renderer = address(files); // a store where the renderer belongs
        vm.chainId(999);
        try d.preflight(i, true, true) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), DeployProjects.ProbeFailed.selector);
            (, address at) = abi.decode(_tail(err), (string, address));
            assertEq(at, address(files));
        }
    }

    function test_catchAllContractIsNotARenderer() public {
        // Answers `specVersion()` with 0, the seed with a word, the stores with false: but also answers the
        // OTHER store's predicate, so as a store it is refused; and as a renderer 0 is refused.
        DWCatchAll c = new DWCatchAll();
        vm.chainId(999);
        DeployProjects.Inputs memory i = _in();
        i.renderer = address(c);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
        i = _in();
        i.fileStore = address(c);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
        i = _in();
        i.directoryStore = address(c);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    function test_swappedStoresAreCaught() public {
        DeployProjects.Inputs memory i = _in();
        (i.directoryStore, i.fileStore) = (i.fileStore, i.directoryStore);
        vm.chainId(999);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    function test_sameAddressForBothStoresIsCaught() public {
        DeployProjects.Inputs memory i = _in();
        i.fileStore = i.directoryStore;
        vm.chainId(999);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    function test_wrongAbxFactoryAndSeedAreCaught() public {
        DeployProjects.Inputs memory i = _in();
        i.abx = address(dir);
        vm.chainId(999);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);

        i = _in();
        i.seed = address(dir);
        vm.expectPartialRevert(DeployProjects.ProbeFailed.selector);
        d.preflight(i, true, true);
    }

    function test_noCodeAndZeroAreStillRefused() public {
        DeployProjects.Inputs memory i = _in();
        i.renderer = address(0x1234);
        vm.chainId(999);
        vm.expectPartialRevert(DeployProjects.NoCode.selector);
        d.preflight(i, true, true);
        i.renderer = address(0);
        vm.expectPartialRevert(DeployProjects.MissingAddress.selector);
        d.preflight(i, true, true);
    }

    // --- allow-table -----------------------------------------------------------------------------

    function test_unlistedChainNeedsTheOverride() public {
        // 137 (Polygon): not in the table. Ethereum (1) is listed since 2026-10-09.
        vm.chainId(137);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, 137));
        d.preflight(_in(), false, true);
        d.preflight(_in(), true, true);
    }

    function test_listedChainRefusesAnyAddressNotInTheTable() public {
        // The stand-ins are perfectly well-behaved, and still not the canonical addresses.
        vm.chainId(84532);
        vm.expectPartialRevert(DeployProjects.UnexpectedAddress.selector);
        d.preflight(_in(), false, false);
        vm.chainId(8453);
        vm.expectPartialRevert(DeployProjects.UnexpectedAddress.selector);
        d.preflight(_in(), false, false);
        // With the explicit override they pass: the override is the only way.
        d.preflight(_in(), true, true);
    }

    // --- gateway ---------------------------------------------------------------------------------

    function test_lookalikeGatewayIsRefusedOnListedChains() public {
        string[5] memory bad = [
            "https://fs.abx.io.evil.example",
            "https://fs.abx.io@evil.example",
            "https://abx.io",
            "https://fs.abx.io:8443",
            "https://fs.abx.io/x"
        ];
        for (uint256 k; k < bad.length; ++k) {
            DeployProjects.Inputs memory i = _in();
            i.gatewayBase = bad[k];
            // Pass the allow-table via the chain override, so only the gateway list is under test.
            vm.chainId(84532);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, bad[k]));
            d.preflight(i, true, false);
            d.preflight(i, true, true); // the explicit override admits it
        }
    }

    function test_gatewayStillMustPassTheFormatChecksEvenWithTheOverride() public {
        DeployProjects.Inputs memory i = _in();
        i.gatewayBase = "https://fs.abx.io/";
        vm.chainId(84532);
        vm.expectPartialRevert(DeployProjects.BadGatewayBase.selector);
        d.preflight(i, true, true);
    }

    function test_unlistedChainHasNoGatewayList() public {
        vm.chainId(999);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, GW));
        d.preflight(_in(), true, false);
    }

    /// @dev The whole run, locally, on an unlisted chain with both overrides: OrgMeta, the factory and the lens all land
    ///      at their CREATE2 predictions through the keyless deployer, and a second run reuses them. Through `runWith`,
    ///      which `run()` calls with the same values read from the environment: `vm.setEnv` is process-global and forge
    ///      runs tests in parallel, so a test that set the real variables would race every other test that reads them.
    function test_runDeploysEverythingThroughCreate2AndIsIdempotent() public {
        vm.chainId(999);

        (address factory, address lens) = d.runWith(_in(), true, true);

        address deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        address meta = vm.computeCreate2Address(
            keccak256("abx-fs/org-meta"), keccak256(abi.encodePacked(type(OrgMeta).creationCode, abi.encode(GW))), deployer
        );
        assertEq(OrgFactory(factory).orgMeta(), meta, "OrgMeta at its prediction");
        address wantFactory = vm.computeCreate2Address(
            keccak256("abx-fs/org-factory"),
            keccak256(
                abi.encodePacked(
                    type(OrgFactory).creationCode,
                    abi.encode(address(abx), address(renderer), address(seed), address(dir), address(files), meta)
                )
            ),
            deployer
        );
        assertEq(factory, wantFactory, "factory at its prediction");
        address hook = address(OrgFactory(factory).hook());
        address wantLens = vm.computeCreate2Address(
            keccak256("abx-fs/lens"), keccak256(abi.encodePacked(type(Lens).creationCode, abi.encode(factory, hook))), deployer
        );
        assertEq(lens, wantLens, "lens at its prediction (CREATE2, not CREATE)");
        assertEq(address(Lens(lens).factory()), factory);
        assertEq(address(Lens(lens).hook()), hook);

        (address factory2, address lens2) = d.runWith(_in(), true, true);
        assertEq(factory2, factory, "re-run reuses the factory");
        assertEq(lens2, lens, "re-run reuses the lens");
    }
}
