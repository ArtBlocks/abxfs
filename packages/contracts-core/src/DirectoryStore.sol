// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Multicallable} from "solady/utils/Multicallable.sol";

import {IDirectoryStore} from "./interfaces/IDirectoryStore.sol";
import {IFileStore} from "./interfaces/IFileStore.sol";
import {NodeTree} from "./NodeTree.sol";
import {NameOps} from "./utils/NameOps.sol";

/// @title DirectoryStore
/// @notice Immutable, content-addressed ABX FS directories. A directory is a tree of entry nodes, at most three
///         branch levels above its leaves (leaf: `0x00 ‖ count:2 ‖ offset:2 × count ‖ records`, record =
///         `nameLen:1 ‖ name ‖ isDirectory:1 ‖ cid:32`),
///         sorted in unsigned byte order across the whole tree. Children are files of `fileStore` or directories of
///         this store. Nodes are created in any number of transactions (`putEntryNode`) and bound by one
///         `createDirectory`. A zero root is the empty directory, which always exists. See `specs/abx-fs.md` §5.
contract DirectoryStore is IDirectoryStore, NodeTree, Multicallable {
    error DirectoryNotFound(bytes32 cid);
    error CidNotFound(bytes32 cid);
    error EntriesNotSorted();
    error InvalidName();
    error PathTooDeep(uint256 depth, uint256 maxDepth);
    error PathNotFound(string path);
    error RangeOutOfBounds(uint256 start, uint256 end, uint256 count);
    error NoFileStore();

    bytes1 internal constant _DIRECTORY_PREFIX = 0x32;
    bytes1 internal constant _ENTRY_NODE_PREFIX = 0x42;
    uint256 internal constant _MAX_NAME_BYTES = 255;
    uint256 internal constant _MAX_PATH_DEPTH = 32;

    /// @notice The empty directory's CID, `keccak256(0x32 ‖ bytes32(0))`. It exists without being created.
    bytes32 public constant EMPTY_DIRECTORY = keccak256(abi.encodePacked(_DIRECTORY_PREFIX, bytes32(0)));

    IFileStore public immutable fileStore;

    /// @dev directory CID => root node. Zero means "does not exist", except for `EMPTY_DIRECTORY`.
    mapping(bytes32 => bytes32) internal _roots;

    event DirectoryCreated(bytes32 indexed cid, bytes32 root, uint256 entryCount);

    constructor(address fileStore_) {
        if (fileStore_.code.length == 0) revert NoFileStore();
        fileStore = IFileStore(fileStore_);
    }

    /// @inheritdoc IDirectoryStore
    function putEntryNode(bytes calldata blob) external returns (bytes32) {
        return _putNode(_ENTRY_NODE_PREFIX, blob);
    }

    /// @inheritdoc IDirectoryStore
    function createDirectory(bytes32 rootNode) external returns (bytes32 cid) {
        cid = directoryCid(rootNode);
        if (rootNode == bytes32(0) || _roots[cid] != bytes32(0)) return cid;
        Node memory root = _node(rootNode);
        _roots[cid] = rootNode;
        emit DirectoryCreated(cid, rootNode, root.count);
    }

    /// @inheritdoc IDirectoryStore
    function directoryCid(bytes32 rootNode) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_DIRECTORY_PREFIX, rootNode));
    }

    // ---------------------------------------------------------------------
    // Node validation
    // ---------------------------------------------------------------------

    function _validateLeaf(bytes calldata blob) internal view override returns (uint32, uint48) {
        if (blob.length < 3) revert BadNode();
        uint256 count = uint16(bytes2(blob[1:3]));
        if (count == 0) revert BadNode();
        uint256 recStart = 3 + 2 * count;
        if (blob.length < recStart) revert BadNode();

        uint256 pos = recStart;
        bytes memory prev;
        for (uint256 i = 0; i < count;) {
            if (uint16(bytes2(blob[3 + 2 * i:5 + 2 * i])) != pos - recStart) revert BadNode();
            if (pos >= blob.length) revert BadNode();
            uint256 nameLen = uint8(blob[pos]);
            uint256 end = pos + 2 + nameLen + 32;
            if (end > blob.length) revert BadNode();

            bytes calldata name = blob[pos + 1:pos + 1 + nameLen];
            _validateName(name);
            bytes memory cur = name;
            if (i != 0 && _compare(prev, cur) >= 0) revert EntriesNotSorted();
            prev = cur;

            uint8 flag = uint8(blob[pos + 1 + nameLen]);
            if (flag > 1) revert BadNode();
            bytes32 child = bytes32(blob[pos + 2 + nameLen:end]);
            if (flag == 1) {
                if (!_exists(child)) revert CidNotFound(child);
            } else if (!fileStore.fileExists(child)) {
                revert CidNotFound(child);
            }
            pos = end;
            unchecked {
                ++i;
            }
        }
        if (pos != blob.length) revert BadNode();
        return (uint32(count), 0);
    }

    function _tracksBytes() internal pure override returns (bool) {
        return false;
    }

    function _checkBoundary(bytes32 left, bytes32 right) internal view override {
        if (_compare(_edgeName(left, false), _edgeName(right, true)) >= 0) revert EntriesNotSorted();
    }

    function _validateName(bytes calldata b) private pure {
        uint256 len = b.length;
        if (len == 0 || len > _MAX_NAME_BYTES) revert InvalidName();
        if (len == 1 && b[0] == ".") revert InvalidName();
        if (len == 2 && b[0] == "." && b[1] == ".") revert InvalidName();
        if (NameOps.hasSeparator(b)) revert InvalidName();
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    /// @inheritdoc IDirectoryStore
    function directoryExists(bytes32 cid) external view returns (bool) {
        return _exists(cid);
    }

    /// @inheritdoc IDirectoryStore
    function rootOf(bytes32 cid) external view returns (bytes32) {
        return _root(cid);
    }

    /// @inheritdoc IDirectoryStore
    function entryCount(bytes32 cid) external view returns (uint256) {
        bytes32 root = _root(cid);
        return root == bytes32(0) ? 0 : _node(root).count;
    }

    /// @inheritdoc IDirectoryStore
    function getEntry(bytes32 cid, uint256 index) external view returns (Entry memory) {
        bytes32 root = _root(cid);
        if (root == bytes32(0)) revert IndexOutOfRange(index, 0);
        (Node memory leaf, uint256 local) = _locate(root, index);
        return _entryAt(leaf, local);
    }

    /// @inheritdoc IDirectoryStore
    function getEntries(bytes32 cid, uint256 start, uint256 end) external view returns (Entry[] memory out) {
        bytes32 root = _root(cid);
        uint256 count = root == bytes32(0) ? 0 : _node(root).count;
        if (start > end || end > count) revert RangeOutOfBounds(start, end, count);
        out = new Entry[](end - start);
        uint256 i = start;
        while (i < end) {
            // One descent per leaf, then sequential records from it.
            (Node memory leaf, uint256 local) = _locate(root, i);
            uint256 take = leaf.count - local;
            if (take > end - i) take = end - i;
            for (uint256 k = 0; k < take;) {
                out[i - start + k] = _entryAt(leaf, local + k);
                unchecked {
                    ++k;
                }
            }
            i += take;
        }
    }

    /// @inheritdoc IDirectoryStore
    function lookup(bytes32 dirCid, string calldata name) external view returns (bytes32 cid, bool isDirectory) {
        (bool found, Entry memory e) = _find(_root(dirCid), bytes(name));
        if (!found) revert PathNotFound(name);
        return (e.cid, e.isDirectory);
    }

    /// @inheritdoc IDirectoryStore
    function resolvePath(bytes32 rootCid, string calldata path) external view returns (bytes32 cid, bool isDirectory) {
        _root(rootCid);
        bytes calldata p = bytes(path);
        if (p.length == 0) revert PathNotFound(path);
        if (p[0] == "/" || p[p.length - 1] == "/") revert PathNotFound(path);

        cid = rootCid;
        isDirectory = true;
        uint256 depth;
        uint256 start;
        uint256 len = p.length;
        for (uint256 i = 0; i <= len; i++) {
            if (i == len || p[i] == "/") {
                if (i == start) revert PathNotFound(path);
                if (!isDirectory) revert PathNotFound(path);
                depth++;
                if (depth > _MAX_PATH_DEPTH) revert PathTooDeep(depth, _MAX_PATH_DEPTH);
                bytes memory seg = p[start:i];
                // `cid` is a directory that exists: the root was checked above, and every child was checked to exist
                // when its parent's leaf was created. The empty directory's root is zero, which `_find` treats as
                // "no entries".
                (bool found, Entry memory e) = _find(_roots[cid], seg);
                if (!found) revert PathNotFound(path);
                (cid, isDirectory) = (e.cid, e.isDirectory);
                start = i + 1;
            }
        }
    }

    function _exists(bytes32 cid) internal view returns (bool) {
        return _roots[cid] != bytes32(0) || cid == EMPTY_DIRECTORY;
    }

    /// @dev The root of an existing directory (zero for the empty directory). Reverts `DirectoryNotFound`.
    function _root(bytes32 cid) internal view returns (bytes32 r) {
        r = _roots[cid];
        if (r == bytes32(0) && cid != EMPTY_DIRECTORY) revert DirectoryNotFound(cid);
    }

    /// @dev Record `j` of a leaf.
    function _entryAt(Node memory leaf, uint256 j) private view returns (Entry memory e) {
        uint256 count = _readUint(leaf.pointer, 1, 2);
        uint256 pos = 3 + 2 * count + _readUint(leaf.pointer, 3 + 2 * j, 2);
        uint256 nameLen = _readUint(leaf.pointer, pos, 1);
        e.name = string(_read(leaf.pointer, pos + 1, nameLen));
        e.isDirectory = _readUint(leaf.pointer, pos + 1 + nameLen, 1) == 1;
        e.cid = bytes32(_readUint(leaf.pointer, pos + 2 + nameLen, 32));
    }

    /// @dev Name of the first or last entry under `id`, descending first/last children.
    function _edgeName(bytes32 id, bool first) private view returns (bytes memory) {
        Node memory node = _node(id);
        while (node.level != 0) {
            node = _node(_branchChild(node, first ? 0 : _branchChildren(node) - 1));
        }
        uint256 count = _readUint(node.pointer, 1, 2);
        uint256 j = first ? 0 : count - 1;
        uint256 pos = 3 + 2 * count + _readUint(node.pointer, 3 + 2 * j, 2);
        uint256 nameLen = _readUint(node.pointer, pos, 1);
        return _read(node.pointer, pos + 1, nameLen);
    }

    /// @dev Binary search for `name` under `root`. A zero root (the empty directory) has no entries.
    function _find(bytes32 root, bytes memory name) private view returns (bool, Entry memory e) {
        if (root == bytes32(0)) return (false, e);
        Node memory node = _node(root);
        while (node.level != 0) {
            uint256 n = _branchChildren(node);
            // Largest child whose first name <= name.
            uint256 lo = 0;
            uint256 hi = n - 1;
            while (lo < hi) {
                uint256 mid = (lo + hi + 1) / 2;
                if (_compare(_edgeName(_branchChild(node, mid), true), name) <= 0) lo = mid;
                else hi = mid - 1;
            }
            node = _node(_branchChild(node, lo));
        }
        uint256 lo2 = 0;
        uint256 hi2 = _readUint(node.pointer, 1, 2); // exclusive
        while (lo2 < hi2) {
            uint256 mid2 = (lo2 + hi2) / 2;
            Entry memory cand = _entryAt(node, mid2);
            int256 c = _compare(bytes(cand.name), name);
            if (c == 0) return (true, cand);
            if (c < 0) lo2 = mid2 + 1;
            else hi2 = mid2;
        }
        return (false, e);
    }

    /// @dev Unsigned byte-lexicographic compare, shorter prefix first: -1, 0, 1.
    function _compare(bytes memory a, bytes memory b) private pure returns (int256) {
        return NameOps.compare(a, b);
    }
}
