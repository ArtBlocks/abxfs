// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy as DeployContent} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";

/// @dev The ABX FS content layer's store pair (contracts-core's own build, `DeployFromArtifacts.predict()`), the same on
///      every chain. The deploy
///      script's allow-table lists the same pair, and `DeployScript.t.sol` checks it against the core creation code.
address constant CONTENT_DIRECTORY_STORE = 0x4273E4E078F47303Ca15b11959eeb61F3FC94c11;
address constant CONTENT_FILE_STORE = 0x8b6077a1d6953D96687005B9408D56A655b4d155;

/// @dev Fork tests run against real ABX on Base Sepolia, where the content layer may not be deployed yet. These put
///      it on the fork (a no-op once it is really there) and build real content through it, so a root the hook
///      accepts is one the stores really hold rather than a mocked predicate.
library ContentLayer {
    /// @notice Deploy the content layer on the current fork through the keyless CREATE2 deployer, as production does.
    function deploy() internal returns (DeployContent.Addresses memory a) {
        a = new DeployFromArtifacts().run();
        require(a.directoryStore == CONTENT_DIRECTORY_STORE && a.fileStore == CONTENT_FILE_STORE, "content layer addresses moved");
    }

    /// @notice A real directory holding one HTML file, distinct per `tag`.
    function realDirectory(string memory tag) internal returns (bytes32 dir) {
        DeployContent.Addresses memory a = new DeployFromArtifacts().predict();
        bytes memory body = abi.encodePacked("<!doctype html><title>", tag, "</title>");
        bytes32 chunk = IChunkStore(a.chunkStore).write(a.sstore2Backend, body, keccak256(body), uint48(body.length));
        bytes32 leaf = IFileStore(a.fileStore).putChunkNode(abi.encodePacked(hex"00", chunk, uint48(body.length)));
        bytes32 file = IFileStore(a.fileStore).createFile(leaf, "text/html", bytes32(0), bytes32(0));
        bytes memory name = "index.html";
        bytes memory rec = abi.encodePacked(uint8(name.length), name, uint8(0), file);
        bytes32 node =
            IDirectoryStore(a.directoryStore).putEntryNode(abi.encodePacked(hex"00", uint16(1), uint16(0), rec));
        dir = IDirectoryStore(a.directoryStore).createDirectory(node);
    }

    /// @notice A real one-chunk text file, distinct per `tag`.
    function realFile(string memory tag) internal returns (bytes32 file) {
        DeployContent.Addresses memory a = new DeployFromArtifacts().predict();
        bytes memory body = abi.encodePacked("file ", tag);
        bytes32 chunk = IChunkStore(a.chunkStore).write(a.sstore2Backend, body, keccak256(body), uint48(body.length));
        bytes32 leaf = IFileStore(a.fileStore).putChunkNode(abi.encodePacked(hex"00", chunk, uint48(body.length)));
        file = IFileStore(a.fileStore).createFile(leaf, "text/plain", bytes32(0), bytes32(0));
    }
}
