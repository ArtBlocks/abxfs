// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

/// @title FileDataReader
/// @notice A file's stored DATA, for any file-level codec: its chunks joined (`specs/abx-fs.md` §6), returned with the
///         file's MIME type, `codec` and `outputHash`. No state, roles, or ETH.
///
///         `ContentReader` returns a file's CONTENT, so it refuses a file with a codec: that content is
///         `decode(codec, data)`, which the chain neither performs nor can check against `outputHash`. This companion is
///         its data-level counterpart. It never decodes; it hands the stored bytes, labelled, to a caller that decodes
///         them off chain and checks `keccak256(content) == outputHash`, as §6 requires of every reader. The base64
///         views serve on-chain HTML generators that emit gzip data URIs, where a browser does the decoding: encoding
///         here, in this call's own memory, keeps the raw data out of the caller's frame.
///
///         Integrity matches the store's: every chunk returned hashes to the `dataHash` ChunkStore recorded for it. A
///         chunk held raw in `sstore2Backend` is read straight from its SSTORE2 contract with EXTCODECOPY and hashed
///         here, skipping the FileStore -> ChunkStore -> backend call chain and its copies of every chunk. Every other
///         chunk, and any raw chunk whose code is not exactly its recorded data, is read through `ChunkStore.read`,
///         which applies the store's own check and reverts with the store's own error. With the canonical
///         `Sstore2Backend` as `sstore2Backend` (its `retrieve` returns the code after the leading zero byte), a call
///         returns exactly the bytes `FileStore.readChunk` returns, chunk by chunk, or reverts as it would.
///
///         Each read builds its ABI-encoded return value in one buffer, writes the chunks into it where the encoding
///         puts them, and returns that buffer, so the data is never copied a second time. A base64 view writes the
///         data a third of the way into the space its encoding will fill and encodes forward over it, so the data and
///         its encoding share that space.
/// @dev Limits bound data bytes and chunk reads, not gas, as in `ContentReader`. Callers that must contain failures
///      should also cap call gas. The read functions end in an assembly `return`; they are external and call nothing
///      after it. Built with the legacy code generator, under which putting the free memory pointer back after a
///      temporary read is sound (`IpfsCidResolver` relies on the same).
contract FileDataReader {
    IDirectoryStore public immutable directoryStore;
    IFileStore public immutable fileStore;
    IChunkStore public immutable chunkStore;
    /// @notice The raw SSTORE2 backend whose chunks are read directly. A chunk in any other backend takes the
    ///         `ChunkStore.read` path, so a wrong address here costs gas, never correctness.
    address public immutable sstore2Backend;

    error StoreMismatch();
    error RootNotFound(bytes32 cid);
    error NotDirectory(bytes32 cid);
    error IsDirectory(bytes32 cid);
    error ByteLimitExceeded(uint256 bytesRequired, uint256 maxBytes);
    error ChunkLimitExceeded(uint256 chunksRequired, uint256 maxChunks);
    error InvalidFileLength();

    constructor(address directoryStore_, address fileStore_, address sstore2Backend_) {
        directoryStore = IDirectoryStore(directoryStore_);
        fileStore = IFileStore(fileStore_);
        if (address(directoryStore.fileStore()) != fileStore_) revert StoreMismatch();
        chunkStore = fileStore.chunkStore();
        sstore2Backend = sstore2Backend_;
    }

    /// @notice Resolve an exact path. An empty path preserves a file or directory root.
    /// @dev Uses DirectoryStore's path rules (no leading/trailing slash or empty segments; 32 segments maximum).
    ///      The same rules as `ContentReader.resolve`.
    function resolve(bytes32 root, string memory path) public view returns (bytes32 cid, bool isDirectory) {
        isDirectory = directoryStore.directoryExists(root);
        if (!isDirectory && !fileStore.fileExists(root)) revert RootNotFound(root);
        if (bytes(path).length == 0) return (root, isDirectory);
        if (!isDirectory) revert NotDirectory(root);
        return directoryStore.resolvePath(root, path);
    }

    /// @notice A whole file's data, refusing its recorded byte/chunk totals before allocating it.
    /// @return mimeType The file's MIME type (of its content, not of the encoded data).
    /// @return codec The file-level codec token, zero for none; when set, `data` is the encoded form.
    /// @return outputHash `keccak256(content)` for a file with a codec, zero otherwise.
    /// @return data The chunks' data joined: the content itself when `codec` is zero.
    function readFileData(bytes32 cid, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, bytes memory data)
    {
        _respond(cid, maxBytes, maxChunks, false);
    }

    /// @notice A path's file data, using index.html when the exact path resolves to a directory (as
    ///         `ContentReader.readPath` does).
    function readPathData(bytes32 root, string memory path, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, bytes memory data)
    {
        _respond(_fileAt(root, path), maxBytes, maxChunks, false);
    }

    /// @notice `readFileData` with the data base64-encoded (RFC 4648, padded), ready for a data URI. `maxBytes` bounds
    ///         the data before encoding.
    function readFileDataBase64(bytes32 cid, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, string memory base64)
    {
        _respond(cid, maxBytes, maxChunks, true);
    }

    /// @notice `readPathData` with the data base64-encoded (RFC 4648, padded).
    function readPathDataBase64(bytes32 root, string memory path, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, string memory base64)
    {
        _respond(_fileAt(root, path), maxBytes, maxChunks, true);
    }

    function _fileAt(bytes32 root, string memory path) private view returns (bytes32 cid) {
        bool isDirectory;
        (cid, isDirectory) = resolve(root, path);
        if (isDirectory) (cid, isDirectory) = directoryStore.lookup(cid, "index.html");
        if (isDirectory) revert IsDirectory(cid);
    }

    /// @dev Reads `cid` and RETURNS from the current call `abi.encode(mimeType, codec, outputHash, out)`, where `out`
    ///      is the data or, when `base64`, its padded base64. The encoding is canonical (head, MIME tail, `out` tail),
    ///      built in one buffer (`_allocate`), and the data is written where the encoding needs it.
    function _respond(bytes32 cid, uint256 maxBytes, uint256 maxChunks, bool base64) private view {
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        if (info.size > maxBytes) revert ByteLimitExceeded(info.size, maxBytes);
        if (info.chunkCount > maxChunks) revert ChunkLimitExceeded(info.chunkCount, maxChunks);
        bytes32[] memory ids = fileStore.getChunkIds(cid, 0, info.chunkCount);
        (uint256 buf, uint256 out, uint256 at, uint256 outLength) = _allocate(info, base64);
        _readChunks(ids, at, info.size);
        if (base64) _encodeBase64(at, info.size, out);
        assembly ("memory-safe") {
            return(buf, sub(add(out, and(add(outLength, 0x1f), not(0x1f))), buf))
        }
    }

    /// @dev Allocates and fills in the return buffer except for `out`'s bytes:
    ///
    ///          buf: [0x80][codec][outputHash][offset of out] [mime length][mime, padded] [out length][out, padded]
    ///
    ///      The data goes at `at`: where it is returned (`at == out`), or, for base64, `groups + 64` bytes into `out`'s
    ///      space, where encoding forward over it never overwrites a byte not yet read (see `_encodeBase64`). The
    ///      allocation ends one word past `out`'s padded end and past the word after the data, both of which are
    ///      written whole.
    function _allocate(IFileStore.FileInfo memory info, bool base64)
        private
        pure
        returns (uint256 buf, uint256 out, uint256 at, uint256 outLength)
    {
        uint256 size = info.size;
        uint256 groups = (size + 2) / 3;
        outLength = base64 ? groups << 2 : size;
        bytes memory mime = bytes(info.mimeType);
        bytes32 codec = info.codec;
        bytes32 outputHash = info.outputHash;
        assembly ("memory-safe") {
            buf := mload(0x40)
            let mimeLength := mload(mime)
            let mimePadded := and(add(mimeLength, 0x1f), not(0x1f))
            let outLengthAt := add(add(buf, 0xa0), mimePadded)
            out := add(outLengthAt, 0x20)
            at := out
            if base64 { at := add(out, add(groups, 0x40)) }
            let end := add(add(out, and(add(outLength, 0x1f), not(0x1f))), 0x20)
            let dataEnd := add(add(at, size), 0x20)
            if gt(dataEnd, end) { end := dataEnd }
            mstore(0x40, end)

            mstore(buf, 0x80)
            mstore(add(buf, 0x20), codec)
            mstore(add(buf, 0x40), outputHash)
            mstore(add(buf, 0x60), sub(outLengthAt, buf))
            mstore(add(buf, 0x80), mimeLength)
            // Zero the MIME tail's last word before copying, so its padding is clean.
            if mimePadded { mstore(add(add(buf, 0x80), mimePadded), 0) }
            mcopy(add(buf, 0xa0), add(mime, 0x20), mimeLength)
            mstore(outLengthAt, outLength)
        }
    }

    /// @dev Writes the chunks' data, joined, to memory at `at`, then zeroes the word after it (the data's padding, or
    ///      the zeros the last base64 group reads past its end). Sizes come from the chunk records, which FileStore
    ///      bound to the file's leaves at creation; their sum must be the file's recorded size. Memory a fallback read
    ///      allocates is released after its bytes are copied into place.
    function _readChunks(bytes32[] memory ids, uint256 at, uint256 size) private view {
        uint256 offset;
        uint256 free;
        assembly ("memory-safe") {
            free := mload(0x40)
        }
        for (uint256 i; i < ids.length; ++i) {
            (address backend, uint48 chunkSize, bytes32 pointer, bytes32 dataHash) = chunkStore.recordOf(ids[i]);
            if (chunkSize == 0 || chunkSize > size - offset) revert InvalidFileLength();
            uint256 dst = at + offset;
            if (backend != sstore2Backend || !_copyRaw(dst, pointer, chunkSize, dataHash)) {
                bytes memory chunk = chunkStore.read(ids[i]);
                if (chunk.length != chunkSize) revert InvalidFileLength();
                assembly ("memory-safe") {
                    mcopy(dst, add(chunk, 0x20), chunkSize)
                }
            }
            assembly ("memory-safe") {
                mstore(0x40, free)
            }
            offset += chunkSize;
        }
        if (offset != size) revert InvalidFileLength();
        assembly ("memory-safe") {
            mstore(add(at, size), 0)
        }
    }

    /// @dev Copy a raw SSTORE2 chunk (`0x00 ‖ data` as contract code) to memory at `dst` and check it against
    ///      `dataHash`. False when the pointer is not an address whose code is exactly that long, or when the copied
    ///      bytes do not hash to the record; the caller then reads through ChunkStore, which overwrites the same region
    ///      or reverts.
    function _copyRaw(uint256 dst, bytes32 pointer, uint256 size, bytes32 dataHash) private view returns (bool) {
        if (uint256(pointer) >> 160 != 0) return false;
        address p = address(uint160(uint256(pointer)));
        if (p.code.length != size + 1) return false;
        bytes32 h;
        assembly ("memory-safe") {
            extcodecopy(p, dst, 1, size)
            h := keccak256(dst, size)
        }
        return h == dataHash;
    }

    /// @dev Base64-encodes (RFC 4648, padded) the `size` bytes at `src` to `dst`, front to back, and zeroes the word
    ///      after the encoding. The loop is Solady's `Base64.encode` (fileSafe and noPadding both false), run in place:
    ///      `src` lies `groups + 64` bytes past `dst`, where `groups = ceil(size / 3)`. Writing group `k` touches
    ///      `[dst + 4k, dst + 4k + 32)`; the next read is the three bytes at `src + 3(k + 1)`, and
    ///      `dst + 4k + 32 <= src + 3k + 3` holds for every `k < groups` because `src - dst = groups + 64 > k + 29`. The
    ///      word after the data is zero (`_readChunks` zeroes it, and no write before the last read reaches it: those
    ///      end by `dst + 4 groups + 24 < src + size`), as Solady zeroes it, so the last group reads zeros past
    ///      the data's end.
    function _encodeBase64(uint256 src, uint256 size, uint256 dst) private pure {
        assembly ("memory-safe") {
            if size {
                let free := mload(0x40)
                // Solady's table, offset by one byte so `mload(i)` leaves character `i` in the low byte. It overwrites
                // scratch space and the free memory pointer, which is restored below.
                mstore(0x1f, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
                mstore(0x3f, "ghijklmnopqrstuvwxyz0123456789+/")
                let ptr := dst
                let end := add(dst, shl(2, div(add(size, 2), 3)))
                let data := sub(src, 0x20)
                for {} 1 {} {
                    data := add(data, 3)
                    let input := mload(data)
                    mstore8(0, mload(and(shr(18, input), 0x3F)))
                    mstore8(1, mload(and(shr(12, input), 0x3F)))
                    mstore8(2, mload(and(shr(6, input), 0x3F)))
                    mstore8(3, mload(and(input, 0x3F)))
                    mstore(ptr, mload(0x00))
                    ptr := add(ptr, 4)
                    if iszero(lt(ptr, end)) { break }
                }
                mstore(0x40, free)
                // `o = [0, 2, 1][size % 3]` padding characters, written over the encoding's tail; then the word after
                // the encoding is zeroed, which is also the encoding's padding to a whole word.
                let o := div(2, mod(size, 3))
                mstore(sub(ptr, o), shl(240, 0x3d3d))
                mstore(ptr, 0)
            }
        }
    }
}
