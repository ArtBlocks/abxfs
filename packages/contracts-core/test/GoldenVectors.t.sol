// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ChunkStore} from "../src/ChunkStore.sol";
import {FileStore} from "../src/FileStore.sol";
import {DirectoryStore} from "../src/DirectoryStore.sol";

/// @dev A chunk store that records any id the test registers with a size, so the vectors can use arbitrary chunk ids
///      (`keccak256("chunk-" + i)`). `FileStore` asks its chunk store only `sizeOf` when it validates a leaf.
contract SizedChunkStore {
    mapping(bytes32 => uint48) internal _sizes;

    function set(bytes32 id, uint48 size) external {
        _sizes[id] = size;
    }

    function sizeOf(bytes32 id) external view returns (uint48) {
        uint48 s = _sizes[id];
        require(s != 0, "not registered");
        return s;
    }
}

/// @title GoldenVectorsTest
/// @notice Cross-checks the SDK's canonical packing (`packages/sdk/src/nodes.ts`, rules in `node-gas.ts`) against the
///         contracts. The blobs AND the content-defined boundaries are computed HERE, independently, from the rules in
///         `specs/abx-fs.md` §5; the expected node ids and CIDs are literals printed by
///         `packages/sdk/scripts/golden-vectors.mjs` (and asserted in `packages/sdk/test/nodes.test.ts`). If the
///         contracts, the spec text and the SDK agree, every assertion here and there passes.
contract GoldenVectorsTest is Test {
    SizedChunkStore internal store;
    ChunkStore internal chunkStore;
    FileStore internal files;
    DirectoryStore internal dirs;

    // ---- the canonical packing rules (spec §5), restated -----------------------------------------------------
    uint256 internal constant CHUNK_MIN = 32;
    uint256 internal constant CHUNK_MAX = 512;
    uint256 internal constant CHUNK_ODDS = 128;
    uint256 internal constant ENTRY_MIN_BYTES = 4096;
    uint256 internal constant ENTRY_TARGET_BYTES = 4096;
    uint256 internal constant ENTRY_GAS_CAP = 7_000_000;
    uint256 internal constant BRANCH_MAX = 128;
    uint256 internal constant BRANCH_ODDS = 32;

    function setUp() public {
        store = new SizedChunkStore();
        chunkStore = new ChunkStore();
        files = new FileStore(address(store));
        dirs = new DirectoryStore(address(files));
    }

    function _key(bytes32 h) internal pure returns (uint256) {
        return uint32(bytes4(h));
    }

    function _h(uint256 i) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("chunk-", _str(i))));
    }

    function _high(uint256 i) internal pure returns (bytes32) {
        return bytes32((uint256(_h(i)) & ~(uint256(0xff) << 248)) | (uint256(0xff) << 248));
    }

    function _low(uint256 i) internal pure returns (bytes32) {
        return bytes32(uint256(_h(i)) & ~(uint256(0xff) << 248));
    }

    function _size(uint256 i) internal pure returns (uint256) {
        return 1000 + 100 * (i % 7);
    }

    function _str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n;
        for (uint256 t = v; t != 0; t /= 10) n++;
        bytes memory b = new bytes(n);
        for (uint256 t = v; t != 0; t /= 10) b[--n] = bytes1(uint8(48 + (t % 10)));
        return string(b);
    }

    // ---- files ---------------------------------------------------------

    /// @dev Pack chunk leaves (`0x00 ‖ (chunkId:32 ‖ size:6) × n`) by the content-defined rule, create them, then stack
    ///      branches to one root.
    function _packFile(bytes32[] memory hs, uint256[] memory sizes) internal returns (bytes32[] memory leafIds, bytes32 root) {
        for (uint256 i = 0; i < hs.length; i++) {
            store.set(hs[i], uint48(sizes[i]));
        }
        bytes32[] memory ids = new bytes32[](hs.length);
        uint256 nLeaves;
        uint256 start;
        for (uint256 i = 0; i < hs.length; i++) {
            uint256 cur = i + 1 - start;
            bool last = i + 1 == hs.length;
            if (cur == CHUNK_MAX || (cur >= CHUNK_MIN && _key(hs[i]) < (1 << 32) / CHUNK_ODDS) || last) {
                bytes memory blob = hex"00";
                for (uint256 k = start; k <= i; k++) {
                    blob = bytes.concat(blob, hs[k], bytes6(uint48(sizes[k])));
                }
                ids[nLeaves++] = files.putChunkNode(blob);
                start = i + 1;
            }
        }
        leafIds = new bytes32[](nLeaves);
        for (uint256 i = 0; i < nLeaves; i++) {
            leafIds[i] = ids[i];
        }
        root = _stack(leafIds, true);
    }

    /// @dev The branch grouping rule: a branch ends after a child whose id key is under 2^32 / 32 once it has two
    ///      children, or at 128; a trailing group of one joins the group before it, or takes one from a full one.
    function _groups(bytes32[] memory kids) internal pure returns (uint256[] memory sizes, uint256 n) {
        sizes = new uint256[](kids.length);
        uint256 cur;
        for (uint256 i = 0; i < kids.length; i++) {
            cur++;
            if (cur == BRANCH_MAX || (cur >= 2 && _key(kids[i]) < (1 << 32) / BRANCH_ODDS)) {
                sizes[n++] = cur;
                cur = 0;
            }
        }
        if (cur > 0) sizes[n++] = cur;
        if (n > 1 && sizes[n - 1] == 1) {
            if (sizes[n - 2] < BRANCH_MAX) {
                sizes[n - 2] += 1;
                n--;
            } else {
                sizes[n - 2] = BRANCH_MAX - 1;
                sizes[n - 1] = 2;
            }
        }
    }

    function _stack(bytes32[] memory level0, bool isFile) internal returns (bytes32) {
        bytes32[] memory cur = level0;
        uint8 level;
        while (cur.length > 1) {
            level++;
            (uint256[] memory sizes, uint256 n) = _groups(cur);
            bytes32[] memory next = new bytes32[](n);
            uint256 at;
            for (uint256 g = 0; g < n; g++) {
                bytes memory b = abi.encodePacked(level, uint16(sizes[g]));
                uint32 run;
                uint48 runBytes;
                for (uint256 k = 0; k < sizes[g]; k++) {
                    bytes32 child = cur[at + k];
                    (,, uint32 count, uint48 size) = isFile ? files.getNode(child) : dirs.getNode(child);
                    run += count;
                    runBytes += size;
                    b = isFile
                        ? bytes.concat(b, abi.encodePacked(child, run, runBytes))
                        : bytes.concat(b, abi.encodePacked(child, run));
                }
                next[g] = isFile ? files.putChunkNode(b) : dirs.putEntryNode(b);
                at += sizes[g];
            }
            cur = next;
        }
        return cur[0];
    }

    function _seq(uint256 n, bool high) internal pure returns (bytes32[] memory hs, uint256[] memory sizes) {
        hs = new bytes32[](n);
        sizes = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            hs[i] = high ? _high(i) : _h(i);
            sizes[i] = _size(i);
        }
    }

    function _f1() internal returns (bytes32) {
        (bytes32[] memory hs, uint256[] memory sizes) = _seq(3, false);
        (, bytes32 root) = _packFile(hs, sizes);
        return files.createFile(root, "text/plain", bytes32(0), bytes32(0));
    }

    function test_golden_f1_singleLeafFile() public {
        (bytes32[] memory hs, uint256[] memory sizes) = _seq(3, false);
        (bytes32[] memory leaves, bytes32 root) = _packFile(hs, sizes);
        assertEq(leaves.length, 1);
        assertEq(root, 0xb170625499033c6e6a4fbf0a701456ef5091abe18322e5e1c648f8501d862dd7);
        bytes32 cid = files.createFile(root, "text/plain", bytes32(0), bytes32(0));
        assertEq(cid, 0xc46016b13ec4f99a586c66c08ff0f0e5550b725a710c92c6b3da70be6de5dcd6);
        assertEq(files.getFileInfo(cid).size, 1000 + 1100 + 1200);
    }

    /// @dev The CID binds a file codec (the bytes32 label "gzip") and its output hash.
    function test_golden_f2_contentDefinedLeaves() public {
        (bytes32[] memory hs, uint256[] memory sizes) = _seq(1200, false);
        (bytes32[] memory leaves, bytes32 root) = _packFile(hs, sizes);
        assertEq(leaves.length, 10);
        assertEq(root, 0x4f1d830e2e965adfc3b13177f08110b30cdc5a74ceaf2d834915d38dbb9cc0a5);
        bytes32 cid = files.createFile(root, "application/octet-stream", bytes32("gzip"), keccak256("logical"));
        assertEq(cid, 0x4edc30c0530e45806c0b4c1fdc35cfb098790ed5a7d7a1f1bd50fd1010ee56da);
        assertEq(files.chunkCount(cid), 1200);
        assertEq(files.getFileInfo(cid).size, 1_559_400);
    }

    function test_golden_f3_forcedAtMaximum() public {
        (bytes32[] memory hs, uint256[] memory sizes) = _seq(1100, true);
        (bytes32[] memory leaves, bytes32 root) = _packFile(hs, sizes);
        assertEq(leaves.length, 3);
        (,, uint32 c0,) = files.getNode(leaves[0]);
        (,, uint32 c2,) = files.getNode(leaves[2]);
        assertEq(c0, 512);
        assertEq(c2, 76);
        assertEq(root, 0x2ba7ce3377c4ad0a7ac266b3a955ac64c95c1fbae22547164aa1760d2406a5c7);
        assertEq(
            files.createFile(root, "video/mp4", bytes32(0), bytes32(0)),
            0xd182ab0e89e37caa4bab2c6bddbbaa3be1c97d543f8c58f9d145b18580697c72
        );
    }

    /// @dev Every chunk is a boundary candidate, so 132 minimum-size leaves; the BRANCHES are then content-defined by leaf
    ///      node id (23, 30, 41, 35 and 3 children) under a level-2 root, re-derived here by `_groups`.
    function test_golden_f4_contentDefinedBranchesTwoLevels() public {
        bytes32[] memory hs = new bytes32[](4200);
        uint256[] memory sizes = new uint256[](4200);
        for (uint256 i = 0; i < 4200; i++) {
            hs[i] = _low(i);
            sizes[i] = _size(i);
        }
        (bytes32[] memory leaves, bytes32 root) = _packFile(hs, sizes);
        assertEq(leaves.length, 132);
        (, uint8 level, uint32 count,) = files.getNode(root);
        assertEq(level, 2);
        assertEq(count, 4200);
        assertEq(root, 0x5dea3369c24cd5a309625df419d6b93630a21d7ca9a60244d1a9e1745bdf9254);
        assertEq(
            files.createFile(root, "application/octet-stream", bytes32(0), bytes32(0)),
            0xb94533e7761c324c06b2989d07814a05d535e2e137edaa5c4c2bc2fc638d4f01
        );
    }

    /// @dev Real chunk ids: `ChunkStore.chunkId` over backend 0x…aa, the input hash, the data hash and the size, for
    ///      data "real-0".."real-2" stored raw (input = data). Pins the chunk-id formula on both sides.
    function test_golden_f5_realChunkIds() public {
        bytes32[3] memory want = [
            bytes32(0x5f4138159122e3e2f096288735e7f2a295a3ccb16d43610ad3f16fc2a5d2ae9e),
            bytes32(0xc079884f8615532266b183f3c06265a0e20231de6d025db6c3a4ac62802e720f),
            bytes32(0x15b8b14a8840bef55602c78e751738a08e345a9f1f0e939b1e4d213bdd6c56c1)
        ];
        bytes32[] memory hs = new bytes32[](3);
        uint256[] memory sizes = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            bytes memory data = bytes(string.concat("real-", _str(i)));
            bytes32 dh = keccak256(data);
            hs[i] = chunkStore.chunkId(address(0xaa), dh, dh, uint48(data.length));
            assertEq(hs[i], want[i]);
            // The formula, restated: keccak256(0x30 ‖ backend ‖ inputHash ‖ dataHash ‖ size:6).
            assertEq(hs[i], keccak256(abi.encodePacked(bytes1(0x30), address(0xaa), dh, dh, uint48(data.length))));
            sizes[i] = data.length;
        }
        (, bytes32 root) = _packFile(hs, sizes);
        assertEq(root, 0xb24b7c3349eebbbde38096f0db1f4da38a3d162a2a5bfbf4066e1ed886454546);
        assertEq(
            files.createFile(root, "text/plain", bytes32(0), bytes32(0)),
            0xd351693ccf47f7351a75a2629e91c1281c6ad9e0a530d4ebaa6d8a833e41b47d
        );
    }

    function test_golden_empty() public {
        bytes32 emptyFile = files.createFile(bytes32(0), "text/plain", bytes32(0), bytes32(0));
        assertEq(emptyFile, 0x706e21029ca1aed7fba562e7975e12fb5327ef0c517c1687df062d8dd2ad0200);
        assertEq(files.getFileInfo(emptyFile).size, 0);
        assertEq(dirs.EMPTY_DIRECTORY(), 0xcbe207ab59076db4a264371e3417d6936ea6321bc7c2654a4146cd2bc9d6dd4c);
        assertEq(dirs.directoryCid(bytes32(0)), dirs.EMPTY_DIRECTORY());
        assertTrue(dirs.directoryExists(dirs.EMPTY_DIRECTORY()));
    }

    // ---- directories ---------------------------------------------------

    struct E {
        string name;
        bytes32 cid;
        bool dir;
    }

    function _record(E memory e) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(uint8(bytes(e.name).length)), bytes(e.name), bytes1(e.dir ? 1 : 0), e.cid);
    }

    function _leafBlob(E[] memory es, uint256 from, uint256 to) internal pure returns (bytes memory) {
        bytes memory offs;
        bytes memory recs;
        for (uint256 i = from; i < to; i++) {
            offs = bytes.concat(offs, bytes2(uint16(recs.length)));
            recs = bytes.concat(recs, _record(es[i]));
        }
        return bytes.concat(hex"00", bytes2(uint16(to - from)), offs, recs);
    }

    function _packCost(uint256 count, uint256 nameBytes) internal pure returns (uint256 blob, uint256 cost) {
        blob = 3 + 36 * count + nameBytes;
        cost = 75_000 + 205 * blob + 11_000 * count + 170 * nameBytes;
    }

    /// @dev Entries must already be in unsigned byte order. The content-defined entry rule, then branches.
    function _packDir(E[] memory es) internal returns (bytes32[] memory leafIds, bytes32 root) {
        bytes32[] memory ids = new bytes32[](es.length);
        uint256 nLeaves;
        uint256 start;
        uint256 nameBytes;
        for (uint256 i = 0; i < es.length; i++) {
            uint256 len = bytes(es[i].name).length;
            (uint256 blobWith, uint256 costWith) = _packCost(i + 1 - start, nameBytes + len);
            if (i > start && (blobWith > 24_575 || costWith > ENTRY_GAS_CAP)) {
                ids[nLeaves++] = dirs.putEntryNode(_leafBlob(es, start, i));
                start = i;
                nameBytes = 0;
            }
            nameBytes += len;
            (uint256 blob,) = _packCost(i + 1 - start, nameBytes);
            uint256 recordBytes = 2 + 1 + len + 1 + 32;
            if (blob >= ENTRY_MIN_BYTES && _key(keccak256(bytes(es[i].name))) < (recordBytes << 32) / ENTRY_TARGET_BYTES) {
                ids[nLeaves++] = dirs.putEntryNode(_leafBlob(es, start, i + 1));
                start = i + 1;
                nameBytes = 0;
            }
        }
        if (start < es.length) ids[nLeaves++] = dirs.putEntryNode(_leafBlob(es, start, es.length));
        leafIds = new bytes32[](nLeaves);
        for (uint256 i = 0; i < nLeaves; i++) {
            leafIds[i] = ids[i];
        }
        root = _stack(leafIds, false);
    }

    function _d1(bytes32 f1) internal returns (bytes32 cid) {
        E[] memory es = new E[](1);
        es[0] = E("x", f1, false);
        (, bytes32 root) = _packDir(es);
        assertEq(root, 0xe9ebf724ad6c9093494267ab21b5083be76042fd2afbb5119a38acaa34388608);
        cid = dirs.createDirectory(root);
        assertEq(cid, 0x19cf8bdcb8f3c347a8c675f1e42f1a712b5a2d1974a2ace61b2ed9d2be69d82b);
    }

    function test_golden_d1_oneEntryDirectory() public {
        _d1(_f1());
    }

    /// @dev Sorted in UNSIGNED BYTE order, which is not UTF-16 order: "Ａ" (ef bc a1) comes before "😀" (f0 9f 98 80),
    ///      whereas in UTF-16 the emoji (surrogate d83d) would come first. The contract enforces strict byte order, so
    ///      this passing proves the SDK's order is the contract's.
    function test_golden_d2_unicodeByteOrder() public {
        bytes32 f1 = _f1();
        bytes32 d1 = _d1(f1);
        E[] memory es = new E[](7);
        es[0] = E("a", f1, false);
        es[1] = E("dir", d1, true);
        es[2] = E("z", f1, false);
        es[3] = E(unicode"é", f1, false);
        es[4] = E(unicode"日本", f1, false);
        es[5] = E(unicode"Ａ", f1, false);
        es[6] = E(unicode"😀", f1, false);
        (bytes32[] memory leaves, bytes32 root) = _packDir(es);
        assertEq(leaves.length, 1);
        assertEq(root, 0xac929b2e8ca844e7c9e84037e6185ae1f13be204672ee41d1357f17e64d0633a);
        assertEq(dirs.createDirectory(root), 0xf010c270a3de3a878f5534e13182ab16251d321bca928046cd2412d1ae6b92fa);

        // And the wrong order is refused: swap the last two.
        E[] memory bad = new E[](2);
        bad[0] = E(unicode"😀", f1, false);
        bad[1] = E(unicode"Ａ", f1, false);
        bytes memory badBlob = _leafBlob(bad, 0, 2);
        vm.expectRevert(DirectoryStore.EntriesNotSorted.selector);
        dirs.putEntryNode(badBlob);
    }

    function test_golden_d3_contentDefinedLeavesUnderABranch() public {
        bytes32 f1 = _f1();
        E[] memory es = new E[](400);
        for (uint256 i = 0; i < 400; i++) {
            string memory pad = i < 10 ? "00" : i < 100 ? "0" : "";
            es[i] = E(string.concat("e", pad, _str(i)), f1, false);
        }
        (bytes32[] memory leaves, bytes32 root) = _packDir(es);
        assertEq(leaves.length, 2);
        (,, uint32 c0,) = dirs.getNode(leaves[0]);
        assertEq(c0, 215);
        assertEq(root, 0xb91f959eb73d1a8c18382fd4c12e2b9ea6c7696d7196a7bdc32d8cea01087cbd);
        bytes32 cid = dirs.createDirectory(root);
        assertEq(cid, 0xc355923ea89474f100f2962c3c69e2803f495c1766acedc37032c37441ec8a68);
        assertEq(dirs.entryCount(cid), 400);
    }

    /// @dev A directory holding the empty file and the empty directory: neither was written as nodes, and both are
    ///      valid entries (the empty file is created with a zero root; the empty directory exists without creation).
    function test_golden_d4_emptyFileAndEmptyDirectoryAsEntries() public {
        bytes32 emptyFile = files.createFile(bytes32(0), "text/plain", bytes32(0), bytes32(0));
        E[] memory es = new E[](2);
        es[0] = E(".nojekyll", emptyFile, false);
        es[1] = E("e", dirs.EMPTY_DIRECTORY(), true);
        (, bytes32 root) = _packDir(es);
        assertEq(root, 0xf49f91388b85f5420e969f3185809b23834d66d8dea0078e5ef9a06b74d0c9f6);
        bytes32 cid = dirs.createDirectory(root);
        assertEq(cid, 0xd1a913d15f9da7e67605314b479f309a5940b633c4ed7115ff6653f9a85b552b);
        assertEq(dirs.entryCount(cid), 2);
    }
}
