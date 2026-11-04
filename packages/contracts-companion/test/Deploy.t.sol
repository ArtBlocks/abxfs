// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";

contract DeployTest is Test {
    /// The content layer deployed by its own script, then the resolver over it at the predicted address; a second
    /// run is a no-op.
    function test_deploysOverTheContentLayerAndIsIdempotent() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        Deploy script = new Deploy();
        (address f, address d) = script.stores();
        assertEq(f, core.fileStore, "default stores are the content layer's prediction");
        assertEq(d, core.directoryStore);

        address resolver = script.run();
        assertEq(resolver, script.predict(core.fileStore, core.directoryStore));
        assertEq(address(IpfsCidResolver(resolver).fileStore()), core.fileStore);
        assertEq(address(IpfsCidResolver(resolver).directoryStore()), core.directoryStore);
        assertEq(address(IpfsCidResolver(resolver).chunkStore()), core.chunkStore);
        assertEq(script.run(), resolver, "re-running changes nothing");

        // The empty directory derives through the deployed contracts.
        bytes32 empty = keccak256(abi.encodePacked(bytes1(0x32), bytes32(0)));
        assertEq(
            IpfsCidResolver(resolver).computeIpfsCid(empty),
            "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"
        );
    }

    function test_refusesStoresWithoutCode() public {
        Deploy script = new Deploy();
        vm.expectRevert(bytes("no FileStore at that address"));
        script.runWith(makeAddr("nothing-here"), makeAddr("nor-here"));
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        vm.expectRevert(bytes("no DirectoryStore at that address"));
        script.runWith(core.fileStore, makeAddr("nor-here"));
    }

    /// Stores that both have code but are not bound to each other: the resolver's constructor refuses them
    /// (`StoreMismatch`), so the CREATE2 deploys nothing and the run fails.
    function test_runFailsWhenTheConstructorRefuses() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        address otherDirs = address(new DirectoryStore(address(new FileStore(core.chunkStore))));
        Deploy script = new Deploy();
        vm.expectRevert(bytes("CREATE2 deployment failed"));
        script.runWith(core.fileStore, otherDirs);
    }

    /// The build keeps solc's metadata hash (as contracts-core does): the runtime code ends in a CBOR trailer with the
    /// keys "solc" (`64 73 6f 6c 63`) and "ipfs" (`64 69 70 66 73`), committing to the exact source and settings.
    function test_metadataTrailerCommitsToSource() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        bytes memory code = address(new IpfsCidResolver(core.fileStore, core.directoryStore)).code;
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
