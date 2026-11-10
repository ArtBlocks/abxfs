// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

interface IContentReaderOrg {
    function paramHooks() external view returns (address configure, address augment, address transfer);
}

interface IContentReaderHook {
    struct Version {
        bytes32 cid;
        uint40 publishedAt;
        address publisher;
    }

    function versionAt(address org, uint256 tokenId, uint256 version) external view returns (Version memory);
    function getTag(address org, uint256 tokenId, string calldata tag) external view returns (uint256, bytes32);
    function latestVersion(address org, uint256 tokenId) external view returns (uint256, bytes32);
}

/// @title ContentReader
/// @notice Native, EVM-readable ABX FS content. FastLZ storage is decoded by FileStore.readChunk;
///         file-level off-chain codecs are deliberately unsupported. No state, roles, or ETH.
/// @dev Limits bound decoded bytes and chunk reads, not gas: arbitrary storage backends may spend gas
///      while retrieving a chunk. Callers that must contain failures should also cap call gas.
contract ContentReader {
    IDirectoryStore public immutable directoryStore;
    IFileStore public immutable fileStore;

    struct Range {
        uint256 first;
        uint256 last;
        uint256 skip;
        uint256 readBytes;
    }

    error StoreMismatch();
    error RootNotFound(bytes32 cid);
    error NotDirectory(bytes32 cid);
    error IsDirectory(bytes32 cid);
    error CodecNotSupported(bytes32 codec);
    error ByteLimitExceeded(uint256 bytesRequired, uint256 maxBytes);
    error ChunkLimitExceeded(uint256 chunksRequired, uint256 maxChunks);
    error InvalidFileLength();
    error RangeOutOfBounds(uint256 start, uint256 length, uint256 size);
    error InvalidProjectSelector();
    error ConfigureHookNotFound();

    constructor(address directoryStore_, address fileStore_) {
        directoryStore = IDirectoryStore(directoryStore_);
        fileStore = IFileStore(fileStore_);
        if (address(directoryStore.fileStore()) != fileStore_) revert StoreMismatch();
    }

    /// @notice Resolve an exact path. An empty path preserves a file or directory root.
    /// @dev Uses DirectoryStore's path rules (no leading/trailing slash or empty segments; 32 segments maximum).
    function resolve(bytes32 root, string memory path) public view returns (bytes32 cid, bool isDirectory) {
        isDirectory = directoryStore.directoryExists(root);
        if (!isDirectory && !fileStore.fileExists(root)) revert RootNotFound(root);
        if (bytes(path).length == 0) return (root, isDirectory);
        if (!isDirectory) revert NotDirectory(root);
        return directoryStore.resolvePath(root, path);
    }

    /// @notice Read a whole file, refusing its recorded byte/chunk totals before allocating content.
    function readFile(bytes32 cid, uint256 maxBytes, uint256 maxChunks)
        public
        view
        returns (string memory mimeType, bytes memory data)
    {
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        _codec(info.codec);
        _limits(info.size, info.chunkCount, maxBytes, maxChunks);
        data = new bytes(info.size);
        uint256 offset;
        for (uint256 i; i < info.chunkCount; ++i) {
            bytes memory chunk = fileStore.readChunk(cid, i);
            if (chunk.length == 0 || chunk.length > info.size - offset) revert InvalidFileLength();
            _copy(data, offset, chunk, 0, chunk.length);
            offset += chunk.length;
        }
        if (offset != info.size) revert InvalidFileLength();
        return (info.mimeType, data);
    }

    /// @notice Read a path, using index.html when the exact path resolves to a directory.
    function readPath(bytes32 root, string memory path, uint256 maxBytes, uint256 maxChunks)
        public
        view
        returns (string memory mimeType, bytes memory data)
    {
        (bytes32 cid, bool isDirectory) = resolve(root, path);
        if (isDirectory) (cid, isDirectory) = directoryStore.lookup(cid, "index.html");
        if (isDirectory) revert IsDirectory(cid);
        return readFile(cid, maxBytes, maxChunks);
    }

    /// @notice Read [start, start + length). Bounds are strict; a zero length at EOF is valid.
    /// @dev maxBytes covers the FULL decoded sizes of all touched chunks, including bytes outside the
    ///      returned range. locateByte finds both endpoints without reading or scanning preceding chunks.
    function readFileRange(bytes32 cid, uint256 start, uint256 length, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mimeType, bytes memory data)
    {
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        _codec(info.codec);
        if (start > info.size || length > info.size - start) revert RangeOutOfBounds(start, length, info.size);
        if (length == 0) return (info.mimeType, new bytes(0));
        // The output itself is bounded even if a noncanonical store reports inconsistent endpoints.
        _limits(length, 0, maxBytes, maxChunks);
        Range memory r = _rangeBounds(cid, start, length);
        if (r.last >= info.chunkCount || r.readBytes < length) revert InvalidFileLength();
        _limits(r.readBytes, r.last - r.first + 1, maxBytes, maxChunks);
        data = _range(cid, length, r);
        return (info.mimeType, data);
    }

    /// @notice Resolve an org project through that org's own configure hook, including older orgs.
    /// @dev version=0 and an empty tag selects latest; otherwise use either a 1-based version or tag.
    ///      This is a content convenience, not an attestation that an arbitrary org is factory-registered.
    function projectRoot(address org, uint256 tokenId, uint256 version, string memory tag)
        public
        view
        returns (bytes32 cid)
    {
        if (version != 0 && bytes(tag).length != 0) revert InvalidProjectSelector();
        (address configure,,) = IContentReaderOrg(org).paramHooks();
        if (configure == address(0)) revert ConfigureHookNotFound();
        IContentReaderHook hook = IContentReaderHook(configure);
        if (version != 0) return hook.versionAt(org, tokenId, version).cid;
        if (bytes(tag).length != 0) (, cid) = hook.getTag(org, tokenId, tag);
        else (, cid) = hook.latestVersion(org, tokenId);
    }

    function readProject(
        address org,
        uint256 tokenId,
        uint256 version,
        string memory tag,
        string memory path,
        uint256 maxBytes,
        uint256 maxChunks
    ) external view returns (string memory mimeType, bytes memory data) {
        return readPath(projectRoot(org, tokenId, version, tag), path, maxBytes, maxChunks);
    }

    function _rangeBounds(bytes32 cid, uint256 start, uint256 length) private view returns (Range memory r) {
        uint256 firstStart;
        uint256 lastStart;
        uint256 lastSize;
        (r.first, firstStart,,) = fileStore.locateByte(cid, start);
        (r.last, lastStart,, lastSize) = fileStore.locateByte(cid, start + length - 1);
        if (r.last < r.first || firstStart > start || lastStart > start + length - 1) revert InvalidFileLength();
        r.skip = start - firstStart;
        r.readBytes = lastStart + lastSize - firstStart;
    }

    function _range(bytes32 cid, uint256 length, Range memory r) private view returns (bytes memory data) {
        data = new bytes(length);
        uint256 copied;
        uint256 readBytes;
        uint256 skip = r.skip;
        for (uint256 i = r.first; i <= r.last; ++i) {
            bytes memory chunk = fileStore.readChunk(cid, i);
            if (chunk.length <= skip || chunk.length > r.readBytes - readBytes) revert InvalidFileLength();
            readBytes += chunk.length;
            uint256 take = chunk.length - skip;
            if (take > length - copied) take = length - copied;
            _copy(data, copied, chunk, skip, take);
            copied += take;
            skip = 0;
        }
        if (copied != length || readBytes != r.readBytes) revert InvalidFileLength();
    }

    function _codec(bytes32 codec) private pure {
        if (codec != bytes32(0)) revert CodecNotSupported(codec);
    }

    function _limits(uint256 size, uint256 chunks, uint256 maxBytes, uint256 maxChunks) private pure {
        if (size > maxBytes) revert ByteLimitExceeded(size, maxBytes);
        if (chunks > maxChunks) revert ChunkLimitExceeded(chunks, maxChunks);
    }

    function _copy(bytes memory dest, uint256 destOffset, bytes memory src, uint256 srcOffset, uint256 length)
        private
        pure
    {
        assembly ("memory-safe") {
            mcopy(add(add(dest, 32), destOffset), add(add(src, 32), srcOffset), length)
        }
    }
}
