// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibZip} from "solady/utils/LibZip.sol";

import {ChunkStore} from "@abxfs/core/ChunkStore.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {Sstore2Backend} from "@abxfs/core/backends/Sstore2Backend.sol";
import {FastLzSstore2Backend} from "@abxfs/core/backends/FastLzSstore2Backend.sol";
import {IStorageBackend} from "@abxfs/core/interfaces/IStorageBackend.sol";

/// @dev A backend the EVM cannot read (a log backend's shape): it keeps nothing and `retrieve` always reverts.
contract UnreadableBackend is IStorageBackend {
    event Stored(bytes32 indexed pointer, bytes data);

    function store(bytes calldata input, address) external returns (bytes32 pointer) {
        pointer = keccak256(input);
        emit Stored(pointer, input);
    }

    function readable() external pure returns (bool) {
        return false;
    }

    function retrieve(bytes32) external pure returns (bytes memory) {
        revert NotEvmReadable();
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("evm-log", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @notice Shared harness for the resolver tests: the real ABX FS content layer (chunk store, raw and FastLZ SSTORE2
///         backends, file and directory stores) and helpers that build files and directories through it.
abstract contract BaseCompanionTest is Test {
    uint256 internal constant RAW_MAX = 24_575;
    uint256 internal constant LEAF_MAX = 512;

    ChunkStore internal chunkStore;
    Sstore2Backend internal raw;
    FastLzSstore2Backend internal flz;
    FileStore internal fileStore;
    DirectoryStore internal directoryStore;

    function setUp() public virtual {
        chunkStore = new ChunkStore();
        raw = new Sstore2Backend();
        flz = new FastLzSstore2Backend();
        fileStore = new FileStore(address(chunkStore));
        directoryStore = new DirectoryStore(address(fileStore));
    }

    // ---- chunks and files ----------------------------------------------

    function rawChunk(bytes memory data) internal returns (bytes32) {
        return chunkStore.write(address(raw), data, keccak256(data), uint48(data.length));
    }

    function flzChunk(bytes memory data) internal returns (bytes32) {
        return chunkStore.write(address(flz), LibZip.flzCompress(data), keccak256(data), uint48(data.length));
    }

    /// @dev A file of `data` split into raw chunks of at most `chunkSize` bytes.
    function writeFile(bytes memory data, string memory mime) internal returns (bytes32) {
        return writeFileChunked(data, RAW_MAX, mime);
    }

    function writeFileChunked(bytes memory data, uint256 chunkSize, string memory mime) internal returns (bytes32) {
        uint256[] memory sizes = new uint256[]((data.length + chunkSize - 1) / chunkSize);
        for (uint256 i; i < sizes.length; i++) {
            sizes[i] = i + 1 == sizes.length ? data.length - i * chunkSize : chunkSize;
        }
        return writeFileSized(data, sizes, false, mime);
    }

    /// @dev A file of `data` cut into chunks of the given sizes (which must sum to its length), raw or FastLZ.
    function writeFileSized(bytes memory data, uint256[] memory sizes, bool fastLz, string memory mime)
        internal
        returns (bytes32)
    {
        bytes32[] memory ids = new bytes32[](sizes.length);
        uint256 off;
        for (uint256 i; i < sizes.length; i++) {
            bytes memory piece = slice(data, off, sizes[i]);
            ids[i] = fastLz ? flzChunk(piece) : rawChunk(piece);
            off += sizes[i];
        }
        require(off == data.length, "sizes must cover the data");
        return createFileFromChunks(ids, sizes, mime);
    }

    /// @dev Leaves of at most 512 records under one branch when needed (enough for every test here).
    function createFileFromChunks(bytes32[] memory ids, uint256[] memory sizes, string memory mime)
        internal
        returns (bytes32)
    {
        if (ids.length == 0) return fileStore.createFile(bytes32(0), mime, 0, bytes32(0));
        uint256 leaves = (ids.length + LEAF_MAX - 1) / LEAF_MAX;
        bytes32[] memory leafIds = new bytes32[](leaves);
        uint32[] memory counts = new uint32[](leaves);
        uint48[] memory bytes_ = new uint48[](leaves);
        for (uint256 l; l < leaves; l++) {
            uint256 from = l * LEAF_MAX;
            uint256 end = from + LEAF_MAX < ids.length ? from + LEAF_MAX : ids.length;
            // Written in place: concatenating record by record would cost quadratic memory in the test frame.
            bytes memory blob = new bytes(1 + (end - from) * 38);
            for (uint256 i = from; i < end; i++) {
                bytes32 id = ids[i];
                uint256 sizeWord = sizes[i] << 208;
                uint256 at = 1 + (i - from) * 38;
                assembly ("memory-safe") {
                    let p := add(add(blob, 0x20), at)
                    mstore(p, id)
                    // Six size bytes, then restore whatever the store clobbered after them (the next record).
                    let next := mload(add(p, 0x26))
                    mstore(add(p, 0x20), sizeWord)
                    mstore(add(p, 0x26), next)
                }
                bytes_[l] += uint48(sizes[i]);
            }
            counts[l] = uint32(end - from);
            leafIds[l] = fileStore.putChunkNode(blob);
        }
        bytes32 root = leafIds[0];
        if (leaves > 1) {
            bytes memory b = abi.encodePacked(uint8(1), uint16(leaves));
            uint32 run;
            uint48 runBytes;
            for (uint256 l; l < leaves; l++) {
                run += counts[l];
                runBytes += bytes_[l];
                b = bytes.concat(b, leafIds[l], bytes4(run), bytes6(runBytes));
            }
            root = fileStore.putChunkNode(b);
        }
        return fileStore.createFile(root, mime, 0, bytes32(0));
    }

    // ---- directories ---------------------------------------------------

    /// @dev One entry leaf; `names` must already be in byte order.
    function writeDir(string[] memory names, bytes32[] memory cids, bool[] memory isDirs) internal returns (bytes32) {
        uint256 n = names.length;
        require(cids.length == n && isDirs.length == n, "length mismatch");
        if (n == 0) return directoryStore.createDirectory(bytes32(0));
        bytes memory offs;
        bytes memory recs;
        for (uint256 i; i < n; i++) {
            offs = bytes.concat(offs, bytes2(uint16(recs.length)));
            recs = bytes.concat(
                recs, bytes1(uint8(bytes(names[i]).length)), bytes(names[i]), bytes1(isDirs[i] ? 0x01 : 0x00), cids[i]
            );
        }
        return directoryStore.createDirectory(
            directoryStore.putEntryNode(bytes.concat(hex"00", bytes2(uint16(n)), offs, recs))
        );
    }

    /// @dev A directory of any size: entry leaves filled up to the 24,575-byte node limit, then branch levels of at most
    ///      128 children, split evenly. `names` must already be in byte order. Written in place, a leaf at a time.
    function writeLargeDir(bytes[] memory names, bytes32[] memory cids, bool[] memory isDirs)
        internal
        returns (bytes32)
    {
        uint256 n = names.length;
        require(cids.length == n && isDirs.length == n, "length mismatch");
        if (n == 0) return directoryStore.createDirectory(bytes32(0));
        bytes32[] memory ids = new bytes32[](n);
        uint256[] memory counts = new uint256[](n);
        uint256 nodes;
        for (uint256 from; from < n; nodes++) {
            // A record is its 2-byte offset, a length byte, the name, a flag byte and the 32-byte CID.
            uint256 end = from;
            uint256 size = 3;
            while (end < n && size + 36 + names[end].length <= 24_575) {
                size += 36 + names[end].length;
                end++;
            }
            ids[nodes] = directoryStore.putEntryNode(_entryLeaf(names, cids, isDirs, from, end, size));
            counts[nodes] = end - from;
            from = end;
        }
        return directoryStore.createDirectory(_entryBranches(ids, counts, nodes));
    }

    function _entryLeaf(
        bytes[] memory names,
        bytes32[] memory cids,
        bool[] memory isDirs,
        uint256 from,
        uint256 end,
        uint256 size
    ) private pure returns (bytes memory blob) {
        blob = new bytes(size);
        blob[1] = bytes1(uint8((end - from) >> 8));
        blob[2] = bytes1(uint8(end - from));
        uint256 at = 3 + 2 * (end - from);
        for (uint256 i = from; i < end; i++) {
            uint256 rel = at - 3 - 2 * (end - from);
            (blob[3 + 2 * (i - from)], blob[4 + 2 * (i - from)]) = (bytes1(uint8(rel >> 8)), bytes1(uint8(rel)));
            bytes memory name = names[i];
            bytes32 cid = cids[i];
            blob[at] = bytes1(uint8(name.length));
            blob[at + 1 + name.length] = isDirs[i] ? bytes1(0x01) : bytes1(0x00);
            assembly ("memory-safe") {
                let p := add(add(blob, 0x20), add(at, 1))
                mcopy(p, add(name, 0x20), mload(name))
                // the CID is the last 32 bytes of the record; nothing after it is written yet
                mstore(add(p, add(mload(name), 1)), cid)
            }
            at += 34 + name.length;
        }
    }

    /// @dev Branch levels of at most 128 children, split evenly, over `nodes` entry nodes; returns the root node.
    function _entryBranches(bytes32[] memory ids, uint256[] memory counts, uint256 nodes) private returns (bytes32) {
        for (uint8 level = 1; nodes > 1; level++) {
            uint256 groups = (nodes + 127) / 128;
            uint256 from;
            for (uint256 g; g < groups; g++) {
                uint256 take = nodes / groups + (g < nodes % groups ? 1 : 0);
                bytes memory b = abi.encodePacked(level, uint16(take));
                uint256 run;
                for (uint256 i = from; i < from + take; i++) {
                    run += counts[i];
                    b = bytes.concat(b, ids[i], bytes4(uint32(run)));
                }
                ids[g] = directoryStore.putEntryNode(b);
                counts[g] = run;
                from += take;
            }
            nodes = groups;
        }
        return ids[0];
    }

    // ---- data ----------------------------------------------------------

    /// @dev Deterministic pseudo-random bytes, matching the JS LCG of the fixture generators:
    ///      seed hash: state = (state*31 + ch) mod 2^32; stream: state = (state*1103515245 + 12345) mod 2^32,
    ///      out[i] = state & 0xff.
    function deterministicBytes(uint256 length, string memory seed) internal pure returns (bytes memory out) {
        uint32 state = 0;
        bytes memory s = bytes(seed);
        for (uint256 i = 0; i < s.length; i++) {
            unchecked {
                state = uint32(state * 31 + uint8(s[i]));
            }
        }
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            unchecked {
                state = uint32(state * 1103515245 + 12345);
                out[i] = bytes1(uint8(state & 0xff));
            }
        }
    }

    /// @dev Highly compressible, block-distinct bytes: runs of 4,096 equal bytes whose value depends on the run and the
    ///      256 KiB block it is in (`byte = (run * 7 + block) & 0xff`). Mirrored by the fixture script.
    function runBytes(uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = bytes1(uint8(((i >> 12) * 7 + (i >> 18)) & 0xff));
        }
    }

    function slice(bytes memory src, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(src, 0x20), start), len)
        }
    }
}
