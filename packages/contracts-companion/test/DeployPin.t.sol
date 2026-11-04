// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";

/// @dev Pins the resolver's creation code and predicted address, as `DeployFactoryPin.t.sol` does for the org layer.
///
///      The build keeps solc's metadata hash, so every source change moves the creation code: the resolver, its
///      interface, `protobuf-sol`'s `CID` and the content layer's interfaces it imports, comments and NatSpec included.
///      Its address also commits to its constructor arguments, the content layer's two stores, taken here from
///      `CoreDeploy.pinned()`.
///
///      Re-pinning:
///      - the content layer re-pinned: only the address moves; update `Deploy.pinned()` in `script/Deploy.s.sol`.
///      - the resolver's sources changed: update `CREATION_CODE_HASH` below and `Deploy.pinned()`.
///      Re-pin deliberately, and only before a deployment.
contract DeployPinTest is Test {
    bytes32 constant CREATION_CODE_HASH = 0x8be0c0316bb081e49c449c6503abe886b53a5e28309470aaa243128f505f8607;

    function test_creationCodeIsPinned() public pure {
        assertEq(keccak256(type(IpfsCidResolver).creationCode), CREATION_CODE_HASH, "resolver creation code moved");
    }

    /// Over the pinned content layer, the resolver lands at `Deploy.pinned()`: the same gate `runWith` applies before
    /// broadcasting off a local chain.
    function test_predictedAddressIsPinned() public {
        Deploy script = new Deploy();
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        script.requirePinned(script.predict(core.fileStore, core.directoryStore));
    }

    /// The pinned stores are the ones contracts-core's own build lands at, so the default `stores()` agrees with them.
    function test_defaultStoresAreThePinnedOnes() public {
        (address f, address d) = new Deploy().stores();
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        assertEq(f, core.fileStore, "FileStore");
        assertEq(d, core.directoryStore, "DirectoryStore");
    }

    /// The pinned build passes the gate on a production chain id and lands where pinned.
    function test_runOnAProductionChainIdWithThePinnedBuild() public {
        vm.chainId(8453);
        new DeployFromArtifacts().run();
        Deploy script = new Deploy();
        address resolver = script.run();
        assertEq(resolver, script.pinned());
        assertGt(resolver.code.length, 0);
    }

    /// Off a local chain, a build that does not land on the pin is refused before anything is broadcast.
    function test_runRefusesADriftedBuildOffLocal() public {
        vm.chainId(8453);
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        Deploy drifted = new DriftedDeploy();
        address at = drifted.predict(core.fileStore, core.directoryStore);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnexpectedAddress.selector, at, drifted.pinned()));
        drifted.run();
        assertEq(at.code.length, 0, "nothing was deployed");
    }

    /// Other stores than the pinned ones are refused off a local chain too: the resolver's address commits to them.
    function test_runRefusesOtherStoresOffLocal() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        vm.chainId(8453);
        Deploy script = new Deploy();
        address at = script.predict(core.directoryStore, core.fileStore);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnexpectedAddress.selector, at, script.pinned()));
        script.runWith(core.directoryStore, core.fileStore);
    }

    /// On a local chain the working tree deploys whatever it builds.
    function test_runOnALocalChainSkipsThePin() public {
        new DeployFromArtifacts().run();
        Deploy drifted = new DriftedDeploy();
        address resolver = drifted.run();
        assertTrue(resolver != drifted.pinned());
        assertGt(resolver.code.length, 0);
    }
}

/// @dev `Deploy` with one trailing byte after the constructor arguments (which the constructor ignores): other init
///      code for the same contract, so another address.
contract DriftedDeploy is Deploy {
    function _initCode(address fileStore, address directoryStore) internal pure override returns (bytes memory) {
        return abi.encodePacked(type(IpfsCidResolver).creationCode, abi.encode(fileStore, directoryStore), hex"00");
    }
}
