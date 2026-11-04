// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {LibZip} from "solady/utils/LibZip.sol";

import {ChunkStore} from "../src/ChunkStore.sol";
import {IChunkStore} from "../src/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "../src/interfaces/IDirectoryStore.sol";
import {IFileStore} from "../src/interfaces/IFileStore.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {CodeStore} from "../src/utils/CodeStore.sol";
import {Sstore2Backend} from "../src/backends/Sstore2Backend.sol";
import {FastLzSstore2Backend} from "../src/backends/FastLzSstore2Backend.sol";
import {NodeTree} from "../src/NodeTree.sol";
import {FileStore} from "../src/FileStore.sol";
import {DirectoryStore} from "../src/DirectoryStore.sol";
import {LogBackend} from "./mocks/Backends.sol";

contract StoresTest is Test {
    ChunkStore internal chunks;
    Sstore2Backend internal raw;
    FastLzSstore2Backend internal flz;
    LogBackend internal logBackend;
    FileStore internal files;
    DirectoryStore internal dirs;

    function setUp() public {
        chunks = new ChunkStore();
        raw = new Sstore2Backend();
        flz = new FastLzSstore2Backend();
        logBackend = new LogBackend();
        files = new FileStore(address(chunks));
        dirs = new DirectoryStore(address(files));
    }

    // ---- helpers -------------------------------------------------------

    /// @dev Chunk `i` holds `"chunk-" || uint256(i)` padded to a size that varies with `i` (38..38+i%5 bytes).
    function _chunkData(uint256 i) internal pure returns (bytes memory) {
        return bytes.concat(abi.encodePacked("chunk-", i), new bytes(i % 5));
    }

    function _chunk(uint256 i) internal returns (bytes32) {
        bytes memory d = _chunkData(i);
        return chunks.write(address(raw), d, keccak256(d), uint48(d.length));
    }

    function _rec(uint256 i) internal returns (bytes memory) {
        return abi.encodePacked(_chunk(i), uint48(_chunkData(i).length));
    }

    function _chunkLeaf(uint256 from, uint256 n) internal returns (bytes32 id, bytes memory blob) {
        blob = hex"00";
        for (uint256 i = 0; i < n; i++) {
            blob = bytes.concat(blob, _rec(from + i));
        }
        id = files.putChunkNode(blob);
    }

    /// @dev A file branch: cumulative counts as given, cumulative bytes read from the children themselves.
    function _fbranch(uint8 level, bytes32[] memory ids, uint32[] memory counts) internal view returns (bytes memory b) {
        b = abi.encodePacked(level, uint16(ids.length));
        uint32 run;
        uint48 runBytes;
        for (uint256 i = 0; i < ids.length; i++) {
            run += counts[i];
            if (files.nodeExists(ids[i])) {
                (,,, uint48 size) = files.getNode(ids[i]);
                runBytes += size;
            }
            b = bytes.concat(b, abi.encodePacked(ids[i], run, runBytes));
        }
    }

    function _branch(uint8 level, bytes32[] memory ids, uint32[] memory counts) internal pure returns (bytes memory b) {
        b = abi.encodePacked(level, uint16(ids.length));
        uint32 run;
        for (uint256 i = 0; i < ids.length; i++) {
            run += counts[i];
            b = bytes.concat(b, abi.encodePacked(ids[i], run));
        }
    }

    function _file(string memory body) internal returns (bytes32) {
        bytes memory d = bytes(body);
        bytes32 h = chunks.write(address(raw), d, keccak256(d), uint48(d.length));
        bytes32 leaf = files.putChunkNode(abi.encodePacked(hex"00", h, uint48(d.length)));
        return files.createFile(leaf, "text/plain", 0, bytes32(0));
    }

    struct E {
        string name;
        bytes32 cid;
        bool dir;
    }

    function _leafBlob(E[] memory es) internal pure returns (bytes memory) {
        bytes memory offs;
        bytes memory recs;
        for (uint256 i = 0; i < es.length; i++) {
            offs = bytes.concat(offs, bytes2(uint16(recs.length)));
            recs = bytes.concat(
                recs, bytes1(uint8(bytes(es[i].name).length)), bytes(es[i].name), bytes1(es[i].dir ? 1 : 0), es[i].cid
            );
        }
        return bytes.concat(hex"00", bytes2(uint16(es.length)), offs, recs);
    }

    function _names(uint256 from, uint256 n, bytes32 cid) internal pure returns (E[] memory es) {
        es = new E[](n);
        for (uint256 i = 0; i < n; i++) {
            // zero padded decimal => sorted byte order matches numeric order
            es[i] = E({name: string(abi.encodePacked("f", _pad(from + i))), cid: cid, dir: false});
        }
    }

    function _pad(uint256 v) internal pure returns (bytes memory b) {
        b = new bytes(8);
        for (uint256 i = 8; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
    }

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory o) {
        o = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            o[i] = b[i];
        }
    }

    // ---- files ---------------------------------------------------------

    function test_file_singleLeaf() public {
        (bytes32 leaf,) = _chunkLeaf(0, 3);
        bytes32 cid = files.createFile(leaf, "text/plain", 0, bytes32(0));
        assertEq(cid, files.fileCid(leaf, "text/plain", 0, bytes32(0)));
        assertEq(
            cid, keccak256(abi.encodePacked(bytes1(0x31), leaf, keccak256("text/plain"), bytes32(0), bytes32(0)))
        );
        assertTrue(files.fileExists(cid));
        assertEq(files.chunkCount(cid), 3);
        assertEq(files.getChunkId(cid, 1), _chunk(1));
        bytes32[] memory hs = files.getChunkIds(cid, 1, 3);
        assertEq(hs.length, 2);
        assertEq(hs[1], _chunk(2));
        assertEq(files.readChunk(cid, 2), _chunkData(2));
        assertEq(files.getFileInfo(cid).size, _chunkData(0).length + _chunkData(1).length + _chunkData(2).length);
        assertEq(files.createFile(leaf, "text/plain", 0, bytes32(0)), cid);
        assertFalse(files.fileExists(bytes32(uint256(1))));
    }

    function test_file_branchAcrossLeaves() public {
        (bytes32 a,) = _chunkLeaf(0, 4);
        (bytes32 b,) = _chunkLeaf(4, 3);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
        uint32[] memory cs = new uint32[](2);
        cs[0] = 4;
        cs[1] = 3;
        bytes32 root = files.putChunkNode(_fbranch(1, ids, cs));
        bytes32 cid = files.createFile(root, "image/png", 0, bytes32(0));
        assertEq(files.chunkCount(cid), 7);
        for (uint256 i = 0; i < 7; i++) {
            assertEq(files.getChunkId(cid, i), _chunk(i));
        }
        vm.expectRevert();
        files.getChunkId(cid, 7);
        // two-level: a level-2 branch over two level-1 branches
        (bytes32 c,) = _chunkLeaf(7, 1);
        (bytes32 d,) = _chunkLeaf(8, 1);
        bytes32[] memory ids3 = new bytes32[](2);
        ids3[0] = c;
        ids3[1] = d;
        uint32[] memory cs3 = new uint32[](2);
        cs3[0] = 1;
        cs3[1] = 1;
        bytes32 rb = files.putChunkNode(_fbranch(1, ids3, cs3));
        bytes32[] memory ids2 = new bytes32[](2);
        ids2[0] = root;
        ids2[1] = rb;
        uint32[] memory cs2 = new uint32[](2);
        cs2[0] = 7;
        cs2[1] = 2;
        bytes32 root2 = files.putChunkNode(_fbranch(2, ids2, cs2));
        bytes32 cid2 = files.createFile(root2, "image/png", 0, bytes32(0));
        assertEq(files.chunkCount(cid2), 9);
        for (uint256 i = 0; i < 9; i++) {
            assertEq(files.getChunkId(cid2, i), _chunk(i));
        }
        bytes32[] memory all = files.getChunkIds(cid2, 0, 9);
        for (uint256 i = 0; i < 9; i++) {
            assertEq(all[i], _chunk(i));
        }
        assertTrue(cid2 != cid);
    }

    function test_file_rejects() public {
        // missing chunk
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.ChunkNotFound.selector, bytes32(uint256(5))));
        files.putChunkNode(abi.encodePacked(hex"00", bytes32(uint256(5)), uint48(1)));
        // a recorded size that is not the chunk's
        bytes32 h0 = _chunk(0);
        vm.expectRevert(abi.encodeWithSelector(FileStore.ChunkSizeMismatch.selector, h0, 38, 39));
        files.putChunkNode(abi.encodePacked(hex"00", h0, uint48(39)));
        vm.expectRevert(abi.encodeWithSelector(FileStore.ChunkSizeMismatch.selector, h0, 38, 0));
        files.putChunkNode(abi.encodePacked(hex"00", h0, uint48(0)));
        // a 34-byte stride (a 2-byte size) is refused
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(abi.encodePacked(hex"00", h0, uint16(38)));
        // empty / ragged leaf
        vm.expectRevert(NodeTree.NodeEmpty.selector);
        files.putChunkNode("");
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(hex"00");
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(bytes.concat(hex"00", bytes32(0), hex"01"));
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(bytes.concat(hex"00", bytes32(0), hex"00000001ff"));
        // too large
        vm.expectRevert(abi.encodeWithSelector(NodeTree.NodeTooLarge.selector, 24_576));
        files.putChunkNode(new bytes(24_576));

        (bytes32 a,) = _chunkLeaf(0, 2);
        (bytes32 a2,) = _chunkLeaf(10, 2);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = a2;
        uint32[] memory cs = new uint32[](2);
        cs[0] = 3; // wrong count
        cs[1] = 2;
        bytes memory fb1 = _fbranch(1, ids, cs);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.CountMismatch.selector, 0));
        files.putChunkNode(fb1);
        cs[0] = 2;
        // wrong cumulative bytes
        bytes memory wb = _fbranch(1, ids, cs);
        wb[3 + 42 + 41] = bytes1(uint8(wb[3 + 42 + 41]) ^ 1);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.BytesMismatch.selector, 1));
        files.putChunkNode(wb);
        // a directory-shaped (36-byte stride) branch is refused by the file store
        bytes memory dshape = abi.encodePacked(uint8(1), uint16(2), a, uint32(2), a2, uint32(4));
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(dshape);
        // a single-child branch is refused (no wrapper CIDs)
        bytes32[] memory one = new bytes32[](1);
        one[0] = a;
        uint32[] memory onec = new uint32[](1);
        onec[0] = 2;
        bytes memory fb2 = _fbranch(1, one, onec);
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(fb2);
        bytes memory lvl2 = _fbranch(2, ids, cs);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.LevelMismatch.selector, a, 1, 0)); // level-2 over a leaf
        files.putChunkNode(lvl2);
        ids[0] = bytes32(uint256(9));
        bytes memory fb3 = _fbranch(1, ids, cs);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.NodeMissing.selector, bytes32(uint256(9))));
        files.putChunkNode(fb3);
        // level > max
        bytes memory fb4 = _fbranch(4, ids, cs);
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(fb4);
        // metadata rules
        vm.expectRevert(FileStore.InvalidMimeType.selector);
        files.createFile(a, "", 0, bytes32(0));
        vm.expectRevert(FileStore.InvalidMimeType.selector);
        files.createFile(a, string(new bytes(128)), 0, bytes32(0));
        vm.expectRevert(FileStore.InvalidCodec.selector);
        files.createFile(a, "a/b", 0, bytes32(uint256(1)));
        vm.expectRevert(FileStore.InvalidCodec.selector);
        files.createFile(a, "a/b", bytes32("gzip"), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(NodeTree.NodeMissing.selector, bytes32(uint256(77))));
        files.createFile(bytes32(uint256(77)), "a/b", 0, bytes32(0));
    }

    function test_file_cidBindsMetadata() public {
        (bytes32 a,) = _chunkLeaf(0, 2);
        bytes32 c1 = files.createFile(a, "a/b", 0, bytes32(0));
        bytes32 c2 = files.createFile(a, "a/c", 0, bytes32(0));
        bytes32 c3 = files.createFile(a, "a/b", bytes32("gzip"), bytes32(uint256(1)));
        bytes32 c4 = files.createFile(a, "a/b", bytes32("br"), bytes32(uint256(1)));
        assertTrue(c1 != c2 && c1 != c3 && c2 != c3 && c3 != c4);
        assertEq(files.getFileInfo(c3).codec, bytes32("gzip"));
        assertEq(files.getFileInfo(c3).outputHash, bytes32(uint256(1)));
        assertEq(files.getFileInfo(c1).codec, bytes32(0));
    }

    /// A file mixes backends freely: raw, FastLZ (inflated on chain) and one the EVM cannot read.
    function test_file_mixedBackends() public {
        bytes memory text = new bytes(30_000);
        for (uint256 i; i < text.length; i++) text[i] = bytes1(uint8(97 + (i % 13)));
        bytes memory packed = LibZip.flzCompress(text);
        bytes32 cRaw = _chunk(1);
        bytes32 cFlz = chunks.write(address(flz), packed, keccak256(text), uint48(text.length));
        bytes32 cLog = chunks.write(address(logBackend), "log input", keccak256("log data"), 70_000);
        bytes32 leaf = files.putChunkNode(
            abi.encodePacked(
                hex"00", cRaw, uint48(_chunkData(1).length), cFlz, uint48(30_000), cLog, uint48(70_000)
            )
        );
        bytes32 cid = files.createFile(leaf, "application/octet-stream", 0, bytes32(0));
        assertEq(files.getFileInfo(cid).size, _chunkData(1).length + 30_000 + 70_000);
        assertEq(files.readChunk(cid, 0), _chunkData(1));
        assertEq(files.readChunk(cid, 1), text, "FastLZ chunk comes back inflated");
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, cLog, address(logBackend)));
        files.readChunk(cid, 2);
        // Sizes above 65,535 bytes are representable and seekable.
        (uint256 idx, uint256 start, bytes32 id, uint256 size) = files.locateByte(cid, 39 + 30_000 + 69_999);
        assertEq(idx, 2);
        assertEq(start, 39 + 30_000);
        assertEq(id, cLog);
        assertEq(size, 70_000);
    }

    function test_file_byteTotalOverflow() public {
        uint48 max = type(uint48).max;
        bytes32 big1 = chunks.write(address(logBackend), "a", keccak256("a"), max);
        bytes32 big2 = chunks.write(address(logBackend), "b", keccak256("b"), max);
        files.putChunkNode(abi.encodePacked(hex"00", big1, max)); // exactly the cap is fine
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(abi.encodePacked(hex"00", big1, max, big2, max));
    }

    // ---- the empty file ------------------------------------------------

    function test_emptyFile() public {
        bytes32 cid = files.createFile(bytes32(0), "text/plain", 0, bytes32(0));
        assertEq(cid, files.fileCid(bytes32(0), "text/plain", 0, bytes32(0)));
        assertTrue(files.fileExists(cid));
        FileStoreInfo.check(files, cid);
        assertEq(files.chunkCount(cid), 0);
        assertEq(files.getChunkIds(cid, 0, 0).length, 0);
        vm.expectRevert(abi.encodeWithSelector(FileStore.RangeOutOfBounds.selector, 0, 1, 0));
        files.getChunkIds(cid, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.IndexOutOfRange.selector, 0, 0));
        files.getChunkId(cid, 0);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.IndexOutOfRange.selector, 0, 0));
        files.readChunk(cid, 0);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.OffsetOutOfRange.selector, 0, 0));
        files.locateByte(cid, 0);
        // one empty file per MIME type, created idempotently, never with a codec
        assertTrue(files.createFile(bytes32(0), "text/css", 0, bytes32(0)) != cid);
        assertEq(files.createFile(bytes32(0), "text/plain", 0, bytes32(0)), cid);
        vm.expectRevert(FileStore.InvalidCodec.selector);
        files.createFile(bytes32(0), "text/plain", bytes32("gzip"), bytes32(uint256(1)));
        // an unknown cid is still not a file
        vm.expectRevert(abi.encodeWithSelector(FileStore.FileNotFound.selector, bytes32(uint256(3))));
        files.getFileInfo(bytes32(uint256(3)));
    }

    // ---- directories ---------------------------------------------------

    function test_dir_basicAndLookup() public {
        bytes32 f = _file("hi");
        E[] memory es = _names(0, 5, f);
        bytes32 leaf = dirs.putEntryNode(_leafBlob(es));
        bytes32 cid = dirs.createDirectory(leaf);
        assertEq(cid, keccak256(abi.encodePacked(bytes1(0x32), leaf)));
        assertTrue(dirs.directoryExists(cid));
        assertEq(dirs.entryCount(cid), 5);
        IDirectoryStore.Entry memory e = dirs.getEntry(cid, 3);
        assertEq(e.name, "f00000003");
        assertEq(e.cid, f);
        (bytes32 c, bool d) = dirs.lookup(cid, "f00000004");
        assertEq(c, f);
        assertFalse(d);
        vm.expectRevert();
        dirs.lookup(cid, "nope");
        vm.expectRevert();
        dirs.lookup(cid, "f00000009");
        assertEq(dirs.createDirectory(leaf), cid);
    }

    function test_dir_rejects() public {
        bytes32 f = _file("hi");
        E[] memory es = new E[](2);
        es[0] = E("b", f, false);
        es[1] = E("a", f, false);
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_leafBlob(es));
        es[1] = E("b", f, false);
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_leafBlob(es));

        string[7] memory bad = [".", "..", "a/b", "a\\b", "", "x/", "/"];
        for (uint256 i = 0; i < bad.length; i++) {
            E[] memory one = new E[](1);
            one[0] = E(bad[i], f, false);
            vm.expectRevert();
            dirs.putEntryNode(_leafBlob(one));
        }
        // 255 NULs are a valid name (nameLen is one byte, so 256 cannot be encoded)
        E[] memory big = new E[](1);
        big[0] = E(string(new bytes(255)), f, false);
        dirs.putEntryNode(_leafBlob(big));
        // missing child / child must be the right kind
        E[] memory m = new E[](1);
        m[0] = E("a", bytes32(uint256(1)), false);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.CidNotFound.selector, bytes32(uint256(1))));
        dirs.putEntryNode(_leafBlob(m));
        m[0] = E("a", f, true); // a file cid claimed as directory
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.CidNotFound.selector, f));
        dirs.putEntryNode(_leafBlob(m));
        m[0] = E("a", dirs.EMPTY_DIRECTORY(), false); // the empty directory claimed as a file
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.CidNotFound.selector, dirs.EMPTY_DIRECTORY()));
        dirs.putEntryNode(_leafBlob(m));
        // flag byte 2, trailing byte, wrong offset, count 0
        E[] memory ok = new E[](1);
        ok[0] = E("a", f, false);
        bytes memory good = _leafBlob(ok);
        bytes memory flag2 = bytes.concat(good);
        flag2[good.length - 33] = 0x02;
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(flag2);
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(bytes.concat(good, hex"00"));
        bytes memory off = bytes.concat(good);
        off[4] = 0x01;
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(off);
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(hex"0000");
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(hex"000000");
        // truncated record
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(_slice(good, good.length - 1));
        // a root that does not exist
        vm.expectRevert(abi.encodeWithSelector(NodeTree.NodeMissing.selector, bytes32(uint256(5))));
        dirs.createDirectory(bytes32(uint256(5)));
    }

    function test_dir_branchOrderAndNested() public {
        bytes32 f = _file("hi");
        bytes32 l1 = dirs.putEntryNode(_leafBlob(_names(0, 4, f)));
        bytes32 l2 = dirs.putEntryNode(_leafBlob(_names(4, 4, f)));
        bytes32 l3 = dirs.putEntryNode(_leafBlob(_names(2, 4, f))); // overlaps l1
        bytes32[] memory ids = new bytes32[](2);
        uint32[] memory cs = new uint32[](2);
        cs[0] = 4;
        cs[1] = 4;
        ids[0] = l2;
        ids[1] = l1; // reversed
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_branch(1, ids, cs));
        ids[0] = l1;
        ids[1] = l3; // overlap
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_branch(1, ids, cs));
        ids[1] = l2;
        bytes32 root = dirs.putEntryNode(_branch(1, ids, cs));
        bytes32 cid = dirs.createDirectory(root);
        assertEq(dirs.entryCount(cid), 8);
        for (uint256 i = 0; i < 8; i++) {
            assertEq(dirs.getEntry(cid, i).name, string(abi.encodePacked("f", _pad(i))));
            (bytes32 c,) = dirs.lookup(cid, string(abi.encodePacked("f", _pad(i))));
            assertEq(c, f);
        }
        IDirectoryStore.Entry[] memory page = dirs.getEntries(cid, 2, 6);
        assertEq(page.length, 4);
        assertEq(page[3].name, "f00000005");

        // nested directory + resolvePath
        E[] memory top = new E[](2);
        top[0] = E("a.txt", f, false);
        top[1] = E("sub", cid, true);
        bytes32 topCid = dirs.createDirectory(dirs.putEntryNode(_leafBlob(top)));
        (bytes32 got, bool isDir) = dirs.resolvePath(topCid, "sub/f00000006");
        assertEq(got, f);
        assertFalse(isDir);
        (got, isDir) = dirs.resolvePath(topCid, "sub");
        assertEq(got, cid);
        assertTrue(isDir);
        vm.expectRevert();
        dirs.resolvePath(topCid, "a.txt/x");
        vm.expectRevert();
        dirs.resolvePath(topCid, "/sub");
        vm.expectRevert();
        dirs.resolvePath(topCid, "sub//x");
    }

    function test_dir_unknownCidNotAccepted() public {
        bytes32 f = _file("hi");
        E[] memory es = new E[](1);
        es[0] = E("d", keccak256("some other directory"), true);
        vm.expectRevert();
        dirs.putEntryNode(_leafBlob(es));
        assertFalse(dirs.directoryExists(f));
        assertFalse(files.fileExists(keccak256("x")));
    }

    // ---- the empty directory -------------------------------------------

    function test_emptyDirectory() public {
        bytes32 empty = dirs.EMPTY_DIRECTORY();
        assertEq(empty, keccak256(abi.encodePacked(bytes1(0x32), bytes32(0))));
        assertTrue(dirs.directoryExists(empty), "exists without being created");
        assertEq(dirs.createDirectory(bytes32(0)), empty);
        assertEq(dirs.directoryCid(bytes32(0)), empty);
        assertEq(dirs.rootOf(empty), bytes32(0));
        assertEq(dirs.entryCount(empty), 0);
        assertEq(dirs.getEntries(empty, 0, 0).length, 0);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.RangeOutOfBounds.selector, 0, 1, 0));
        dirs.getEntries(empty, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.IndexOutOfRange.selector, 0, 0));
        dirs.getEntry(empty, 0);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "a"));
        dirs.lookup(empty, "a");
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "a"));
        dirs.resolvePath(empty, "a");

        // As a child, next to an empty file
        bytes32 emptyFile = files.createFile(bytes32(0), "text/plain", 0, bytes32(0));
        E[] memory es = new E[](2);
        es[0] = E(".nojekyll", emptyFile, false);
        es[1] = E("e", empty, true);
        bytes32 top = dirs.createDirectory(dirs.putEntryNode(_leafBlob(es)));
        (bytes32 got, bool isDir) = dirs.resolvePath(top, "e");
        assertEq(got, empty);
        assertTrue(isDir);
        (got, isDir) = dirs.resolvePath(top, ".nojekyll");
        assertEq(got, emptyFile);
        assertFalse(isDir);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "e/x"));
        dirs.resolvePath(top, "e/x");
        // an unknown cid is still not a directory
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.DirectoryNotFound.selector, bytes32(uint256(4))));
        dirs.entryCount(bytes32(uint256(4)));
    }

    // ---- larger shapes and gas ------------------------------------------

    function test_dir_largeTwoLevelGas() public {
        bytes32 f = _file("hi");
        uint256 leaves = 6;
        uint256 per = 300;
        bytes32[] memory ids = new bytes32[](leaves);
        uint32[] memory cs = new uint32[](leaves);
        uint256 gasLeaf;
        for (uint256 l = 0; l < leaves; l++) {
            bytes memory blob = _leafBlob(_names(l * per, per, f));
            uint256 g = gasleft();
            ids[l] = dirs.putEntryNode(blob);
            if (l == 0) gasLeaf = g - gasleft();
            cs[l] = uint32(per);
        }
        uint256 g2 = gasleft();
        bytes32 root = dirs.putEntryNode(_branch(1, ids, cs));
        uint256 gasBranch = g2 - gasleft();
        bytes32 cid = dirs.createDirectory(root);
        emit log_named_uint("gas: 300-entry leaf (9-byte names)", gasLeaf);
        emit log_named_uint("gas: 6-child branch", gasBranch);
        assertEq(dirs.entryCount(cid), 1800);
        uint256 g3 = gasleft();
        dirs.lookup(cid, "f00001234");
        emit log_named_uint("gas: lookup in 1800", g3 - gasleft());
        assertEq(dirs.getEntry(cid, 1799).name, "f00001799");
    }

    function testFuzz_dir_lookupEveryEntry(uint8 leafCount, uint8 perLeaf) public {
        leafCount = uint8(bound(leafCount, 1, 5));
        perLeaf = uint8(bound(perLeaf, 1, 12));
        bytes32 f = _file("hi");
        bytes32[] memory ids = new bytes32[](leafCount);
        uint32[] memory cs = new uint32[](leafCount);
        for (uint256 l = 0; l < leafCount; l++) {
            ids[l] = dirs.putEntryNode(_leafBlob(_names(l * perLeaf, perLeaf, f)));
            cs[l] = perLeaf;
        }
        bytes32 root = leafCount == 1 ? ids[0] : dirs.putEntryNode(_branch(1, ids, cs));
        bytes32 cid = dirs.createDirectory(root);
        uint256 total = uint256(leafCount) * perLeaf;
        assertEq(dirs.entryCount(cid), total);
        for (uint256 i = 0; i < total; i++) {
            string memory n = string(abi.encodePacked("f", _pad(i)));
            assertEq(dirs.getEntry(cid, i).name, n);
            (bytes32 c,) = dirs.lookup(cid, n);
            assertEq(c, f);
        }
        vm.expectRevert();
        dirs.lookup(cid, string(abi.encodePacked("f", _pad(total))));
    }

    function test_file_largestLeaf() public {
        uint256 n = 646; // (24,575 - 1) / 38
        bytes memory blob = hex"00";
        for (uint256 i = 0; i < n; i++) {
            blob = bytes.concat(blob, _rec(i));
        }
        assertEq(blob.length, 24_549);
        uint256 g = gasleft();
        files.putChunkNode(blob);
        emit log_named_uint("gas: 646-chunk leaf", g - gasleft());
        bytes memory over = bytes.concat(blob, _rec(n));
        vm.expectRevert(abi.encodeWithSelector(NodeTree.NodeTooLarge.selector, 24_587));
        files.putChunkNode(over);
    }

    function test_file_locateByte() public {
        // four leaves under two level-1 branches, then a level-2 root: every byte maps to the right chunk
        (bytes32 a,) = _chunkLeaf(0, 3);
        (bytes32 b,) = _chunkLeaf(3, 4);
        (bytes32 c,) = _chunkLeaf(7, 2);
        (bytes32 d,) = _chunkLeaf(9, 5);
        bytes32[] memory ids = new bytes32[](2);
        uint32[] memory cs = new uint32[](2);
        ids[0] = a;
        ids[1] = b;
        cs[0] = 3;
        cs[1] = 4;
        bytes32 l1a = files.putChunkNode(_fbranch(1, ids, cs));
        ids[0] = c;
        ids[1] = d;
        cs[0] = 2;
        cs[1] = 5;
        bytes32 l1b = files.putChunkNode(_fbranch(1, ids, cs));
        ids[0] = l1a;
        ids[1] = l1b;
        cs[0] = 7;
        cs[1] = 7;
        bytes32 cid = files.createFile(files.putChunkNode(_fbranch(2, ids, cs)), "video/mp4", 0, bytes32(0));
        uint256 total;
        for (uint256 i = 0; i < 14; i++) total += _chunkData(i).length;
        assertEq(files.getFileInfo(cid).size, total);
        uint256 start;
        for (uint256 i = 0; i < 14; i++) {
            uint256 len = _chunkData(i).length;
            for (uint256 o = start; o < start + len; o += len - 1 > 0 ? len - 1 : 1) {
                (uint256 idx, uint256 cstart, bytes32 h, uint256 size) = files.locateByte(cid, o);
                assertEq(idx, i);
                assertEq(cstart, start);
                assertEq(h, _chunk(i));
                assertEq(size, len);
            }
            start += len;
        }
        vm.expectRevert(abi.encodeWithSelector(NodeTree.OffsetOutOfRange.selector, total, total));
        files.locateByte(cid, total);
        uint256 g = gasleft();
        files.locateByte(cid, total - 1);
        emit log_named_uint("gas: locateByte, two levels", g - gasleft());
    }

    function test_dir_fullBranchGasAndLimits() public {
        bytes32 f = _file("hi");
        uint256 n = 128;
        bytes32[] memory ids = new bytes32[](n);
        uint32[] memory cs = new uint32[](n);
        for (uint256 l = 0; l < n; l++) {
            ids[l] = dirs.putEntryNode(_leafBlob(_names(l, 1, f)));
            cs[l] = 1;
        }
        uint256 g = gasleft();
        bytes32 root = dirs.putEntryNode(_branch(1, ids, cs));
        emit log_named_uint("gas: 128-child directory branch", g - gasleft());
        assertEq(dirs.entryCount(dirs.createDirectory(root)), n);

        // 129 children is refused
        bytes32[] memory ids2 = new bytes32[](129);
        uint32[] memory cs2 = new uint32[](129);
        for (uint256 i = 0; i < 129; i++) {
            ids2[i] = ids[0];
            cs2[i] = 1;
        }
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(_branch(1, ids2, cs2));
    }

    function test_dir_maxLeafWith255ByteNames() public {
        bytes32 f = _file("hi");
        // record = 1 + 255 + 1 + 32 = 289, + 2 offset => 291 per entry; 24,575 limit => 84 entries
        uint256 n = 84;
        E[] memory es = new E[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes memory nm = new bytes(255);
            for (uint256 k = 0; k < 255; k++) nm[k] = "x";
            nm[0] = bytes1(uint8(65 + i / 26));
            nm[1] = bytes1(uint8(65 + i % 26));
            es[i] = E(string(nm), f, false);
        }
        bytes memory blob = _leafBlob(es);
        assertLe(blob.length, 24_575);
        uint256 g = gasleft();
        dirs.putEntryNode(blob);
        emit log_named_uint("gas: 84-entry leaf with 255-byte names", g - gasleft());
    }

    /// Foreign code at a node's first candidate address does not stop the node from being stored.
    function test_node_plantedAddressIsSkipped() public {
        bytes32 f = _file("hi");
        E[] memory es = new E[](1);
        es[0] = E("planted", f, false);
        bytes memory blob = _leafBlob(es);
        address first = CodeStore.predict(SSTORE2.initCodeHash(blob), bytes32(0), address(dirs));
        vm.etch(first, hex"ef0100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        bytes32 id = dirs.putEntryNode(blob);
        (bytes memory stored,,,) = dirs.getNode(id);
        assertEq(stored, blob);
    }

    // ---- branch coverage: constructors, idempotence, guards --------------------------------------------------
    //
    // Everything from here on closes a branch the tests above never took, so that no line of the immutable contracts
    // runs for the first time in production. Each test asserts behaviour (error and arguments, return values, state),
    // not only that the line ran.

    /// A store over an address with no code is refused at construction, with the error that names what is missing.
    function test_constructorsRefuseAddressesWithoutCode() public {
        address nothing = makeAddr("no code here");
        vm.expectRevert(FileStore.NoChunkStore.selector);
        new FileStore(nothing);
        vm.expectRevert(FileStore.NoChunkStore.selector);
        new FileStore(address(0));
        vm.expectRevert(DirectoryStore.NoFileStore.selector);
        new DirectoryStore(nothing);
        vm.expectRevert(DirectoryStore.NoFileStore.selector);
        new DirectoryStore(address(0));
        // Any address with code is accepted: the stores do not guess what the code is.
        assertEq(address(new FileStore(address(chunks)).chunkStore()), address(chunks));
        assertEq(address(new DirectoryStore(address(files)).fileStore()), address(files));
    }

    /// Creating an existing node is a no-op that returns the same id: no second `NodeCreated`, no second deployment,
    /// no change to the stored node. A file leaf, a directory leaf and a directory branch (the two stores use
    /// different id prefixes, 0x41 and 0x42).
    function test_putNode_secondPutIsANoOp() public {
        bytes memory fileLeaf = bytes.concat(hex"00", _rec(0), _rec(1));
        bytes32 fileLeafId = keccak256(bytes.concat(bytes1(0x41), fileLeaf));
        uint48 fileBytes = uint48(_chunkData(0).length + _chunkData(1).length);
        vm.expectEmit(true, false, false, true, address(files));
        emit NodeTree.NodeCreated(fileLeafId, 0, 2, fileBytes);
        assertEq(files.putChunkNode(fileLeaf), fileLeafId);
        vm.recordLogs();
        assertEq(files.putChunkNode(fileLeaf), fileLeafId, "same id back");
        assertEq(vm.getRecordedLogs().length, 0, "no second NodeCreated");
        (bytes memory blob, uint8 level, uint32 count, uint48 size) = files.getNode(fileLeafId);
        assertEq(blob, fileLeaf);
        assertEq(uint256(level), 0);
        assertEq(uint256(count), 2);
        assertEq(uint256(size), uint256(fileBytes));

        bytes32 f = _file("hi");
        bytes memory dirLeafA = _leafBlob(_names(0, 2, f));
        bytes32 a = dirs.putEntryNode(dirLeafA);
        assertEq(a, keccak256(bytes.concat(bytes1(0x42), dirLeafA)));
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = dirs.putEntryNode(_leafBlob(_names(2, 2, f)));
        uint32[] memory cs = new uint32[](2);
        cs[0] = 2;
        cs[1] = 2;
        bytes memory branch = _branch(1, ids, cs);
        bytes32 branchId = dirs.putEntryNode(branch);
        vm.recordLogs();
        assertEq(dirs.putEntryNode(dirLeafA), a);
        assertEq(dirs.putEntryNode(branch), branchId);
        assertEq(vm.getRecordedLogs().length, 0, "re-putting a leaf and a branch emits nothing");
        (blob, level, count, size) = dirs.getNode(branchId);
        assertEq(blob, branch);
        assertEq(uint256(level), 1);
        assertEq(uint256(count), 4);
        assertEq(uint256(size), 0, "directories track no bytes");
    }

    /// A directory leaf whose header promises more than the blob holds.
    function test_dir_leafHeaderBounds() public {
        // count = 5 needs a 10-byte offset table, but the blob stops after two bytes of it
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(hex"0000050000");
        // count = 1 with a complete offset table and then no record at all
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(hex"0000010000");
        // count = 2 with offsets [0, 35]: the first record is whole (1 + "a" + flag + 32 = 35 bytes), the second is not there
        bytes32 f = _file("hi");
        bytes memory record = abi.encodePacked(uint8(1), "a", uint8(0), f);
        assertEq(record.length, 35);
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(bytes.concat(hex"000002" hex"0000" hex"0023", record));
    }

    // ---- branch coverage: directory paths and names -----------------------------------------------------------

    /// `resolvePath` refuses every malformed path with the path itself in the error, and an unknown root with its cid.
    function test_dir_resolvePathErrors() public {
        bytes32 f = _file("hi");
        bytes32 sub = dirs.createDirectory(dirs.putEntryNode(_leafBlob(_names(0, 3, f))));
        E[] memory top = new E[](2);
        top[0] = E("a.txt", f, false);
        top[1] = E("sub", sub, true);
        bytes32 topCid = dirs.createDirectory(dirs.putEntryNode(_leafBlob(top)));

        string[8] memory bad = ["", "/sub", "sub/", "sub//f00000001", "a.txt/x", "nope", "sub/nope", "/"];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, bad[i]));
            dirs.resolvePath(topCid, bad[i]);
        }
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.DirectoryNotFound.selector, bytes32(uint256(8))));
        dirs.resolvePath(bytes32(uint256(8)), "a");
        // and the good ones still resolve, in the same shapes
        (bytes32 got, bool isDir) = dirs.resolvePath(topCid, "sub/f00000002");
        assertEq(got, f);
        assertFalse(isDir);
    }

    /// A path is at most 32 segments (`_MAX_PATH_DEPTH`): 32 resolve, the 33rd is `PathTooDeep(33, 32)`, whether or
    /// not it would have been found. Needs 33 nested directories, each holding one entry named "a".
    function test_dir_pathDepthLimit() public {
        bytes32 inner = dirs.EMPTY_DIRECTORY();
        bytes32 atThirtyTwo;
        for (uint256 level = 1; level <= 33; level++) {
            E[] memory one = new E[](1);
            one[0] = E("a", inner, true);
            inner = dirs.createDirectory(dirs.putEntryNode(_leafBlob(one)));
            if (level == 32) atThirtyTwo = inner;
        }
        // `atThirtyTwo` is 32 directories above the empty directory, `inner` is 33 above it.
        bytes memory p32 = _repeatA(32);
        (bytes32 got, bool isDir) = dirs.resolvePath(atThirtyTwo, string(p32));
        assertEq(got, dirs.EMPTY_DIRECTORY(), "32 segments resolve, down to the empty directory");
        assertTrue(isDir);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathTooDeep.selector, 33, 32));
        dirs.resolvePath(inner, string(_repeatA(33)));
        // The depth is checked before the segment is looked up: a 33rd segment under the empty directory (nothing to find) is too deep too.
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathTooDeep.selector, 33, 32));
        dirs.resolvePath(atThirtyTwo, string(_repeatA(33)));
    }

    function _repeatA(uint256 segments) private pure returns (bytes memory p) {
        p = new bytes(segments * 2 - 1);
        for (uint256 i = 0; i < p.length; i++) {
            p[i] = i % 2 == 0 ? bytes1("a") : bytes1("/");
        }
    }

    /// Names that are prefixes of each other sort shorter first; bytes compare unsigned, so UTF-8 sorts after ASCII.
    function test_dir_prefixNamesAndUnsignedOrder() public {
        bytes32 f = _file("hi");
        E[] memory ok = new E[](3);
        ok[0] = E("a", f, false);
        ok[1] = E("ab", f, false);
        ok[2] = E(string(hex"c3a9"), f, false); // "é": 0xc3 > 'a' only if bytes are unsigned
        bytes32 cid = dirs.createDirectory(dirs.putEntryNode(_leafBlob(ok)));
        assertEq(dirs.getEntry(cid, 0).name, "a");
        assertEq(dirs.getEntry(cid, 1).name, "ab");
        assertEq(dirs.getEntry(cid, 2).name, string(hex"c3a9"));
        // lookups on every side of a prefix relationship
        (bytes32 c,) = dirs.lookup(cid, "a");
        assertEq(c, f);
        (c,) = dirs.lookup(cid, "ab");
        assertEq(c, f);
        (c,) = dirs.lookup(cid, string(hex"c3a9"));
        assertEq(c, f);
        string[5] memory missing = ["", "abc", "b", "aa", string(bytes(hex"c3"))];
        for (uint256 i = 0; i < missing.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, missing[i]));
            dirs.lookup(cid, missing[i]);
        }

        // a longer name before its own prefix is out of order, and so is ASCII after high bytes
        ok = new E[](2);
        ok[0] = E("ab", f, false);
        ok[1] = E("a", f, false);
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_leafBlob(ok));
        ok[0] = E(string(hex"c3a9"), f, false);
        ok[1] = E("z", f, false);
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_leafBlob(ok));
    }

    // ---- branch coverage: deep directory trees -----------------------------------------------------------------

    /// @dev A complete binary tree of directory nodes `level` levels above its leaves; each leaf holds two entries
    ///      named f<from>, f<from+1>, … so the whole tree is sorted. Returns the root and its entry count.
    function _dirTree(uint8 level, uint256 from, bytes32 f) internal returns (bytes32 id, uint32 count) {
        if (level == 0) return (dirs.putEntryNode(_leafBlob(_names(from, 2, f))), 2);
        bytes32[] memory ids = new bytes32[](2);
        uint32[] memory cs = new uint32[](2);
        (ids[0], cs[0]) = _dirTree(level - 1, from, f);
        (ids[1], cs[1]) = _dirTree(level - 1, from + cs[0], f);
        return (dirs.putEntryNode(_branch(level, ids, cs)), cs[0] + cs[1]);
    }

    /// Directories one, two and three branch levels deep (the maximum): every entry is found by index, by name and by
    /// page, and a name that falls between, before or after the entries is not found.
    function test_dir_branchLevelsOneToThree() public {
        bytes32 f = _file("hi");
        for (uint8 level = 1; level <= 3; level++) {
            (bytes32 root, uint32 n) = _dirTree(level, 0, f);
            bytes32 cid = dirs.createDirectory(root);
            assertEq(uint256(n), uint256(2) << level);
            assertEq(dirs.entryCount(cid), uint256(n));
            for (uint256 i = 0; i < n; i++) {
                string memory name = string(abi.encodePacked("f", _pad(i)));
                assertEq(dirs.getEntry(cid, i).name, name);
                (bytes32 c, bool d) = dirs.lookup(cid, name);
                assertEq(c, f);
                assertFalse(d);
                // one byte longer sorts straight after it, so it falls between two entries (or past the last)
                vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, string.concat(name, "x")));
                dirs.lookup(cid, string.concat(name, "x"));
            }
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "e"));
            dirs.lookup(cid, "e"); // before the first
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "g"));
            dirs.lookup(cid, "g"); // after the last
            vm.expectRevert(abi.encodeWithSelector(NodeTree.IndexOutOfRange.selector, n, n));
            dirs.getEntry(cid, n);

            IDirectoryStore.Entry[] memory all = dirs.getEntries(cid, 0, n);
            assertEq(all.length, uint256(n));
            for (uint256 i = 0; i < n; i++) {
                assertEq(all[i].name, string(abi.encodePacked("f", _pad(i))));
            }
            // a window that starts and ends inside leaves
            IDirectoryStore.Entry[] memory mid = dirs.getEntries(cid, 1, n - 1);
            assertEq(mid.length, uint256(n) - 2);
            assertEq(mid[0].name, string(abi.encodePacked("f", _pad(1))));
            assertEq(mid[mid.length - 1].name, string(abi.encodePacked("f", _pad(n - 2))));
            assertEq(dirs.getEntries(cid, 3, 3).length, 0, "an empty window is fine");
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.RangeOutOfBounds.selector, 5, 2, n));
            dirs.getEntries(cid, 5, 2);
            vm.expectRevert(abi.encodeWithSelector(DirectoryStore.RangeOutOfBounds.selector, 0, n + 1, n));
            dirs.getEntries(cid, 0, n + 1);
        }
    }

    /// Order is enforced across a boundary that is a level-2 branch over level-1 branches, where the edge names come
    /// from the last child of the left subtree and the first child of the right one.
    function test_dir_boundaryOrderAcrossLevels() public {
        bytes32 f = _file("hi");
        (bytes32 b1,) = _dirTree(1, 0, f); // f0..f3
        (bytes32 b2,) = _dirTree(1, 4, f); // f4..f7
        (bytes32 b3,) = _dirTree(1, 7, f); // f7..f10: begins with the name b2 ends with
        bytes32[] memory ids = new bytes32[](2);
        uint32[] memory cs = new uint32[](2);
        cs[0] = 4;
        cs[1] = 4;

        ids[0] = b2;
        ids[1] = b1; // reversed
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_branch(2, ids, cs));

        ids[0] = b2;
        ids[1] = b3; // equal edge names (f7 and f7)
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(_branch(2, ids, cs));

        ids[0] = b1;
        ids[1] = b2; // in order
        bytes32 root = dirs.putEntryNode(_branch(2, ids, cs));
        assertEq(dirs.entryCount(dirs.createDirectory(root)), 8);
    }

    /// Each clause of the branch-shape checks on its own: a header that is cut short (no room for the child count),
    /// zero children, a body one byte too long or too short for the count it claims, and a level above the maximum.
    /// (`forge coverage` counts these conditions as one branch; every clause here is a separate way in.)
    function test_branch_headerAndShapeRefusals() public {
        (bytes32 a,) = _chunkLeaf(0, 2);
        (bytes32 b,) = _chunkLeaf(2, 2);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
        uint32[] memory cs = new uint32[](2);
        cs[0] = 2;
        cs[1] = 2;
        bytes memory good = _fbranch(1, ids, cs);
        assertEq(files.putChunkNode(good), keccak256(bytes.concat(bytes1(0x41), good)), "the shape itself is fine");

        bytes[6] memory bad = [
            bytes(hex"01"), // level only
            bytes(hex"0100"), // level and half a count
            bytes(hex"010000"), // zero children
            bytes(hex"010001"), // one child claimed and none present
            bytes.concat(good, hex"00"), // one byte more than two children take
            _slice(good, good.length - 1) // one byte fewer
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(NodeTree.BadNode.selector);
            files.putChunkNode(bad[i]);
            vm.expectRevert(NodeTree.BadNode.selector);
            dirs.putEntryNode(bad[i]);
        }
        // a level above the maximum is refused before anything about the children is looked at
        bytes memory level4 = bytes.concat(good);
        level4[0] = 0x04;
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(level4);
        vm.expectRevert(NodeTree.BadNode.selector);
        files.putChunkNode(hex"ff");
    }

    /// The MIME type limit is inclusive: 127 bytes are a type (and read back whole), 128 are not.
    function test_file_mimeTypeLengthBoundary() public {
        (bytes32 a,) = _chunkLeaf(0, 1);
        bytes memory m = new bytes(127);
        for (uint256 i = 0; i < m.length; i++) m[i] = "m";
        bytes32 cid = files.createFile(a, string(m), 0, bytes32(0));
        assertEq(files.getFileInfo(cid).mimeType, string(m));
        assertEq(files.createFile(bytes32(0), string(m), 0, bytes32(0)) != cid, true, "the empty file is a different file");
        vm.expectRevert(FileStore.InvalidMimeType.selector);
        files.createFile(a, string.concat(string(m), "m"), 0, bytes32(0));
    }

    /// Dots are only special as the whole name: `.` and `..` are refused, `...`, `.a`, `a.` and `a..` are names.
    function test_dir_dotNames() public {
        bytes32 f = _file("hi");
        E[] memory es = new E[](4);
        es[0] = E("...", f, false);
        es[1] = E(".a", f, false);
        es[2] = E("a.", f, false);
        es[3] = E("a..", f, false);
        bytes32 cid = dirs.createDirectory(dirs.putEntryNode(_leafBlob(es)));
        assertEq(dirs.entryCount(cid), 4);
        for (uint256 i = 0; i < es.length; i++) {
            assertEq(dirs.getEntry(cid, i).name, es[i].name);
            (bytes32 c,) = dirs.lookup(cid, es[i].name);
            assertEq(c, f);
        }
        // "." and ".." refused whether alone or in company
        E[] memory dots = new E[](1);
        dots[0] = E(".", f, false);
        vm.expectRevert(DirectoryStore.InvalidName.selector);
        dirs.putEntryNode(_leafBlob(dots));
        dots[0] = E("..", f, false);
        vm.expectRevert(DirectoryStore.InvalidName.selector);
        dirs.putEntryNode(_leafBlob(dots));
        // separators anywhere in a name
        string[4] memory sep = ["/a", "a/", "\\a", "a\\b"];
        for (uint256 i = 0; i < sep.length; i++) {
            dots[0] = E(sep[i], f, false);
            vm.expectRevert(DirectoryStore.InvalidName.selector);
            dirs.putEntryNode(_leafBlob(dots));
        }
    }

    /// `DirectoryStore._tracksBytes()` is `false`: directory branches are 36 bytes a child and nodes report no byte
    /// total, so a file-shaped (42-byte) branch is refused. (`forge coverage` reports the lone `return false` of that
    /// function as unhit although the function runs on every branch validation: a limitation of its source mapping for
    /// a constant return. This test pins what the constant means.)
    function test_dir_branchesTrackNoBytes() public {
        bytes32 f = _file("hi");
        bytes32 a = dirs.putEntryNode(_leafBlob(_names(0, 2, f)));
        bytes32 b = dirs.putEntryNode(_leafBlob(_names(2, 2, f)));
        // two children at the file stride (id, count:4, bytes:6)
        vm.expectRevert(NodeTree.BadNode.selector);
        dirs.putEntryNode(abi.encodePacked(uint8(1), uint16(2), a, uint32(2), uint48(0), b, uint32(4), uint48(0)));
        // at the directory stride (id, count:4) the same two children are accepted
        bytes32 root = dirs.putEntryNode(abi.encodePacked(uint8(1), uint16(2), a, uint32(2), b, uint32(4)));
        (bytes memory blob,, uint32 count, uint48 size) = dirs.getNode(root);
        assertEq(blob.length, 3 + 2 * 36);
        assertEq(uint256(count), 4);
        assertEq(uint256(size), 0);
    }

    // ---- branch coverage: files -------------------------------------------------------------------------------

    /// A page that starts or ends inside a leaf reads only the chunks inside the window, from one leaf or several.
    function test_file_getChunkIdsWindows() public {
        (bytes32 a,) = _chunkLeaf(0, 4);
        (bytes32 b,) = _chunkLeaf(4, 3);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
        uint32[] memory cs = new uint32[](2);
        cs[0] = 4;
        cs[1] = 3;
        bytes32 branched = files.createFile(files.putChunkNode(_fbranch(1, ids, cs)), "image/png", 0, bytes32(0));
        bytes32 single = files.createFile(a, "image/png", 0, bytes32(0));

        // inside one leaf, ending before its last record
        bytes32[] memory got = files.getChunkIds(single, 0, 2);
        assertEq(got.length, 2);
        assertEq(got[0], _chunk(0));
        assertEq(got[1], _chunk(1));
        // starting inside one leaf and ending inside the next
        got = files.getChunkIds(branched, 2, 6);
        assertEq(got.length, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(got[i], _chunk(2 + i));
        }
        // every window of the seven chunks
        for (uint256 s = 0; s <= 7; s++) {
            for (uint256 e = s; e <= 7; e++) {
                got = files.getChunkIds(branched, s, e);
                assertEq(got.length, e - s);
                for (uint256 i = 0; i < got.length; i++) {
                    assertEq(got[i], _chunk(s + i));
                }
            }
        }
        vm.expectRevert(abi.encodeWithSelector(FileStore.RangeOutOfBounds.selector, 5, 2, 7));
        files.getChunkIds(branched, 5, 2);
        vm.expectRevert(abi.encodeWithSelector(FileStore.RangeOutOfBounds.selector, 0, 8, 7));
        files.getChunkIds(branched, 0, 8);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.IndexOutOfRange.selector, 7, 7));
        files.getChunkId(branched, 7);
    }

    /// `_scanLeaf` ends in `revert BadNode()` for a byte offset the leaf's records do not reach. That cannot happen
    /// for a node the store wrote: the descent only hands `_scanLeaf` an offset below the leaf's byte total, the stored
    /// total is the sum of the sizes in the blob (checked when the node is created), and the blob cannot change. So the
    /// guard is only reachable if the stored total disagrees with the blob, which this test forces by writing the
    /// node's storage slot directly. It shows the guard fires (rather than reading past the records) and that the real
    /// bytes still resolve.
    function test_file_scanLeafGuardOnInconsistentTotal() public {
        (bytes32 leaf,) = _chunkLeaf(0, 2);
        bytes32 cid = files.createFile(leaf, "text/plain", 0, bytes32(0));
        uint256 total = _chunkData(0).length + _chunkData(1).length;

        // `_nodes` is slot 0 (see `forge inspect FileStore storage-layout`); a node packs pointer (160) | level (8) |
        // count (32) | bytes (48) into one slot.
        bytes32 slot = keccak256(abi.encode(leaf, uint256(0)));
        uint256 w = uint256(vm.load(address(files), slot));
        assertEq(uint256(uint8(w >> 160)), 0, "level");
        assertEq(uint256(uint32(w >> 168)), 2, "count");
        assertEq(uint256(uint48(w >> 200)), total, "bytes");

        vm.expectRevert(abi.encodeWithSelector(NodeTree.OffsetOutOfRange.selector, total, total));
        files.locateByte(cid, total);

        vm.store(address(files), slot, bytes32((w & ((uint256(1) << 200) - 1)) | ((total + 10) << 200)));
        assertEq(files.getFileInfo(cid).size, total + 10, "the forged total is what the file reports");
        (uint256 idx,, bytes32 id,) = files.locateByte(cid, total - 1);
        assertEq(idx, 1);
        assertEq(id, _chunk(1));
        vm.expectRevert(NodeTree.BadNode.selector);
        files.locateByte(cid, total);
        vm.expectRevert(NodeTree.BadNode.selector);
        files.locateByte(cid, total + 9);
        vm.expectRevert(abi.encodeWithSelector(NodeTree.OffsetOutOfRange.selector, total + 10, total + 10));
        files.locateByte(cid, total + 10);
    }

    /// `_validateBranch` ends with `if (running > uint32.max || runningBytes > uint48.max) revert BadNode()`. That
    /// revert is unreachable: every child is checked against a cumulative field of the branch itself, which is a
    /// `uint32` (counts) or `uint48` (bytes) and must EQUAL the running total (`CountMismatch` / `BytesMismatch`), so
    /// a running total above the field's maximum can never equal anything written there, and the loop has already
    /// reverted by the time it would exceed it. (A tree of three branch levels also cannot hold more than
    /// 128^3 * 646 chunks, about 1.4 billion, so a count past 2^32 needs forged child records.) These two tests show
    /// the earlier check is what fires, for bytes with real nodes and for counts with a forged child record.
    function test_branch_bytesPastTheFieldAreAMismatch() public {
        uint48 max = type(uint48).max;
        bytes32 big1 = chunks.write(address(logBackend), "a", keccak256("a"), max);
        bytes32 big2 = chunks.write(address(logBackend), "b", keccak256("b"), max);
        bytes32 l1 = files.putChunkNode(abi.encodePacked(hex"00", big1, max));
        bytes32 l2 = files.putChunkNode(abi.encodePacked(hex"00", big2, max));
        // The running total after the second leaf is 2 * max, which no six-byte field can hold: the field wraps.
        vm.expectRevert(abi.encodeWithSelector(NodeTree.BytesMismatch.selector, 1));
        files.putChunkNode(abi.encodePacked(uint8(1), uint16(2), l1, uint32(1), max, l2, uint32(2), uint48(uint256(max) * 2)));
        // Saturating the field does not help either.
        vm.expectRevert(abi.encodeWithSelector(NodeTree.BytesMismatch.selector, 1));
        files.putChunkNode(abi.encodePacked(uint8(1), uint16(2), l1, uint32(1), max, l2, uint32(2), max));
    }

    function test_branch_countsPastTheFieldAreAMismatch() public {
        bytes32 f = _file("hi");
        bytes32 d1 = dirs.putEntryNode(_leafBlob(_names(0, 1, f)));
        bytes32 d2 = dirs.putEntryNode(_leafBlob(_names(1, 1, f)));
        // Forge both leaves' stored counts to 2^32 - 1 (`_nodes` is slot 0; count sits at bits 168..199).
        _forgeCount(d1, type(uint32).max);
        _forgeCount(d2, type(uint32).max);
        uint32 max = type(uint32).max;
        // The running count after the second leaf is 2^33 - 2, which a four-byte field cannot hold.
        vm.expectRevert(abi.encodeWithSelector(NodeTree.CountMismatch.selector, 1));
        dirs.putEntryNode(abi.encodePacked(uint8(1), uint16(2), d1, max, d2, uint32(uint256(max) * 2)));
    }

    function _forgeCount(bytes32 node, uint32 count) private {
        bytes32 slot = keccak256(abi.encode(node, uint256(0)));
        uint256 w = uint256(vm.load(address(dirs), slot));
        uint256 mask = uint256(type(uint32).max) << 168;
        vm.store(address(dirs), slot, bytes32((w & ~mask) | (uint256(count) << 168)));
        (,, uint32 got,) = dirs.getNode(node);
        assertEq(uint256(got), uint256(count), "the forged count is what the node reports");
    }
}

/// @dev Kept out of the test contract to stay under the stack limit.
library FileStoreInfo {
    function check(FileStore files, bytes32 cid) internal view {
        IFileStore.FileInfo memory info = files.getFileInfo(cid);
        require(info.root == bytes32(0), "root");
        require(info.rootLevel == 0 && info.chunkCount == 0 && info.size == 0, "shape");
        require(keccak256(bytes(info.mimeType)) == keccak256("text/plain"), "mime");
        require(info.codec == bytes32(0) && info.outputHash == bytes32(0), "codec");
    }
}
