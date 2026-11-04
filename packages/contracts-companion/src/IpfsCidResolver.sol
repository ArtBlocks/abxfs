// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {CID} from "@abxfs/protobuf/CID.sol";

import {IIpfsCidResolver} from "./interfaces/IIpfsCidResolver.sol";

/// @title IpfsCidResolver
/// @notice View-only IPFS CIDv1 derivation for ABX FS files and directories, computed from the content on chain. No
///         state, no roles, no ETH. See `specs/abx-fs.md` §8.
///
/// @dev Profile (IPFS-native, fixed; `specs/abx-fs.md` §8):
///        - CIDv1, sha2-256 multihash;
///        - raw (0x55) leaves of 256 KiB (262,144 bytes); a file of at most 256 KiB is a single raw block;
///        - dag-pb (0x70) for multi-block file roots, as a balanced DAG of at most 174 links per node, each node's
///          UnixFS data carrying the file size and every child's file-data size (`blocksizes`);
///        - dag-pb directories with links in unsigned byte order of name; every link's `Tsize` is the CUMULATIVE
///          serialized size of the linked subtree (the target block plus every descendant), as Kubo and
///          `ipfs-unixfs-importer` emit;
///        - no HAMT: Kubo's `ipfs add -r` shards a directory whose link estimate (each entry's name bytes plus its 36
///          CID bytes, summed) passes 262,144 bytes, and such a directory reverts `DirectoryNeedsSharding` before any
///          child is derived.
///      The empty file is one raw block of zero bytes and the empty directory the four-byte block `0a020801`; both fall
///      out of the algorithm with zero input.
///
///      What is derived: a file's content, which without a codec is its data (its chunks' data joined in order), read
///      through `ChunkStore.read`; the FastLZ backend inflates its chunks on chain inside that read. A FastLZ file
///      therefore has the same IPFS CID as the raw file with the same content. Not derivable, by revert: a file with a
///      non-zero `codec` (its content is decoded off chain, `CodecNotSupported`), and any chunk whose backend the EVM
///      cannot read (`ChunkStore`'s `RetrieveFailed` bubbles up).
///
///      Memory stays flat. Chunk data is copied straight from return data into ONE reused buffer of one IPFS block
///      (plus the largest chunk seen), each block is hashed as soon as it fills, and the tail is moved to the front:
///      no file is ever held whole. Each file and directory resolves inside a memory arena that is released when it
///      returns (the free memory pointer is restored; only stack values cross the boundary), so siblings reuse the
///      same memory and the high-water mark follows the deepest path, not the size of the tree. Cost is therefore
///      linear in the bytes derived, counting a child once per link to it: nothing is memoised, so a tree whose
///      directories share children costs exponentially in its depth (it runs out of gas; it never answers wrongly).
///      Measured costs are in `specs/abx-fs.md` §8.
///
///      Directories are flat dag-pb nodes, and a directory's own block is held whole to be hashed (the sha256
///      precompile takes one contiguous input), so a directory's memory is linear in its encoded size. Kubo shards a
///      directory into a HAMT once its link estimate passes 262,144 bytes (boxo's default "links" estimate, strictly
///      greater, every entry counted); the HAMT form is not implemented, so those directories are refused. Nesting
///      depth is limited by the EVM stack: each level is an internal call, so a deep enough tree reverts. At least 32
///      levels (one `resolvePath` call) always derive.
contract IpfsCidResolver is IIpfsCidResolver {
    uint256 internal constant _BLOCK = 262_144;
    uint256 internal constant _MAX_LINKS = 174;
    /// @dev Chunk ids fetched per `getChunkIds` call.
    uint256 internal constant _ID_PAGE = 128;
    /// @dev Directory entries fetched per `getEntries` call.
    uint256 internal constant _ENTRY_PAGE = 64;
    /// @dev The block buffer starts with room for one block plus one full raw SSTORE2 chunk, so the raw backend never
    ///      makes it grow; a larger (inflated) chunk grows it in place.
    uint256 internal constant _BUFFER = 286_752; // _BLOCK + 24,608 (a literal: assembly reads it)
    /// @dev Upper bound of one encoded file node: 174 links of at most 53 bytes and at most 1,930 bytes of UnixFS data.
    uint256 internal constant _NODE_BUFFER = 11_264;
    /// @dev Kubo's HAMT switch (boxo's `HAMTShardingSize`): a directory whose link estimate passes it is sharded.
    uint256 internal constant _SHARD_THRESHOLD = 262_144;
    /// @dev Every CID this profile links is 36 bytes, and a name is 1 to 255 bytes, so each entry adds 37 to 291 to
    ///      the link estimate.
    uint256 internal constant _CID_BYTES = 36;
    uint256 internal constant _MIN_ENTRY_ESTIMATE = 37;
    uint256 internal constant _MAX_ENTRY_ESTIMATE = 291;

    IFileStore public immutable fileStore;
    IDirectoryStore public immutable directoryStore;
    IChunkStore public immutable chunkStore;

    /// @dev One layer of a file's balanced DAG, folded in place.
    struct Layer {
        bytes32[] shas;
        uint256[] totals;
        uint256[] cums;
    }

    /// @dev A directory's resolved children: digest, cumulative size and whether the child CID is dag-pb.
    struct Kids {
        bytes32[] shas;
        uint256[] cums;
        bytes dagPb;
    }

    constructor(address fileStore_, address directoryStore_) {
        fileStore = IFileStore(fileStore_);
        directoryStore = IDirectoryStore(directoryStore_);
        if (address(IDirectoryStore(directoryStore_).fileStore()) != fileStore_) revert StoreMismatch();
        chunkStore = IFileStore(fileStore_).chunkStore();
    }

    // ─────────────────────────── Public API ───────────────────────────

    /// @inheritdoc IIpfsCidResolver
    function computeIpfsCid(bytes32 directoryCid) external view returns (string memory) {
        (bytes32 sha,) = _directory(directoryCid);
        return CID.encode(CID.CODEC_DAG_PB, sha);
    }

    /// @inheritdoc IIpfsCidResolver
    function computeFileCid(bytes32 fileCid) external view returns (string memory) {
        (bytes32 sha, bool dagPb,) = _file(fileCid);
        return CID.encode(dagPb ? CID.CODEC_DAG_PB : CID.CODEC_RAW, sha);
    }

    /// @inheritdoc IIpfsCidResolver
    function fileLink(bytes32 fileCid) external view returns (uint256 codec, bytes32 digest, uint256 tsize) {
        bool dagPb;
        (digest, dagPb, tsize) = _file(fileCid);
        codec = dagPb ? CID.CODEC_DAG_PB : CID.CODEC_RAW;
    }

    /// @inheritdoc IIpfsCidResolver
    function directoryLink(bytes32 directoryCid) external view returns (uint256 codec, bytes32 digest, uint256 tsize) {
        (digest, tsize) = _directory(directoryCid);
        codec = CID.CODEC_DAG_PB;
    }

    // ─────────────────────────── Files ───────────────────────────

    /// @dev A file's digest, whether its CID is dag-pb, and its cumulative DAG size. Runs in its own arena.
    function _file(bytes32 cid) internal view returns (bytes32 sha, bool dagPb, uint256 cum) {
        uint256 arena = _mark();
        // The store reverts `FileNotFound(cid)` for a CID it does not hold: this interface's error, passed up.
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        if (info.codec != bytes32(0)) revert CodecNotSupported(info.codec);
        uint256 size = info.size;
        uint256 leaves = size == 0 ? 1 : (size + _BLOCK - 1) / _BLOCK;
        bytes32[] memory shas = new bytes32[](leaves);
        _stream(cid, info.chunkCount, size, shas);

        if (leaves == 1) {
            (sha, dagPb, cum) = (shas[0], false, size);
        } else {
            Layer memory layer = Layer(shas, new uint256[](leaves), new uint256[](leaves));
            for (uint256 i; i < leaves;) {
                uint256 len = i + 1 == leaves ? size - i * _BLOCK : _BLOCK;
                (layer.totals[i], layer.cums[i]) = (len, len);
                unchecked {
                    ++i;
                }
            }
            (sha, cum,) = _fold(layer, leaves);
            dagPb = true;
        }
        _release(arena);
    }

    /// @dev Hash the file's content block by block into `shas`, reading its chunks in pages of ids. The block buffer is
    ///      the last allocation, so a chunk larger than its spare room extends it in place. Once the total equals the
    ///      size, exactly ceil(size / block) blocks have been hashed (one for the empty file), the length of `shas`.
    function _stream(bytes32 cid, uint256 count, uint256 size, bytes32[] memory shas) private view {
        uint256 ids;
        uint256 buf;
        assembly ("memory-safe") {
            ids := mload(0x40)
            buf := add(ids, mul(_ID_PAGE, 0x20))
            mstore(0x40, add(buf, _BUFFER))
        }
        uint256 fill;
        uint256 total;
        uint256 leaf;
        for (uint256 start; start < count; start += _ID_PAGE) {
            uint256 n = count - start < _ID_PAGE ? count - start : _ID_PAGE;
            _fetchIds(cid, start, start + n, ids);
            for (uint256 k; k < n;) {
                uint256 len = _readChunk(_word(ids, k), buf + fill);
                fill += len;
                total += len;
                if (total > size) revert SizeMismatch(cid, size, total);
                while (fill >= _BLOCK) {
                    shas[leaf++] = _sha256(buf, _BLOCK);
                    fill -= _BLOCK;
                    _shiftDown(buf, fill);
                }
                unchecked {
                    ++k;
                }
            }
        }
        if (total != size) revert SizeMismatch(cid, size, total);
        if (fill != 0 || size == 0) shas[leaf] = _sha256(buf, fill);
    }

    /// @dev Fetch chunk ids `[start, end)` of `cid` into the `ids` region without allocating.
    function _fetchIds(bytes32 cid, uint256 start, uint256 end, uint256 ids) private view {
        address store = address(fileStore);
        bytes4 selector = IFileStore.getChunkIds.selector;
        bool ok;
        uint256 n;
        assembly ("memory-safe") {
            // Call input goes in the ids region, which the answer then overwrites. Nothing past the block buffer is
            // touched, so a small file pays for the memory its data needs, not for the whole buffer.
            mstore(ids, selector)
            mstore(add(ids, 0x04), cid)
            mstore(add(ids, 0x24), start)
            mstore(add(ids, 0x44), end)
            if iszero(staticcall(gas(), store, ids, 0x64, 0x00, 0x00)) {
                let p := mload(0x40)
                returndatacopy(p, 0x00, returndatasize())
                revert(p, returndatasize())
            }
            // bytes32[]: offset word, length word, items.
            if iszero(lt(returndatasize(), 0x40)) {
                returndatacopy(0x00, 0x00, 0x40)
                n := mload(0x20)
                ok := and(eq(mload(0x00), 0x20), and(eq(n, sub(end, start)), iszero(lt(returndatasize(), add(0x40, mul(n, 0x20))))))
            }
        }
        if (!ok) revert BadReturn();
        assembly ("memory-safe") {
            returndatacopy(ids, 0x40, mul(n, 0x20))
        }
    }

    /// @dev `ChunkStore.read(id)` copied straight from return data to `dst`, the end of the data already in the block buffer;
    ///      the free memory pointer is raised to cover it when the chunk needs more room. Returns the chunk's length.
    function _readChunk(bytes32 id, uint256 dst) private view returns (uint256 len) {
        address store = address(chunkStore);
        bytes4 selector = IChunkStore.read.selector;
        bool ok;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, id)
            if iszero(staticcall(gas(), store, 0x00, 0x24, 0x00, 0x00)) {
                let p := mload(0x40)
                returndatacopy(p, 0x00, returndatasize())
                revert(p, returndatasize())
            }
            if iszero(lt(returndatasize(), 0x40)) {
                returndatacopy(0x00, 0x00, 0x40)
                len := mload(0x20)
                // A chunk's size is a uint48 on its record; bounding it first keeps the sum below from wrapping.
                ok := and(
                    and(eq(mload(0x00), 0x20), iszero(gt(len, 0xffffffffffff))),
                    iszero(lt(returndatasize(), add(0x40, len)))
                )
            }
        }
        if (!ok) revert BadReturn();
        assembly ("memory-safe") {
            let need := add(dst, len)
            if gt(need, mload(0x40)) { mstore(0x40, and(add(need, 0x1f), not(0x1f))) }
            returndatacopy(dst, 0x40, len)
        }
    }

    /// @dev Move the `rest` bytes after the first block of `buf` to its front.
    function _shiftDown(uint256 buf, uint256 rest) private pure {
        assembly ("memory-safe") {
            mcopy(buf, add(buf, _BLOCK), rest)
        }
    }

    /// @dev Fold a layer of `n ≥ 2` entries into the single dag-pb root of a balanced DAG, at most 174 links per node,
    ///      writing each level over the front of the same arrays. Returns the root's digest, cumulative size and
    ///      encoded length.
    function _fold(Layer memory layer, uint256 n) internal view returns (bytes32 sha, uint256 cum, uint256 rootLen) {
        uint256 node = _alloc(_NODE_BUFFER);
        uint256 childCodec = CID.CODEC_RAW;
        while (n > 1) {
            uint256 m = (n + _MAX_LINKS - 1) / _MAX_LINKS;
            for (uint256 g; g < m;) {
                rootLen = _foldGroup(layer, g, n, childCodec, node);
                unchecked {
                    ++g;
                }
            }
            n = m;
            childCodec = CID.CODEC_DAG_PB;
        }
        return (layer.shas[0], layer.cums[0], rootLen);
    }

    /// @dev Group `g` of the current level becomes entry `g` of the next. Entry `g` is written only after children
    ///      `[174g, 174g + 174)` have been read, and later groups read only indexes above `g`, so folding in place is
    ///      safe. Returns the node's encoded length.
    function _foldGroup(Layer memory layer, uint256 g, uint256 n, uint256 childCodec, uint256 node)
        private
        view
        returns (uint256 len)
    {
        uint256 s = g * _MAX_LINKS;
        uint256 e = s + _MAX_LINKS < n ? s + _MAX_LINKS : n;
        bytes32 h;
        uint256 fileSize;
        uint256 childCum;
        (h, len, fileSize, childCum) = _fileNode(layer, s, e, childCodec, node);
        layer.shas[g] = h;
        layer.totals[g] = fileSize;
        layer.cums[g] = len + childCum;
    }

    /// @dev Encode the dag-pb file node over children `[s, e)` into `node` and hash it. Links come first (field 2),
    ///      then the UnixFS data (field 1): type File, the file size, and every child's file-data size (`blocksizes`).
    function _fileNode(Layer memory layer, uint256 s, uint256 e, uint256 childCodec, uint256 node)
        private
        view
        returns (bytes32 sha, uint256 len, uint256 fileSize, uint256 childCum)
    {
        uint256 p = node;
        for (uint256 i = s; i < e;) {
            uint256 c = layer.cums[i];
            fileSize += layer.totals[i];
            childCum += c;
            // PBNode.Links: 0x12 len, PBLink { 0x0a 0x24 cid, 0x12 0x00 (empty name), 0x18 tsize }
            uint256 linkLen = 41 + _varintLen(c);
            p = _byte(p, 0x12);
            p = _varint(p, linkLen);
            p = _cid(p, childCodec, layer.shas[i]);
            p = _byte(_byte(p, 0x12), 0x00);
            p = _varint(_byte(p, 0x18), c);
            unchecked {
                ++i;
            }
        }
        p = _fileData(p, layer, s, e, fileSize);
        len = p - node;
        sha = _sha256(node, len);
    }

    /// @dev PBNode.Data (0x0a len) holding UnixFS { Type: File (0x08 0x02), filesize (0x18), blocksizes (0x20 …) }.
    function _fileData(uint256 p, Layer memory layer, uint256 s, uint256 e, uint256 fileSize)
        private
        pure
        returns (uint256)
    {
        uint256 dataLen = 3 + _varintLen(fileSize);
        for (uint256 i = s; i < e;) {
            dataLen += 1 + _varintLen(layer.totals[i]);
            unchecked {
                ++i;
            }
        }
        p = _varint(_byte(p, 0x0a), dataLen);
        p = _varint(_byte(_byte(_byte(p, 0x08), 0x02), 0x18), fileSize);
        for (uint256 i = s; i < e;) {
            p = _varint(_byte(p, 0x20), layer.totals[i]);
            unchecked {
                ++i;
            }
        }
        return p;
    }

    // ─────────────────────────── Directories ───────────────────────────

    /// @dev A directory's digest and cumulative size. Two passes over the entries: the first resolves every child and
    ///      sizes the node, the second writes it into a buffer of exactly that size. Runs in its own arena; each page
    ///      of entries is released as soon as it has been used.
    function _directory(bytes32 cid) internal view returns (bytes32 sha, uint256 cum) {
        uint256 arena = _mark();
        // The store reverts `DirectoryNotFound(cid)` for a CID it does not hold: this interface's error, passed up.
        uint256 count = directoryStore.entryCount(cid);
        // Up to 900 entries the estimate cannot pass the threshold, whatever the names.
        if (count * _MAX_ENTRY_ESTIMATE > _SHARD_THRESHOLD) _refuseSharded(cid, count);
        Kids memory kids = Kids(new bytes32[](count), new uint256[](count), new bytes(count));

        uint256 nodeLen = 4; // PBNode.Data: 0x0a 0x02, UnixFS { Type: Directory } = 0x08 0x01
        for (uint256 start; start < count; start += _ENTRY_PAGE) {
            uint256 page = _mark();
            IDirectoryStore.Entry[] memory es = directoryStore.getEntries(cid, start, _min(start + _ENTRY_PAGE, count));
            for (uint256 k; k < es.length;) {
                nodeLen += _resolveChild(kids, start + k, es[k]);
                unchecked {
                    ++k;
                }
            }
            _release(page);
        }

        uint256 node = _alloc(nodeLen);
        uint256 p = node;
        uint256 childCum;
        for (uint256 start; start < count; start += _ENTRY_PAGE) {
            uint256 page = _mark();
            IDirectoryStore.Entry[] memory es = directoryStore.getEntries(cid, start, _min(start + _ENTRY_PAGE, count));
            for (uint256 k; k < es.length;) {
                uint256 i = start + k;
                childCum += kids.cums[i];
                p = _dirLink(p, bytes(es[k].name), kids, i);
                unchecked {
                    ++k;
                }
            }
            _release(page);
        }
        p = _byte(_byte(_byte(_byte(p, 0x0a), 0x02), 0x08), 0x01);
        if (p - node != nodeLen) revert BadReturn();
        sha = _sha256(node, nodeLen);
        cum = nodeLen + childCum;
        _release(arena);
    }

    /// @dev Revert `DirectoryNeedsSharding` if the directory's link estimate passes the threshold: names only, before
    ///      any child is derived. Counting stops as soon as the estimate passes, so a refusal reads at most 7,084
    ///      entries however large the directory.
    function _refuseSharded(bytes32 cid, uint256 count) internal view {
        if (count * _MIN_ENTRY_ESTIMATE > _SHARD_THRESHOLD) {
            revert DirectoryNeedsSharding(cid, count * _MIN_ENTRY_ESTIMATE);
        }
        uint256 estimate;
        for (uint256 start; start < count; start += _ENTRY_PAGE) {
            uint256 page = _mark();
            IDirectoryStore.Entry[] memory es = directoryStore.getEntries(cid, start, _min(start + _ENTRY_PAGE, count));
            for (uint256 k; k < es.length;) {
                estimate += bytes(es[k].name).length + _CID_BYTES;
                if (estimate > _SHARD_THRESHOLD) revert DirectoryNeedsSharding(cid, estimate);
                unchecked {
                    ++k;
                }
            }
            _release(page);
        }
    }

    /// @dev Resolve entry `i` and return the bytes its link will take in the directory node.
    function _resolveChild(Kids memory kids, uint256 i, IDirectoryStore.Entry memory e) private view returns (uint256) {
        bytes32 h;
        bool dagPb = true;
        uint256 c;
        if (e.isDirectory) {
            (h, c) = _directory(e.cid);
        } else {
            (h, dagPb, c) = _file(e.cid);
        }
        (kids.shas[i], kids.cums[i]) = (h, c);
        if (dagPb) kids.dagPb[i] = 0x01;
        uint256 linkLen = _linkLen(bytes(e.name).length, c);
        return 1 + _varintLen(linkLen) + linkLen;
    }

    /// @dev PBNode.Links entry for a named child: 0x12 len, PBLink { 0x0a 0x24 cid, 0x12 nameLen name, 0x18 tsize }.
    function _dirLink(uint256 p, bytes memory name, Kids memory kids, uint256 i) private pure returns (uint256) {
        uint256 c = kids.cums[i];
        p = _varint(_byte(p, 0x12), _linkLen(name.length, c));
        p = _cid(p, kids.dagPb[i] == 0x01 ? CID.CODEC_DAG_PB : CID.CODEC_RAW, kids.shas[i]);
        p = _varint(_byte(p, 0x12), name.length);
        assembly ("memory-safe") {
            mcopy(p, add(name, 0x20), mload(name))
        }
        p += name.length;
        return _varint(_byte(p, 0x18), c);
    }

    function _linkLen(uint256 nameLen, uint256 tsize) private pure returns (uint256) {
        return 40 + _varintLen(nameLen) + nameLen + _varintLen(tsize);
    }

    // ─────────────────────────── Encoding ───────────────────────────

    /// @dev `0x0a 0x24` then the 36-byte binary CIDv1: version 1, codec, sha2-256 multihash header, digest.
    function _cid(uint256 p, uint256 codec, bytes32 digest) private pure returns (uint256) {
        assembly ("memory-safe") {
            mstore8(p, 0x0a)
            mstore8(add(p, 1), 0x24)
            mstore8(add(p, 2), 0x01)
            mstore8(add(p, 3), codec)
            mstore8(add(p, 4), 0x12)
            mstore8(add(p, 5), 0x20)
            mstore(add(p, 6), digest)
        }
        return p + 38;
    }

    function _byte(uint256 p, uint256 b) private pure returns (uint256) {
        assembly ("memory-safe") {
            mstore8(p, b)
        }
        return p + 1;
    }

    function _varint(uint256 p, uint256 v) private pure returns (uint256 end) {
        assembly ("memory-safe") {
            for {} gt(v, 0x7f) {} {
                mstore8(p, or(and(v, 0x7f), 0x80))
                v := shr(7, v)
                p := add(p, 1)
            }
            mstore8(p, v)
            end := add(p, 1)
        }
    }

    function _varintLen(uint256 v) private pure returns (uint256 n) {
        n = 1;
        while (v > 0x7f) {
            v >>= 7;
            ++n;
        }
    }

    // ─────────────────────────── Memory and hashing ───────────────────────────

    function _sha256(uint256 p, uint256 len) private view returns (bytes32 h) {
        assembly ("memory-safe") {
            if iszero(staticcall(gas(), 0x02, p, len, 0x00, 0x20)) { revert(0x00, 0x00) }
            h := mload(0x00)
        }
    }

    function _alloc(uint256 len) private pure returns (uint256 p) {
        assembly ("memory-safe") {
            p := mload(0x40)
            mstore(0x40, add(p, and(add(len, 0x3f), not(0x1f))))
        }
    }

    /// @dev Arena start: the free memory pointer now.
    function _mark() private pure returns (uint256 m) {
        assembly ("memory-safe") {
            m := mload(0x40)
        }
    }

    /// @dev Release everything allocated since `m`. Only called where nothing allocated after `m` is used again: the
    ///      values that leave an arena are stack values. Sound under the legacy code generator (`via_ir = false`),
    ///      which never moves stack variables to memory.
    function _release(uint256 m) private pure {
        assembly ("memory-safe") {
            mstore(0x40, m)
        }
    }

    function _word(uint256 p, uint256 i) private pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(p, mul(i, 0x20)))
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
