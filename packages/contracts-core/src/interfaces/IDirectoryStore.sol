// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFileStore} from "./IFileStore.sol";

/// @title IDirectoryStore
/// @notice Immutable, content-addressed ABX FS directories: a tree of entry nodes, at most three branch levels above
///         its leaves, sorted by name in unsigned byte order across the whole tree. Children are files of `fileStore()`
///         or directories of this store. A zero
///         root is the empty directory, which always exists. See `specs/abx-fs.md` §5.
interface IDirectoryStore {
    struct Entry {
        string name;
        bytes32 cid;
        bool isDirectory;
    }

    /// @notice Create (or return the existing) entry node: a leaf of name records or a branch.
    function putEntryNode(bytes calldata blob) external returns (bytes32 nodeId);

    /// @notice Bind a directory. `rootNode == 0` is the empty directory.
    function createDirectory(bytes32 rootNode) external returns (bytes32 cid);

    /// @notice `keccak256(0x32 ‖ rootNode)`.
    function directoryCid(bytes32 rootNode) external pure returns (bytes32 cid);

    function fileStore() external view returns (IFileStore);

    function directoryExists(bytes32 cid) external view returns (bool);

    function rootOf(bytes32 cid) external view returns (bytes32 root);

    function entryCount(bytes32 cid) external view returns (uint256);

    function getEntry(bytes32 cid, uint256 index) external view returns (Entry memory entry);

    /// @notice Entries in `[start, end)`. Callers page.
    function getEntries(bytes32 cid, uint256 start, uint256 end) external view returns (Entry[] memory entries);

    function lookup(bytes32 dirCid, string calldata name) external view returns (bytes32 cid, bool isDirectory);

    /// @notice Resolve a path of 1 to 32 `/`-separated segments from `rootCid`. More segments revert `PathTooDeep`: split a
    ///         deeper path and resolve each part from the directory the previous part ended at. An empty path or segment, a
    ///         leading or trailing `/`, a missing name or a segment under a file reverts `PathNotFound`.
    function resolvePath(bytes32 rootCid, string calldata path) external view returns (bytes32 cid, bool isDirectory);
}
