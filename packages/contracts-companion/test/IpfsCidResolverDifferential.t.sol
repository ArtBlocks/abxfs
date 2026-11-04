// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {CID} from "@abxfs/protobuf/CID.sol";

/// @notice The resolver against `ipfs-unixfs-importer` on random trees (`test/fixtures/differential-trees.json`, from
///         `generate-differential-trees.mjs`, which documents the program format and what the six trees cover).
///
///         Each tree is rebuilt through the real content layer (random chunk sizes, raw and FastLZ chunks, file and entry
///         node trees of one to three branch levels, names of every UTF-8 shape) and every object in it, files and
///         directories, is derived on its own and compared with the CID and Tsize the importer gave the same content
///         under the same names. The root comes last and re-derives everything below it.
contract IpfsCidResolverDifferentialTest is BaseCompanionTest {
    uint256 internal constant ENTRY_LEAF_MAX = 24_575;

    IpfsCidResolver internal resolver;
    string internal json;

    struct Obj {
        bytes32 cid;
        bool isDir;
    }

    Obj[] internal objs;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
        json = vm.readFile("./test/fixtures/differential-trees.json");
    }

    function test_tree0() public {
        _run(0);
    }

    function test_tree1() public {
        _run(1);
    }

    function test_tree2() public {
        _run(2);
    }

    function test_tree3() public {
        _run(3);
    }

    function test_tree4() public {
        _run(4);
    }

    function test_tree5() public {
        _run(5);
    }

    function _run(uint256 t) internal {
        string memory base = string.concat(".[", vm.toString(t), "]");
        bytes memory prog = vm.parseJsonBytes(json, string.concat(base, ".program"));
        string[] memory cids = vm.parseJsonStringArray(json, string.concat(base, ".cids"));
        uint256[] memory tsizes = vm.parseJsonUintArray(json, string.concat(base, ".tsizes"));
        uint256 pos;
        while (pos < prog.length) {
            uint8 op = uint8(prog[pos]);
            if (op == 1) pos = _file(prog, pos + 1);
            else if (op == 2) pos = _dir(prog, pos + 1);
            else revert("bad op");
        }
        assertEq(objs.length, cids.length, "object count");
        // One derivation per object: the link (codec, digest, Tsize), its CID string encoded here. The string calls
        // add only that encoding (`computeIpfsCid` and `computeFileCid` are covered with the same vectors elsewhere).
        for (uint256 i; i < objs.length; i++) {
            Obj memory o = objs[i];
            (uint256 codec, bytes32 digest, uint256 tsize) =
                o.isDir ? resolver.directoryLink(o.cid) : resolver.fileLink(o.cid);
            assertEq(CID.encode(codec, digest), cids[i], string.concat("CID of object ", vm.toString(i)));
            assertEq(tsize, tsizes[i], string.concat("Tsize of object ", vm.toString(i)));
        }
        // The root once more through its string call.
        assertEq(resolver.computeIpfsCid(objs[objs.length - 1].cid), cids[objs.length - 1], "root, as a string");
    }

    // ---- files -----------------------------------------------------------

    struct FileHeader {
        bytes32 seed;
        uint256 kind;
        uint256 runLen;
        uint256 baseSize;
        uint256 rep;
        uint256 n;
        uint256 leafCap;
        uint256 branchCap;
    }

    function _file(bytes memory prog, uint256 p) internal returns (uint256) {
        FileHeader memory h;
        h.seed = bytes32(_u(prog, p, 32));
        h.kind = _u(prog, p + 32, 1);
        h.runLen = _u(prog, p + 33, 4);
        h.baseSize = _u(prog, p + 37, 6);
        h.rep = _u(prog, p + 43, 4);
        h.n = _u(prog, p + 47, 4);
        h.leafCap = _u(prog, p + 51, 2);
        h.branchCap = _u(prog, p + 53, 1);
        p += 54;
        bytes memory content = _content(h.seed, h.kind, h.runLen, h.baseSize);
        bytes32[] memory ids = new bytes32[](h.n * h.rep);
        uint256[] memory sizes = new uint256[](h.n * h.rep);
        uint256 off;
        for (uint256 i; i < h.n; i++) {
            sizes[i] = _u(prog, p, 4);
            bytes memory piece = slice(content, off, sizes[i]);
            ids[i] = _u(prog, p + 4, 1) == 1 ? flzChunk(piece) : rawChunk(piece);
            off += sizes[i];
            p += 5;
        }
        require(off == h.baseSize, "the chunks cover the base");
        for (uint256 r = 1; r < h.rep; r++) {
            for (uint256 i; i < h.n; i++) {
                (ids[r * h.n + i], sizes[r * h.n + i]) = (ids[i], sizes[i]);
            }
        }
        objs.push(Obj(_fileTree(ids, sizes, h.leafCap, h.branchCap), false));
        return p;
    }

    /// @dev The generator's base content: sha256(seed ‖ w) per word, or runs of one byte each `runLen` bytes long.
    ///      Hashed in scratch memory (64 bytes, then the free memory pointer is put back), so nothing is allocated per
    ///      word.
    function _content(bytes32 seed, uint256 kind, uint256 runLen, uint256 size)
        internal
        view
        returns (bytes memory out)
    {
        out = new bytes(size + 32);
        uint256 words = (size + 31) / 32;
        uint256 lastRun = type(uint256).max;
        uint256 fill;
        for (uint256 w; w < words; w++) {
            bytes32 word;
            if (kind == 0) {
                word = _sha(seed, w);
            } else {
                uint256 run = (w * 32) / runLen;
                if (run != lastRun) {
                    fill =
                        uint8(_sha(seed, run)[0]) * 0x0101010101010101010101010101010101010101010101010101010101010101;
                    lastRun = run;
                }
                word = bytes32(fill);
            }
            assembly ("memory-safe") {
                mstore(add(add(out, 0x20), mul(w, 0x20)), word)
            }
        }
        assembly ("memory-safe") {
            mstore(out, size)
        }
    }

    function _sha(bytes32 seed, uint256 w) internal view returns (bytes32 h) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, seed)
            mstore(add(p, 0x20), w)
            if iszero(staticcall(gas(), 0x02, p, 0x40, 0x00, 0x20)) { revert(0, 0) }
            h := mload(0x00)
        }
    }

    /// @dev Leaves of `leafCap` records, then branch levels of at most `branchCap` children.
    function _fileTree(bytes32[] memory ids, uint256[] memory sizes, uint256 leafCap, uint256 branchCap)
        internal
        returns (bytes32)
    {
        uint256 n = ids.length;
        if (n == 0) return fileStore.createFile(bytes32(0), "application/octet-stream", 0, bytes32(0));
        uint256 leaves = (n + leafCap - 1) / leafCap;
        Level memory lv = Level(new bytes32[](leaves), new uint256[](leaves), new uint256[](leaves));
        for (uint256 l; l < leaves; l++) {
            uint256 from = l * leafCap;
            uint256 end = from + leafCap < n ? from + leafCap : n;
            bytes memory blob = new bytes(1 + (end - from) * 38);
            for (uint256 i = from; i < end; i++) {
                bytes32 id = ids[i];
                uint256 sizeWord = sizes[i] << 208;
                uint256 at = 1 + (i - from) * 38;
                assembly ("memory-safe") {
                    let q := add(add(blob, 0x20), at)
                    mstore(q, id)
                    let next := mload(add(q, 0x26))
                    mstore(add(q, 0x20), sizeWord)
                    mstore(add(q, 0x26), next)
                }
                lv.totals[l] += sizes[i];
            }
            lv.ids[l] = fileStore.putChunkNode(blob);
            lv.counts[l] = end - from;
        }
        return fileStore.createFile(_branches(lv, branchCap, true), "application/octet-stream", 0, bytes32(0));
    }

    // ---- directories -------------------------------------------------------

    function _dir(bytes memory prog, uint256 p) internal returns (uint256) {
        uint256 n = _u(prog, p, 4);
        uint256 leafCap = _u(prog, p + 4, 2);
        uint256 branchCap = _u(prog, p + 6, 1);
        p += 7;
        if (n == 0) {
            objs.push(Obj(directoryStore.createDirectory(bytes32(0)), true));
            return p;
        }
        bytes[] memory recs = new bytes[](n);
        for (uint256 i; i < n; i++) {
            uint256 nameLen = _u(prog, p, 1);
            bytes memory name = slice(prog, p + 1, nameLen);
            bool isDir = _u(prog, p + 1 + nameLen, 1) == 1;
            Obj memory c = objs[_u(prog, p + 2 + nameLen, 4)];
            require(c.isDir == isDir, "kind");
            recs[i] = bytes.concat(bytes1(uint8(nameLen)), name, bytes1(isDir ? 0x01 : 0x00), c.cid);
            p += 6 + nameLen;
        }
        // Leaves of at most `leafCap` records and at most 24,575 bytes.
        Level memory lv = Level(new bytes32[](n), new uint256[](n), new uint256[](n));
        uint256 leaves;
        for (uint256 i0; i0 < n; leaves++) {
            uint256 end = i0;
            uint256 size = 3;
            while (end < n && end - i0 < leafCap && size + 2 + recs[end].length <= ENTRY_LEAF_MAX) {
                size += 2 + recs[end].length;
                end++;
            }
            bytes memory offs;
            bytes memory body;
            for (uint256 i = i0; i < end; i++) {
                offs = bytes.concat(offs, bytes2(uint16(body.length)));
                body = bytes.concat(body, recs[i]);
            }
            lv.ids[leaves] = directoryStore.putEntryNode(bytes.concat(hex"00", bytes2(uint16(end - i0)), offs, body));
            lv.counts[leaves] = end - i0;
            i0 = end;
        }
        assembly ("memory-safe") {
            mstore(mload(lv), leaves)
            mstore(mload(add(lv, 0x20)), leaves)
        }
        objs.push(Obj(directoryStore.createDirectory(_branches(lv, branchCap, false)), true));
        return p;
    }

    // ---- branch levels -----------------------------------------------------

    struct Level {
        bytes32[] ids;
        uint256[] counts;
        uint256[] totals;
    }

    /// @dev Group a level's nodes into branches of at most `cap` children until one node is left. A trailing group of
    ///      one (a branch needs two) joins the group before it, or takes a child from it when that one is full.
    function _branches(Level memory cur, uint256 cap, bool isFile) internal returns (bytes32) {
        uint8 level = 1;
        while (cur.ids.length > 1) {
            uint256 n = cur.ids.length;
            uint256 groups = (n + cap - 1) / cap;
            uint256[] memory starts = new uint256[](groups + 1);
            for (uint256 g; g < groups; g++) {
                starts[g] = g * cap;
            }
            starts[groups] = n;
            if (groups > 1 && n - starts[groups - 1] == 1) {
                if (starts[groups - 1] - starts[groups - 2] < 128) {
                    groups--;
                    starts[groups] = n;
                } else {
                    starts[groups - 1] -= 1;
                }
            }
            Level memory next = Level(new bytes32[](groups), new uint256[](groups), new uint256[](groups));
            for (uint256 g; g < groups; g++) {
                bytes memory b = abi.encodePacked(level, uint16(starts[g + 1] - starts[g]));
                for (uint256 i = starts[g]; i < starts[g + 1]; i++) {
                    next.counts[g] += cur.counts[i];
                    next.totals[g] += cur.totals[i];
                    b = isFile
                        ? bytes.concat(b, cur.ids[i], bytes4(uint32(next.counts[g])), bytes6(uint48(next.totals[g])))
                        : bytes.concat(b, cur.ids[i], bytes4(uint32(next.counts[g])));
                }
                next.ids[g] = isFile ? fileStore.putChunkNode(b) : directoryStore.putEntryNode(b);
            }
            cur = next;
            level++;
        }
        require(level <= 4, "at most three branch levels");
        return cur.ids[0];
    }

    function _u(bytes memory b, uint256 p, uint256 n) internal pure returns (uint256 v) {
        for (uint256 i; i < n; i++) {
            v = (v << 8) | uint8(b[p + i]);
        }
    }
}
