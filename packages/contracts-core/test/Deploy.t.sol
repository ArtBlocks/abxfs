// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {DeployFromArtifacts} from "../script/DeployFromArtifacts.s.sol";
import {FileStore} from "../src/FileStore.sol";
import {DirectoryStore} from "../src/DirectoryStore.sol";
import {ChunkStore} from "../src/ChunkStore.sol";

contract DeployTest is Test {
    function test_deploysAtPredictedAddressesAndIsIdempotent() public {
        Deploy script = new Deploy();
        Deploy.Addresses memory want = script.predict();
        Deploy.Addresses memory got = script.run();
        assertEq(got.chunkStore, want.chunkStore);
        assertEq(got.fileStore, want.fileStore);
        assertEq(got.directoryStore, want.directoryStore);
        assertEq(address(FileStore(got.fileStore).chunkStore()), got.chunkStore);
        assertEq(address(DirectoryStore(got.directoryStore).fileStore()), got.fileStore);
        assertTrue(got.sstore2Backend.code.length > 0 && got.fastLzSstore2Backend.code.length > 0);

        // A second run on the same chain changes nothing.
        Deploy.Addresses memory again = script.run();
        assertEq(again.directoryStore, got.directoryStore);
    }

    /// Every chunk id commits to its backend's ADDRESS, and every file and directory CID to its chunk ids, so a change
    /// to any of these five contracts' source (a comment included: the metadata hash commits to it) moves its CREATE2
    /// address and silently forks the content-address space rather than failing. Pinned in `Deploy.pinned()`, which
    /// `run` also enforces, so such a change is loud. Re-pin deliberately (and only before a deployment), together with
    /// `DeployFactoryPin.t.sol` in contracts-projects, which pins the stores through the factory.
    function test_predictedAddressesArePinned() public {
        Deploy script = new Deploy();
        script.requirePinned(script.predict());
    }

    /// Off a local chain, a build that does not land on the pins is refused before anything is broadcast.
    function test_runRefusesADriftedBuildOffLocal() public {
        Deploy drifted = new DriftedDeploy(Deploy.Contract.FileStore, false);
        vm.chainId(8453);
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.UnexpectedAddress.selector, "FileStore", drifted.predict().fileStore, drifted.pinned().fileStore
            )
        );
        drifted.run();
        assertEq(drifted.predict().chunkStore.code.length, 0, "nothing was deployed");
    }

    /// The pinned build passes the same gate on a production chain id.
    function test_runOnAProductionChainIdWithThePinnedBuild() public {
        vm.chainId(8453);
        Deploy.Addresses memory a = new Deploy().run();
        assertGt(a.directoryStore.code.length, 0);
    }

    /// On a local chain the working tree deploys whatever it builds.
    function test_runOnALocalChainSkipsThePins() public {
        Deploy drifted = new DriftedDeploy(Deploy.Contract.ChunkStore, false);
        Deploy.Addresses memory a = drifted.run();
        assertTrue(a.chunkStore != drifted.pinned().chunkStore);
        assertGt(a.chunkStore.code.length, 0);
    }

    /// A CREATE2 that deploys nothing fails the run.
    function test_runRevertsWhenACreate2Fails() public {
        Deploy failing = new DriftedDeploy(Deploy.Contract.Sstore2Backend, true);
        vm.expectRevert(bytes("CREATE2 deployment failed"));
        failing.run();
    }

    /// Reading contracts-core's own artifacts gives contracts-core's own build, contract by contract.
    function test_artifactsMatchTheBuild() public {
        Deploy.Addresses memory a = new DeployFromArtifacts().predict();
        Deploy.Addresses memory b = new Deploy().predict();
        assertEq(a.chunkStore, b.chunkStore);
        assertEq(a.sstore2Backend, b.sstore2Backend);
        assertEq(a.fastLzSstore2Backend, b.fastLzSstore2Backend);
        assertEq(a.fileStore, b.fileStore);
        assertEq(a.directoryStore, b.directoryStore);
    }

    /// The build keeps solc's metadata hash, so the runtime code ends in a CBOR trailer committing to the exact source
    /// (comments and NatSpec included) and the compiler settings. Every solc trailer carries the CBOR key "solc"
    /// (`64 73 6f 6c 63`) and, with an IPFS metadata hash, the key "ipfs" (`64 69 70 66 73`) in its last few dozen bytes.
    function test_metadataTrailerCommitsToSource() public {
        bytes memory code = address(new ChunkStore()).code;
        assertTrue(_tail(code, hex"64736f6c63"), "solc key");
        assertTrue(_tail(code, hex"6469706673"), "ipfs key");
    }

    function _tail(bytes memory code, bytes memory key) private pure returns (bool) {
        uint256 from = code.length > 64 ? code.length - 64 : 0;
        for (uint256 i = from; i + key.length <= code.length; i++) {
            bool hit = true;
            for (uint256 j; j < key.length && hit; j++) {
                hit = code[i + j] == key[j];
            }
            if (hit) return true;
        }
        return false;
    }
}

/// @dev `Deploy` with one contract's creation code changed: one trailing byte appended (a different build of the same
///      contract), or replaced by init code that deploys nothing.
contract DriftedDeploy is Deploy {
    Contract internal immutable _changed;
    bool internal immutable _empty;

    constructor(Contract changed, bool empty) {
        _changed = changed;
        _empty = empty;
    }

    function _creationCode(Contract c) internal view override returns (bytes memory) {
        bytes memory code = super._creationCode(c);
        if (c != _changed) return code;
        // `PUSH1 0 PUSH1 0 RETURN`: a successful CREATE2 that leaves no code.
        if (_empty) return hex"60006000f3";
        return bytes.concat(code, hex"00");
    }
}
