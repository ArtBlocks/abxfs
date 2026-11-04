// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibZip} from "solady/utils/LibZip.sol";

import {BaseCompanionTest} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";

/// @notice Gas of derivation, measured around the resolver call only. Files repeat one stored chunk, so after the first
///         read every chunk access is warm: real files cost about 8.5k more per distinct chunk (three cold record slots
///         and a cold SSTORE2 account).
contract IpfsCidResolverGasTest is BaseCompanionTest {
    IpfsCidResolver internal resolver;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
    }

    function _repeatFile(bytes32 id, uint256 size, uint256 records) internal returns (bytes32) {
        bytes32[] memory ids = new bytes32[](records);
        uint256[] memory sizes = new uint256[](records);
        for (uint256 i; i < records; i++) (ids[i], sizes[i]) = (id, size);
        return createFileFromChunks(ids, sizes, "application/octet-stream");
    }

    function _measure(bytes32 cid) internal view returns (uint256 used) {
        uint256 g = gasleft();
        resolver.computeFileCid(cid);
        used = g - gasleft();
    }

    function test_gas_rawPerByte() public {
        bytes32 id = rawChunk(deterministicBytes(RAW_MAX, "gas"));
        uint256 small = _measure(_repeatFile(id, RAW_MAX, 43)); // ~1 MiB
        uint256 large = _measure(_repeatFile(id, RAW_MAX, 171)); // ~4 MiB
        emit log_named_uint("raw: gas for 43 chunks (1,056,725 bytes)", small);
        emit log_named_uint("raw: gas for 171 chunks (4,202,325 bytes)", large);
        emit log_named_uint("raw: marginal gas per 1,000 bytes", (large - small) * 1000 / (128 * RAW_MAX));
    }

    function test_gas_flzTextPerByte() public {
        bytes memory text = new bytes(65_536);
        bytes memory words = "<p>The quick brown fox jumps over the lazy dog; ABX FS stores sites on chain.</p>\n";
        for (uint256 i; i < text.length; i++) text[i] = words[i % words.length];
        bytes32 id = flzChunk(text);
        uint256 small = _measure(_repeatFile(id, text.length, 4));
        uint256 large = _measure(_repeatFile(id, text.length, 16));
        emit log_named_uint("flz text: marginal gas per 1,000 inflated bytes", (large - small) * 1000 / (12 * 65_536));
    }

    function test_gas_flzRunsPerByte() public {
        bytes memory runs = runBytes(65_536);
        bytes32 id = flzChunk(runs);
        uint256 small = _measure(_repeatFile(id, runs.length, 4));
        uint256 large = _measure(_repeatFile(id, runs.length, 16));
        emit log_named_uint("flz runs: marginal gas per 1,000 inflated bytes", (large - small) * 1000 / (12 * 65_536));
    }

    /// Whole calls on small content, where the fixed costs (memory, store calls, the base32 string) dominate. A small
    /// file touches only the memory its data needs, not the whole block buffer (it cost 269k before the chunk-id call
    /// moved out of the space past the buffer and the base32 encoder was rewritten).
    function test_gas_smallCalls() public {
        uint256 small = _measure(writeFile(bytes("hello\n"), "text/plain"));
        emit log_named_uint("computeFileCid, 6-byte file", small);
        assertLt(small, 60_000, "a small file never pays for the block buffer");
        emit log_named_uint(
            "computeFileCid, 20,000-byte file", _measure(writeFile(deterministicBytes(20_000, "g"), "text/plain"))
        );
        emit log_named_uint("computeIpfsCid, the empty directory", _measureDir(directoryStore.EMPTY_DIRECTORY()));
        string[] memory names = new string[](100);
        bytes32[] memory cids = new bytes32[](100);
        for (uint256 i; i < 100; i++) {
            names[i] = string(abi.encodePacked("f", bytes1(uint8(48 + i / 10)), bytes1(uint8(48 + i % 10))));
            cids[i] = writeFile(abi.encodePacked("file ", i), "text/plain");
        }
        emit log_named_uint(
            "computeIpfsCid, 100 small files", _measureDir(writeDir(names, cids, new bool[](100)))
        );
    }

    function test_gas_readOneChunk() public {
        bytes memory d = deterministicBytes(RAW_MAX, "one");
        bytes32 id = rawChunk(d);
        uint256 g = gasleft();
        chunkStore.read(id);
        emit log_named_uint("ChunkStore.read of one 24,575-byte raw chunk (warm)", g - gasleft());
        bytes memory text = runBytes(65_536);
        bytes32 fid = flzChunk(text);
        g = gasleft();
        chunkStore.read(fid);
        emit log_named_uint("ChunkStore.read of one 65,536-byte FastLZ runs chunk (warm)", g - gasleft());
        bytes memory packed = LibZip.flzCompress(text);
        g = gasleft();
        LibZip.flzDecompress(packed);
        emit log_named_uint("LibZip.flzDecompress of the same, in the test frame", g - gasleft());
    }

    /// Siblings reuse one arena, so a directory of 2N files costs twice a directory of N (no quadratic memory).
    function test_gas_directoryScalesLinearly() public {
        bytes32 f = writeFile(deterministicBytes(300_000, "dir-file"), "application/octet-stream");
        uint256 g4 = _measureDir(_flatDir(f, 4));
        uint256 g16 = _measureDir(_flatDir(f, 16));
        emit log_named_uint("dir: 4 files of 300,000 bytes", g4);
        emit log_named_uint("dir: 16 files of 300,000 bytes", g16);
        // Linear within 5%: 16 files cost about 4x four files.
        assertApproxEqRel(g16, g4 * 4, 0.05e18);
    }

    /// Nesting is internal recursion; past the EVM stack it reverts. The tree is built once, then the deepest level
    /// that derives within a generous 100M-gas allowance is found by bisection, so gas never decides the answer.
    function test_depthLimit() public {
        uint256 maxDepth = 128;
        bytes32[] memory atDepth = new bytes32[](maxDepth + 1);
        bytes32 cur = writeFile(bytes("leaf"), "text/plain");
        bool isDir;
        for (uint256 depth = 1; depth <= maxDepth; depth++) {
            string[] memory names = new string[](1);
            names[0] = "d";
            bytes32[] memory cids = new bytes32[](1);
            cids[0] = cur;
            bool[] memory dirs = new bool[](1);
            dirs[0] = isDir;
            cur = writeDir(names, cids, dirs);
            atDepth[depth] = cur;
            isDir = true;
        }
        uint256 lo = 1; // derives
        uint256 hi = maxDepth + 1; // assumed not to
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_derives(atDepth[mid])) lo = mid;
            else hi = mid;
        }
        emit log_named_uint("deepest directory nesting that derives", lo);
        assertGe(lo, 32, "at least as deep as one resolvePath call");
    }

    /// ACCEPTED: nothing is memoised, so a child is derived once per link to it. A directory whose two entries are the
    /// same directory, nested `d` deep, is `d` entry nodes on chain but 2^d derivations of the file at the bottom: each
    /// level about doubles the gas. Such a tree runs out of gas; it never derives a wrong CID. Memoising would need
    /// memory that outlives the arenas, and real trees repeat files (`node_modules`, assets), not whole subtrees.
    function test_gas_sharedChildrenCostExponentially() public {
        bytes32 cur = writeFile(bytes("x"), "text/plain");
        bool isDir;
        uint256 prev;
        for (uint256 depth = 1; depth <= 10; depth++) {
            bytes1 flag = isDir ? bytes1(0x01) : bytes1(0x00);
            cur = directoryStore.createDirectory(
                directoryStore.putEntryNode(
                    bytes.concat(hex"00", hex"0002", hex"0000", hex"0023", hex"0161", flag, cur, hex"0162", flag, cur)
                )
            );
            isDir = true;
            uint256 g = _measureDir(cur);
            if (depth >= 6) {
                emit log_named_uint(string.concat("two links to the same child, depth ", vm.toString(depth)), g);
                assertGt(g * 10, prev * 19, "about twice the level below");
            }
            prev = g;
        }
    }

    function _derives(bytes32 cid) internal view returns (bool) {
        try resolver.computeIpfsCid{gas: 100_000_000}(cid) returns (string memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _flatDir(bytes32 f, uint256 n) internal returns (bytes32) {
        string[] memory names = new string[](n);
        bytes32[] memory cids = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            names[i] = string(abi.encodePacked("f", bytes1(uint8(65 + i))));
            cids[i] = f;
        }
        return writeDir(names, cids, new bool[](n));
    }

    function _measureDir(bytes32 cid) internal view returns (uint256 used) {
        uint256 g = gasleft();
        resolver.computeIpfsCid(cid);
        used = g - gasleft();
    }
}
