// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Multicallable} from "solady/utils/Multicallable.sol";

import {IChunkStore} from "./interfaces/IChunkStore.sol";
import {IFileStore} from "./interfaces/IFileStore.sol";
import {NodeTree} from "./NodeTree.sol";

/// @title FileStore
/// @notice Immutable, content-addressed ABX FS files. A file is a tree of chunk nodes, at most three branch levels
///         above its leaves (leaf: `0x00 ‖ (chunkId:32 ‖ size:6) × n`, 1 ≤ n ≤ 646), over `ChunkStore` chunks from any
///         backend, a MIME type, and an optional off-chain codec. Every size a leaf lists is checked against the
///         chunk's `ChunkStore` record, and branches
///         carry cumulative byte counts, so any byte offset is found in one descent (`locateByte`). Nodes are created
///         in any number of transactions (`putChunkNode`) and bound by one `createFile`. A zero root is the empty
///         file. See `specs/abx-fs.md` §5 and §6.
contract FileStore is IFileStore, NodeTree, Multicallable {
    error FileNotFound(bytes32 cid);
    error InvalidMimeType();
    /// @notice `codec` and `outputHash` must both be zero or both be set, and the empty file has no codec.
    error InvalidCodec();
    error RangeOutOfBounds(uint256 start, uint256 end, uint256 count);
    error ChunkSizeMismatch(bytes32 chunkId, uint256 recorded, uint256 claimed);
    error NoChunkStore();

    bytes1 internal constant _FILE_PREFIX = 0x31;
    bytes1 internal constant _CHUNK_NODE_PREFIX = 0x41;
    uint256 internal constant _MAX_MIMETYPE_LEN = 127;
    uint256 internal constant _LEAF_STRIDE = 38;

    IChunkStore public immutable chunkStore;

    /// @dev A file exists iff its MIME type is stored (never empty), because the empty file's root is zero.
    mapping(bytes32 => string) internal _mimeTypes;
    mapping(bytes32 => bytes32) internal _roots;
    /// @dev Both written only when non-zero (`codec` and `outputHash` are zero together).
    mapping(bytes32 => bytes32) internal _codecs;
    mapping(bytes32 => bytes32) internal _outputHashes;

    event FileCreated(
        bytes32 indexed cid,
        bytes32 root,
        string mimeType,
        bytes32 codec,
        bytes32 outputHash,
        uint256 chunkCount,
        uint256 size
    );

    constructor(address chunkStore_) {
        if (chunkStore_.code.length == 0) revert NoChunkStore();
        chunkStore = IChunkStore(chunkStore_);
    }

    /// @inheritdoc IFileStore
    function putChunkNode(bytes calldata blob) external returns (bytes32) {
        return _putNode(_CHUNK_NODE_PREFIX, blob);
    }

    /// @inheritdoc IFileStore
    function createFile(bytes32 rootNode, string calldata mimeType, bytes32 codec, bytes32 outputHash)
        external
        returns (bytes32 cid)
    {
        uint256 mimeLen = bytes(mimeType).length;
        if (mimeLen == 0 || mimeLen > _MAX_MIMETYPE_LEN) revert InvalidMimeType();
        if ((codec == bytes32(0)) != (outputHash == bytes32(0))) revert InvalidCodec();
        uint256 count;
        uint256 size;
        if (rootNode == bytes32(0)) {
            // The empty file: no chunks, so no data for a codec to decode.
            if (codec != bytes32(0)) revert InvalidCodec();
        } else {
            Node memory root = _node(rootNode);
            (count, size) = (root.count, root.bytes_);
        }

        cid = fileCid(rootNode, mimeType, codec, outputHash);
        if (bytes(_mimeTypes[cid]).length != 0) return cid;

        _mimeTypes[cid] = mimeType;
        if (rootNode != bytes32(0)) _roots[cid] = rootNode;
        if (codec != bytes32(0)) {
            _codecs[cid] = codec;
            _outputHashes[cid] = outputHash;
        }
        emit FileCreated(cid, rootNode, mimeType, codec, outputHash, count, size);
    }

    /// @inheritdoc IFileStore
    function fileCid(bytes32 rootNode, string calldata mimeType, bytes32 codec, bytes32 outputHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_FILE_PREFIX, rootNode, keccak256(bytes(mimeType)), codec, outputHash));
    }

    function _validateLeaf(bytes calldata blob) internal view override returns (uint32, uint48) {
        uint256 len = blob.length;
        if (len < 1 + _LEAF_STRIDE || (len - 1) % _LEAF_STRIDE != 0) revert BadNode();
        uint256 n = (len - 1) / _LEAF_STRIDE;
        uint256 total;
        for (uint256 i = 0; i < n;) {
            uint256 o = 1 + i * _LEAF_STRIDE;
            bytes32 id = bytes32(blob[o:o + 32]);
            uint256 claimed = uint48(bytes6(blob[o + 32:o + 38]));
            // Reverts `ChunkNotFound` for a chunk that is not recorded.
            uint256 recorded = chunkStore.sizeOf(id);
            if (recorded != claimed) revert ChunkSizeMismatch(id, recorded, claimed);
            total += claimed;
            unchecked {
                ++i;
            }
        }
        if (total > type(uint48).max) revert BadNode();
        return (uint32(n), uint48(total));
    }

    function _tracksBytes() internal pure override returns (bool) {
        return true;
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    /// @inheritdoc IFileStore
    function fileExists(bytes32 cid) external view returns (bool) {
        return bytes(_mimeTypes[cid]).length != 0;
    }

    /// @inheritdoc IFileStore
    function getFileInfo(bytes32 cid) external view returns (FileInfo memory info) {
        bytes32 root = _rootOf(cid);
        info.root = root;
        info.mimeType = _mimeTypes[cid];
        info.codec = _codecs[cid];
        info.outputHash = _outputHashes[cid];
        if (root != bytes32(0)) {
            Node memory node = _node(root);
            (info.rootLevel, info.chunkCount, info.size) = (node.level, node.count, node.bytes_);
        }
    }

    /// @inheritdoc IFileStore
    function chunkCount(bytes32 cid) external view returns (uint256) {
        bytes32 root = _rootOf(cid);
        return root == bytes32(0) ? 0 : _node(root).count;
    }

    /// @inheritdoc IFileStore
    function getChunkId(bytes32 cid, uint256 index) public view returns (bytes32) {
        bytes32 root = _rootOf(cid);
        if (root == bytes32(0)) revert IndexOutOfRange(index, 0);
        (Node memory leaf, uint256 local) = _locate(root, index);
        return bytes32(_readUint(leaf.pointer, 1 + local * _LEAF_STRIDE, 32));
    }

    /// @inheritdoc IFileStore
    function getChunkIds(bytes32 cid, uint256 start, uint256 end) external view returns (bytes32[] memory out) {
        bytes32 root = _rootOf(cid);
        uint256 count = root == bytes32(0) ? 0 : _node(root).count;
        if (start > end || end > count) revert RangeOutOfBounds(start, end, count);
        out = new bytes32[](end - start);
        uint256 i = start;
        while (i < end) {
            // One descent per leaf, then a single read of everything wanted from it.
            (Node memory leaf, uint256 local) = _locate(root, i);
            uint256 take = leaf.count - local;
            if (take > end - i) take = end - i;
            bytes memory raw = _read(leaf.pointer, 1 + local * _LEAF_STRIDE, take * _LEAF_STRIDE);
            for (uint256 k = 0; k < take;) {
                bytes32 h;
                assembly {
                    h := mload(add(add(raw, 32), mul(k, 38)))
                }
                out[i - start + k] = h;
                unchecked {
                    ++k;
                }
            }
            i += take;
        }
    }

    /// @inheritdoc IFileStore
    function locateByte(bytes32 cid, uint256 offset)
        external
        view
        returns (uint256 index, uint256 chunkStart, bytes32 chunkId, uint256 chunkSize)
    {
        bytes32 root = _rootOf(cid);
        if (root == bytes32(0)) revert OffsetOutOfRange(offset, 0);
        (Node memory leaf, uint256 local, uint256 firstItem) = _locateByte(root, offset);
        uint256 j;
        uint256 startInLeaf;
        (j, startInLeaf, chunkId, chunkSize) = _scanLeaf(leaf, local);
        return (firstItem + j, offset - (local - startInLeaf), chunkId, chunkSize);
    }

    /// @dev The record of `leaf` holding byte `local` of the leaf: its position, the leaf offset of its first byte,
    ///      its chunk id and its size.
    function _scanLeaf(Node memory leaf, uint256 local)
        private
        view
        returns (uint256 j, uint256 pos, bytes32 id, uint256 size)
    {
        bytes memory raw = _read(leaf.pointer, 1, leaf.count * _LEAF_STRIDE);
        for (; j < leaf.count;) {
            assembly {
                size := shr(208, mload(add(add(raw, 32), add(mul(j, 38), 32))))
            }
            if (local < pos + size) {
                assembly {
                    id := mload(add(add(raw, 32), mul(j, 38)))
                }
                return (j, pos, id, size);
            }
            pos += size;
            unchecked {
                ++j;
            }
        }
        revert BadNode(); // unreachable: the descent keeps `local` below the leaf's byte total, the sum of its sizes
    }

    /// @inheritdoc IFileStore
    function readChunk(bytes32 cid, uint256 index) external view returns (bytes memory) {
        return chunkStore.read(getChunkId(cid, index));
    }

    /// @dev The root of an existing file (zero for the empty file). Reverts `FileNotFound`.
    function _rootOf(bytes32 cid) internal view returns (bytes32) {
        if (bytes(_mimeTypes[cid]).length == 0) revert FileNotFound(cid);
        return _roots[cid];
    }
}
