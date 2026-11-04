// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy} from "./Deploy.s.sol";

/// @title DeployFromArtifacts — the content layer as contracts-core builds it, for use from other Foundry projects
/// @notice The build keeps solc's metadata hash, which commits to each source file's path and to the project's
///         remappings. A project that compiles these sources itself (contracts-companion, contracts-projects) therefore
///         produces different creation code than contracts-core does, and `Deploy` compiled there would predict and
///         deploy addresses that are not the canonical ones. This reads the creation code from contracts-core's own
///         `out/` instead, so it deploys and predicts exactly what contracts-core deploys. Build contracts-core first,
///         and grant the calling project read access to `../contracts-core/out` in its `fs_permissions`.
contract DeployFromArtifacts is Deploy {
    string internal constant OUT = "../contracts-core/out/";

    function _creationCode(Contract c) internal view override returns (bytes memory) {
        if (c == Contract.ChunkStore) return vm.getCode(string.concat(OUT, "ChunkStore.sol/ChunkStore.json"));
        if (c == Contract.Sstore2Backend) {
            return vm.getCode(string.concat(OUT, "Sstore2Backend.sol/Sstore2Backend.json"));
        }
        if (c == Contract.FastLzSstore2Backend) {
            return vm.getCode(string.concat(OUT, "FastLzSstore2Backend.sol/FastLzSstore2Backend.json"));
        }
        if (c == Contract.FileStore) return vm.getCode(string.concat(OUT, "FileStore.sol/FileStore.json"));
        return vm.getCode(string.concat(OUT, "DirectoryStore.sol/DirectoryStore.json"));
    }
}
