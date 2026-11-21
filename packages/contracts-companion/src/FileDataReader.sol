// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";

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
///         views serve on-chain HTML generators that emit gzip data URIs, where a browser does the decoding.
///
///         Integrity matches the store's: every chunk returned hashes to the `dataHash` ChunkStore recorded for it. A
///         chunk held raw in `sstore2Backend` is read straight from its SSTORE2 contract with EXTCODECOPY and hashed
///         here, skipping the FileStore -> ChunkStore -> backend call chain and its copies of every chunk (several
///         times less gas, more as files grow). Every other chunk, and any raw chunk whose code is not exactly its
///         recorded data, is read through `ChunkStore.read`, which applies the store's own check and reverts with the
///         store's own error. With the canonical `Sstore2Backend` as `sstore2Backend` (its `retrieve` returns the code
///         after the leading zero byte), a call returns exactly the bytes `FileStore.readChunk` returns, chunk by
///         chunk, or reverts as it would.
/// @dev Limits bound data bytes and chunk reads, not gas, as in `ContentReader`. Callers that must contain failures
///      should also cap call gas.
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
        public
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, bytes memory data)
    {
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        _limits(info.size, info.chunkCount, maxBytes, maxChunks);
        return (info.mimeType, info.codec, info.outputHash, _data(cid, info.size, info.chunkCount));
    }

    /// @notice A path's file data, using index.html when the exact path resolves to a directory (as
    ///         `ContentReader.readPath` does).
    function readPathData(bytes32 root, string memory path, uint256 maxBytes, uint256 maxChunks)
        public
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, bytes memory data)
    {
        return readFileData(_fileAt(root, path), maxBytes, maxChunks);
    }

    /// @notice `readFileData` with the data base64-encoded (RFC 4648, padded), ready for a data URI. `maxBytes` bounds
    ///         the data before encoding.
    function readFileDataBase64(bytes32 cid, uint256 maxBytes, uint256 maxChunks)
        public
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, string memory base64)
    {
        bytes memory data;
        (mimeType, codec, outputHash, data) = readFileData(cid, maxBytes, maxChunks);
        base64 = Base64.encode(data);
    }

    /// @notice `readPathData` with the data base64-encoded (RFC 4648, padded).
    function readPathDataBase64(bytes32 root, string memory path, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes32 codec, bytes32 outputHash, string memory base64)
    {
        return readFileDataBase64(_fileAt(root, path), maxBytes, maxChunks);
    }

    function _fileAt(bytes32 root, string memory path) private view returns (bytes32 cid) {
        bool isDirectory;
        (cid, isDirectory) = resolve(root, path);
        if (isDirectory) (cid, isDirectory) = directoryStore.lookup(cid, "index.html");
        if (isDirectory) revert IsDirectory(cid);
    }

    /// @dev The file's chunks joined. Sizes come from the chunk records, which FileStore bound to the file's leaves at
    ///      creation; their sum must be the file's recorded size.
    function _data(bytes32 cid, uint256 size, uint256 chunkCount) private view returns (bytes memory data) {
        bytes32[] memory ids = fileStore.getChunkIds(cid, 0, chunkCount);
        data = new bytes(size);
        uint256 offset;
        for (uint256 i; i < ids.length; ++i) {
            (address backend, uint48 chunkSize, bytes32 pointer, bytes32 dataHash) = chunkStore.recordOf(ids[i]);
            if (chunkSize == 0 || chunkSize > size - offset) revert InvalidFileLength();
            if (backend != sstore2Backend || !_copyRaw(data, offset, pointer, chunkSize, dataHash)) {
                bytes memory chunk = chunkStore.read(ids[i]);
                if (chunk.length != chunkSize) revert InvalidFileLength();
                _copy(data, offset, chunk, chunkSize);
            }
            offset += chunkSize;
        }
        if (offset != size) revert InvalidFileLength();
    }

    /// @dev Copy a raw SSTORE2 chunk (`0x00 ‖ data` as contract code) into `data` at `offset` and check it against
    ///      `dataHash`. False when the pointer is not an address whose code is exactly that long, or when the copied
    ///      bytes do not hash to the record; the caller then reads through ChunkStore, which overwrites the same region
    ///      or reverts.
    function _copyRaw(bytes memory data, uint256 offset, bytes32 pointer, uint256 size, bytes32 dataHash)
        private
        view
        returns (bool)
    {
        if (uint256(pointer) >> 160 != 0) return false;
        address p = address(uint160(uint256(pointer)));
        if (p.code.length != size + 1) return false;
        bytes32 h;
        assembly ("memory-safe") {
            let dst := add(add(data, 0x20), offset)
            extcodecopy(p, dst, 1, size)
            h := keccak256(dst, size)
        }
        return h == dataHash;
    }

    function _limits(uint256 size, uint256 chunks, uint256 maxBytes, uint256 maxChunks) private pure {
        if (size > maxBytes) revert ByteLimitExceeded(size, maxBytes);
        if (chunks > maxChunks) revert ChunkLimitExceeded(chunks, maxChunks);
    }

    function _copy(bytes memory dest, uint256 destOffset, bytes memory src, uint256 length) private pure {
        assembly ("memory-safe") {
            mcopy(add(add(dest, 0x20), destOffset), add(src, 0x20), length)
        }
    }
}
