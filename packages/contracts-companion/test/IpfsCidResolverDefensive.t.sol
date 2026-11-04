// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {IIpfsCidResolver} from "../src/interfaces/IIpfsCidResolver.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {CID} from "@abxfs/protobuf/CID.sol";
import {DagPB} from "@abxfs/protobuf/DagPB.sol";
import {UnixFS} from "@abxfs/protobuf/UnixFS.sol";

/// @notice The resolver's guards, driven from outside its stores.
///
///         The resolver reads three stores through typed addresses and trusts none of what they answer beyond its own
///         checks: sizes that disagree with the chunks, return data in a shape the stores never produce, an entry list
///         that changes between its two passes, a hash precompile that fails. With the real, immutable stores none of
///         that can happen, which is why each guard is defensive; here `vm.mockCall` puts those answers in front of
///         the real resolver, so every guard is shown to fire with the error and arguments it promises (and to stay
///         silent on the honest answer).
///
///         The multi-block expectations come from `protobuf-sol` (`DagPB`, `UnixFS`, `CID`), which the resolver does
///         not use: it encodes its own nodes in assembly. `protobuf-sol` is itself pinned against the IPFS reference
///         libraries' fixtures (`packages/protobuf-sol/test`).
contract IpfsCidResolverDefensiveTest is BaseCompanionTest {
    uint256 internal constant BLOCK = 262_144;

    IpfsCidResolver internal resolver;
    /// @dev A real one-chunk file holding "hello\n" (6 bytes), and its chunk.
    bytes32 internal file;
    bytes32 internal onlyChunk;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
        file = writeFile("hello\n", "text/plain");
        onlyChunk = fileStore.getChunkId(file, 0);
    }

    // ---- helpers -------------------------------------------------------

    function _info() internal view returns (IFileStore.FileInfo memory) {
        return fileStore.getFileInfo(file);
    }

    function _mockInfo(uint256 size, uint256 chunkCount) internal {
        IFileStore.FileInfo memory info = _info();
        info.size = size;
        info.chunkCount = chunkCount;
        vm.mockCall(address(fileStore), abi.encodeCall(IFileStore.getFileInfo, (file)), abi.encode(info));
    }

    function _mockChunkRead(bytes memory data) internal {
        vm.mockCall(address(chunkStore), abi.encodeCall(IChunkStore.read, (onlyChunk)), abi.encode(data));
    }

    function _mockChunkReadRaw(bytes memory raw) internal {
        vm.mockCall(address(chunkStore), abi.encodeCall(IChunkStore.read, (onlyChunk)), raw);
    }

    function _mockIdsRaw(bytes memory raw) internal {
        vm.mockCall(address(fileStore), abi.encodeCall(IFileStore.getChunkIds, (file, 0, 1)), raw);
    }

    function _expectSizeMismatch(uint256 expected, uint256 read) internal {
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.SizeMismatch.selector, file, expected, read));
    }

    // ---- the file's size and its chunks disagree -----------------------

    /// The size the store reports must equal what the chunks hold: more claimed than held, fewer, none held at all.
    function test_sizeLargerThanTheChunksHold() public {
        _mockInfo(10, 1);
        _expectSizeMismatch(10, 6);
        resolver.computeFileCid(file);
        _mockInfo(6, 0);
        _expectSizeMismatch(6, 0);
        resolver.computeFileCid(file);
        // one block more than is there
        _mockInfo(BLOCK + 6, 1);
        _expectSizeMismatch(BLOCK + 6, 6);
        resolver.fileLink(file);
    }

    /// The first chunk that takes the running total past the reported size stops the derivation, with the total
    /// reached so far.
    function test_sizeSmallerThanTheChunksHold() public {
        _mockInfo(3, 1);
        _expectSizeMismatch(3, 6);
        resolver.computeFileCid(file);
        _mockInfo(0, 1);
        _expectSizeMismatch(0, 6);
        resolver.computeFileCid(file);
    }

    /// A chunk read that returns other data than the record's size (the real `ChunkStore` checks that; the resolver
    /// does not rely on it) is caught by the same total, in either direction.
    function test_chunkDataOfAnotherLength() public {
        _mockChunkRead("hello\nworld");
        _expectSizeMismatch(6, 11);
        resolver.computeFileCid(file);
        _mockChunkRead("hel");
        _expectSizeMismatch(6, 3);
        resolver.computeFileCid(file);
        // control: the honest answer derives
        _mockChunkRead("hello\n");
        assertEq(resolver.computeFileCid(file), "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
    }

    // ---- a store reverts, or answers in a shape it never produces ------

    /// Whatever the file store reverts with while listing chunk ids reaches the caller byte for byte.
    function test_chunkIdListingRevertIsPassedUp() public {
        bytes memory err = abi.encodeWithSelector(FileStore.RangeOutOfBounds.selector, 0, 1, 0);
        vm.mockCallRevert(address(fileStore), abi.encodeCall(IFileStore.getChunkIds, (file, 0, 1)), err);
        vm.expectRevert(err);
        resolver.computeFileCid(file);
        // inside a directory too
        bytes32 dir = writeDir(_one("a"), _oneCid(file), new bool[](1));
        vm.expectRevert(err);
        resolver.computeIpfsCid(dir);
    }

    /// The chunk id list must be exactly `bytes32[]` of the requested length, whole: any other shape is `BadReturn`.
    function test_chunkIdListInAnotherShape() public {
        bytes[7] memory shapes = [
            bytes(""), // nothing at all
            abi.encodePacked(uint256(0x20)), // an offset and no length
            abi.encodePacked(uint256(0x40), uint256(1), onlyChunk), // the offset is not 0x20
            abi.encodePacked(uint256(0x20), uint256(2), onlyChunk, onlyChunk), // two ids for a range of one
            abi.encodePacked(uint256(0x20), uint256(0)), // none
            abi.encodePacked(uint256(0x20), uint256(1)), // one promised, none present
            abi.encodePacked(uint256(0x20), uint256(1) << 251) // a length whose byte size wraps to zero
        ];
        for (uint256 i = 0; i < shapes.length; i++) {
            _mockIdsRaw(shapes[i]);
            vm.expectRevert(IIpfsCidResolver.BadReturn.selector);
            resolver.computeFileCid(file);
        }
        // control: the honest answer (trailing bytes after the ids are ignored)
        _mockIdsRaw(abi.encodePacked(uint256(0x20), uint256(1), onlyChunk, uint256(0xdead)));
        assertEq(resolver.computeFileCid(file), "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
    }

    /// A chunk read must be one `bytes` at offset 0x20 with a length no uint48 exceeds, all of it present.
    function test_chunkReadInAnotherShape() public {
        bytes[7] memory shapes = [
            bytes(""), // nothing at all
            abi.encodePacked(uint256(0x20)), // an offset and no length
            abi.encodePacked(uint256(0x40), uint256(6), bytes32("hello\n")), // the offset is not 0x20
            abi.encodePacked(uint256(0x20), uint256(1) << 48, bytes32(0)), // longer than any chunk can be
            abi.encodePacked(uint256(0x20), uint256(6)), // six bytes promised, none present
            // a length that, added to the header size, wraps to a small number: only the bound on the length stops it
            abi.encodePacked(uint256(0x20), type(uint256).max),
            abi.encodePacked(uint256(0x20), type(uint256).max - 0x3f)
        ];
        for (uint256 i = 0; i < shapes.length; i++) {
            _mockChunkReadRaw(shapes[i]);
            vm.expectRevert(IIpfsCidResolver.BadReturn.selector);
            resolver.computeFileCid(file);
        }
        // control: unpadded data that is complete is accepted
        _mockChunkReadRaw(abi.encodePacked(uint256(0x20), uint256(6), bytes6("hello\n")));
        assertEq(resolver.computeFileCid(file), "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
    }

    // ---- a directory whose entries change between the two passes -------

    /// The node is sized from the first pass over the entries and written from the second; a store that answers
    /// differently the second time (a name of another length, or fewer entries) is `BadReturn`, not a node whose
    /// size field and bytes disagree.
    function test_directoryThatChangesBetweenPasses() public {
        bytes32 dir = writeDir(_one("a"), _oneCid(file), new bool[](1));
        string memory want = resolver.computeIpfsCid(dir);

        IDirectoryStore.Entry[] memory same = new IDirectoryStore.Entry[](1);
        same[0] = IDirectoryStore.Entry({name: "a", cid: file, isDirectory: false});
        IDirectoryStore.Entry[] memory longer = new IDirectoryStore.Entry[](1);
        longer[0] = IDirectoryStore.Entry({name: "aa", cid: file, isDirectory: false});
        IDirectoryStore.Entry[] memory shorter = new IDirectoryStore.Entry[](1);
        shorter[0] = IDirectoryStore.Entry({name: "", cid: file, isDirectory: false});
        IDirectoryStore.Entry[] memory none = new IDirectoryStore.Entry[](0);

        bytes memory call_ = abi.encodeCall(IDirectoryStore.getEntries, (dir, 0, 1));
        bytes[] memory seq = new bytes[](2);
        seq[0] = abi.encode(same);

        seq[1] = abi.encode(same); // control: the same answer twice is the real answer
        vm.mockCalls(address(directoryStore), call_, seq);
        assertEq(resolver.computeIpfsCid(dir), want);

        IDirectoryStore.Entry[][3] memory second = [longer, shorter, none];
        for (uint256 i = 0; i < second.length; i++) {
            seq[1] = abi.encode(second[i]);
            vm.mockCalls(address(directoryStore), call_, seq);
            vm.expectRevert(IIpfsCidResolver.BadReturn.selector);
            resolver.computeIpfsCid(dir);
        }
    }

    // ---- the hash precompile fails -------------------------------------

    /// SHA-256 is a precompile that fails only for want of gas. If it does, the derivation reverts with nothing, never
    /// with a digest read from whatever was left at the output word.
    function test_sha256PrecompileFailureReverts() public {
        string memory want = resolver.computeFileCid(file);
        assertEq(want, "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
        vm.mockCallRevert(address(2), bytes("hello\n"), "");
        (bool ok, bytes memory ret) =
            address(resolver).staticcall(abi.encodeCall(IIpfsCidResolver.computeFileCid, (file)));
        assertFalse(ok, "reverts");
        assertEq(ret.length, 0, "with no data");
        vm.clearMockedCalls();
        assertEq(resolver.computeFileCid(file), want, "and the same call works once the precompile does");
    }

    // ---- directories larger than one page of entries --------------------

    /// The resolver reads a directory 64 entries at a time. Directories of 10 to 200 entries, on both sides of every
    /// page edge, mixing files and the empty directory, derive to the node a straightforward `protobuf-sol` encoding of
    /// all the links produces.
    function test_directoryPagingMatchesReference() public {
        uint256[10] memory sizes = [uint256(10), 63, 64, 65, 127, 128, 129, 150, 192, 200];
        for (uint256 i = 0; i < sizes.length; i++) {
            (bytes32 dir, bytes32 digest, uint256 tsize) = _bigDirectory(sizes[i]);
            (uint256 codec, bytes32 gotDigest, uint256 gotTsize) = resolver.directoryLink(dir);
            assertEq(codec, 0x70);
            assertEq(gotDigest, digest, "digest");
            assertEq(gotTsize, tsize, "tsize");
            assertEq(resolver.computeIpfsCid(dir), CID.encode(CID.CODEC_DAG_PB, digest));
        }
    }

    function _bigDirectory(uint256 n) internal returns (bytes32 dir, bytes32 digest, uint256 tsize) {
        string[] memory names = new string[](n);
        bytes32[] memory cids = new bytes32[](n);
        bool[] memory isDirs = new bool[](n);
        DagPB.Link[] memory links = new DagPB.Link[](n);
        uint256 childSum;
        for (uint256 i; i < n; i++) {
            names[i] = string(abi.encodePacked("e", _three(i)));
            uint256 childSize;
            if (i % 10 == 9) {
                (cids[i], isDirs[i], childSize) = (directoryStore.EMPTY_DIRECTORY(), true, 4);
                links[i].hash = CID.binary(CID.CODEC_DAG_PB, sha256(hex"0a020801"));
            } else {
                (cids[i], childSize) = (file, 6);
                links[i].hash = CID.binary(CID.CODEC_RAW, sha256("hello\n"));
            }
            links[i].name = names[i];
            links[i].tsize = childSize;
            childSum += childSize;
        }
        dir = writeDir(names, cids, isDirs);
        bytes memory node = DagPB.encodeNode(links, UnixFS.directoryData());
        return (dir, sha256(node), node.length + childSum);
    }

    // ---- layouts: the same content, however the chunks cut it ------------

    /// Sizes at and around block edges, with chunk layouts from one chunk to eight.
    function test_layoutsAtBlockEdges() public {
        uint256[10] memory sizes = [
            uint256(1), BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK - 1, 2 * BLOCK, 2 * BLOCK + 1, 3 * BLOCK, 3 * BLOCK + 7, 5
        ];
        for (uint256 i = 0; i < sizes.length; i++) {
            for (uint256 seed = 0; seed < 4; seed++) {
                // an external self-call, so each layout gets a fresh memory arena (a megabyte of content each)
                this.checkLayout(sizes[i], seed * 0x9e3779b97f4a7c15 + i);
            }
        }
    }

    /// The empty file has no chunks and the sha-256 of nothing.
    function test_layoutOfTheEmptyFile() public {
        _checkLayout(0, 1);
        _mockInfo(0, 0);
        (uint256 codec, bytes32 digest, uint256 tsize) = resolver.fileLink(file);
        assertEq(codec, 0x55);
        assertEq(digest, sha256(""));
        assertEq(tsize, 0);
    }

    /// For any content and any way of cutting it into chunks (including chunks larger than a block, and block edges
    /// falling inside, between or exactly on chunk edges) the resolver derives the reference node. Once the total equals
    /// the size, the number of blocks hashed is forced to be ceil(size / block) (one for the empty file), exactly the
    /// number of digests it allocated, which is why the resolver no longer checks that count: the check could not fire.
    function testFuzz_layoutsDeriveTheReference(uint256 sizeSeed, uint256 splitSeed) public {
        uint256 size = bound(sizeSeed, 0, 800_000);
        if (splitSeed % 4 == 0) size = size / BLOCK * BLOCK; // exact multiples of the block
        _checkLayout(size, splitSeed);
    }

    function checkLayout(uint256 size, uint256 seed) external {
        _checkLayout(size, seed);
    }

    /// @dev Present `size` bytes of deterministic content to the resolver as a file cut into 1 to 8 chunks
    ///      (sizes drawn from `seed`), and compare its answer with the reference derivation of the whole content.
    function _checkLayout(uint256 size, uint256 seed) internal {
        bytes memory content = _content(size);
        uint256[] memory lens = _split(size, seed);
        _mockLayout(content, lens);
        (uint256 codec, bytes32 digest, uint256 tsize) = resolver.fileLink(file);
        (uint256 refCodec, bytes32 refDigest, uint256 refTsize) = _reference(content);
        assertEq(codec, refCodec, "codec");
        assertEq(digest, refDigest, "digest");
        assertEq(tsize, refTsize, "tsize");
        assertEq(
            resolver.computeFileCid(file),
            CID.encode(refCodec, refDigest),
            "the string form agrees with the parts"
        );
        vm.clearMockedCalls();
    }

    function _mockLayout(bytes memory content, uint256[] memory lens) internal {
        _mockInfo(content.length, lens.length);
        if (lens.length == 0) return;
        bytes32[] memory ids = new bytes32[](lens.length);
        uint256 off;
        for (uint256 i; i < lens.length; i++) {
            ids[i] = keccak256(abi.encode("synthetic chunk", i));
            vm.mockCall(
                address(chunkStore),
                abi.encodeCall(IChunkStore.read, (ids[i])),
                abi.encode(slice(content, off, lens[i]))
            );
            off += lens[i];
        }
        vm.mockCall(
            address(fileStore), abi.encodeCall(IFileStore.getChunkIds, (file, 0, lens.length)), abi.encode(ids)
        );
    }

    /// @dev What a straightforward encoding derives for `content`: a raw block up to one block, else a dag-pb root over
    ///      raw blocks (at most 174 of them here).
    function _reference(bytes memory content) internal pure returns (uint256 codec, bytes32 digest, uint256 tsize) {
        uint256 len = content.length;
        if (len <= BLOCK) return (CID.CODEC_RAW, sha256(content), len);
        uint256 blocks = (len + BLOCK - 1) / BLOCK;
        DagPB.Link[] memory links = new DagPB.Link[](blocks);
        uint256[] memory sizes = new uint256[](blocks);
        for (uint256 i; i < blocks; i++) {
            sizes[i] = i + 1 == blocks ? len - i * BLOCK : BLOCK;
            links[i] = DagPB.Link({
                hash: CID.binary(CID.CODEC_RAW, sha256(slice(content, i * BLOCK, sizes[i]))),
                name: "",
                tsize: sizes[i]
            });
        }
        bytes memory node = DagPB.encodeNode(links, UnixFS.fileDataWithBlocksizes(len, sizes));
        return (CID.CODEC_DAG_PB, sha256(node), node.length + len);
    }

    /// @dev `size` bytes that differ from one 4 KiB section to the next. Written a word at a time; the last word may
    ///      spill into the allocation's padding, which is inside the memory `new bytes(size)` reserved.
    function _content(uint256 size) internal pure returns (bytes memory out) {
        out = new bytes(size);
        for (uint256 s; s * 4096 < size; s++) {
            bytes32 word = keccak256(abi.encode("section", s));
            uint256 end = (s + 1) * 4096 < size ? (s + 1) * 4096 : size;
            for (uint256 p = s * 4096; p < end; p += 32) {
                assembly ("memory-safe") {
                    mstore(add(add(out, 0x20), p), word)
                }
            }
        }
    }

    /// @dev Cut `size` into between 1 and 8 chunks of at least one byte each (none for an empty file).
    function _split(uint256 size, uint256 seed) internal pure returns (uint256[] memory lens) {
        if (size == 0) return new uint256[](0);
        uint256 n = 1 + seed % 8;
        if (n > size) n = size;
        lens = new uint256[](n);
        uint256 remaining = size;
        for (uint256 i; i + 1 < n; i++) {
            uint256 room = remaining - (n - 1 - i); // leave one byte for each chunk still to come
            lens[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % room;
            remaining -= lens[i];
        }
        lens[n - 1] = remaining;
    }

    // ---- small builders ------------------------------------------------

    function _one(string memory a) internal pure returns (string[] memory n) {
        n = new string[](1);
        n[0] = a;
    }

    function _oneCid(bytes32 a) internal pure returns (bytes32[] memory c) {
        c = new bytes32[](1);
        c[0] = a;
    }

    function _three(uint256 v) internal pure returns (bytes memory b) {
        b = new bytes(3);
        for (uint256 i = 3; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
    }
}
