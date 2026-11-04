// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {IIpfsCidResolver} from "../src/interfaces/IIpfsCidResolver.sol";
import {IpfsCidResolverHarness} from "./mocks/IpfsCidResolverHarness.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

/// @notice Directories `ipfs add -r` shards into a HAMT are refused, never derived flat.
///
///         Kubo (boxo's "links" estimate) shards a directory when the sum over its entries of name bytes plus CID bytes
///         (36 for every CID here) is strictly greater than 262,144. The resolver refuses exactly those directories with
///         `DirectoryNeedsSharding`, before deriving any child, and derives every other directory as before.
///         Expectations are `ipfs-unixfs-importer`'s (`test/fixtures/sharding.json`, from `generate-sharding.mjs`, which
///         also gives the names used here). On one point the importer and Kubo differ: the importer leaves non-empty
///         subdirectories out of its estimate. The resolver counts them, as Kubo does, so it refuses wherever either
///         would shard and derives only directories both keep flat.
contract IpfsCidResolverShardingTest is BaseCompanionTest {
    uint256 internal constant THRESHOLD = 262_144;

    IpfsCidResolver internal resolver;
    IpfsCidResolverHarness internal harness;
    string internal json;
    /// @dev The one-byte file every entry links, and a directory holding it as "f".
    bytes32 internal x;
    bytes32 internal xDir;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
        harness = new IpfsCidResolverHarness(address(fileStore), address(directoryStore));
        json = vm.readFile("./test/fixtures/sharding.json");
        x = writeFile("x", "text/plain");
        string[] memory f = new string[](1);
        f[0] = "f";
        bytes32[] memory c = new bytes32[](1);
        c[0] = x;
        xDir = writeDir(f, c, new bool[](1));
    }

    // ---- at the threshold and one byte over ---------------------------------

    /// 900 names of 255 bytes and one of 208: an estimate of exactly 262,144. Kubo and the importer keep it flat, and
    /// the resolver derives the importer's CID.
    function test_exactlyAtTheThresholdDerives() public {
        bytes32 d = _longPlus(bytes(_tail(208)), false);
        assertEq(resolver.computeIpfsCid(d), _importer(0, "atThreshold", false));
    }

    /// The same with a 209-byte last name: 262,145, one byte over. The importer shards it; the resolver refuses.
    function test_oneByteOverRefuses() public {
        bytes32 d = _longPlus(bytes(_tail(209)), false);
        _expectShards(1, "oneOver");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, THRESHOLD + 1));
        resolver.computeIpfsCid(d);
    }

    /// 900 entries can never pass the threshold (900 x 291 = 261,900), so their names are not even counted: the two
    /// derivation passes read the first page twice, and nothing reads it a third time.
    function test_900LongNamesDeriveWithoutCounting() public {
        bytes32 d = writeLargeDir(_longNames(900), _same(x, 900), new bool[](900));
        vm.expectCall(address(directoryStore), abi.encodeCall(IDirectoryStore.getEntries, (d, 0, 64)), 2);
        assertEq(resolver.computeIpfsCid(d), _importer(2, "long900", false));
    }

    /// 901 names of 255 bytes: 262,191, past the threshold at the last entry.
    function test_901LongNamesRefuse() public {
        bytes32 d = writeLargeDir(_longNames(901), _same(x, 901), new bool[](901));
        _expectShards(3, "long901");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 262_191));
        resolver.computeIpfsCid(d);
    }

    // ---- refusal comes first, and costs little ------------------------------

    /// 5,300 names of 14 bytes (265,000 in all) pass the threshold at entry 5,243 (5,243 x 50 = 262,150). Counting
    /// stops there, and no child is derived: no file is read, no chunk is read.
    function test_5300ShortNamesRefuseBeforeAnyChild() public {
        bytes[] memory names = new bytes[](5300);
        for (uint256 i; i < 5300; i++) {
            names[i] = bytes.concat("img-", _digits(i, 6), ".png");
        }
        bytes32 d = writeLargeDir(names, _same(x, 5300), new bool[](5300));
        _expectShards(4, "img5300");
        vm.expectCall(address(fileStore), abi.encodeWithSelector(IFileStore.getFileInfo.selector), 0);
        vm.expectCall(address(chunkStore), abi.encodeWithSelector(IChunkStore.read.selector), 0);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 262_150));
        uint256 g = gasleft();
        resolver.computeIpfsCid(d);
        uint256 used = g - gasleft();
        emit log_named_uint("gas to refuse 5,300 entries (5,243 counted)", used);
        // Measured 24.8M. Without the page release in `_refuseSharded` it is 32.8M, so this also guards that release.
        assertLt(used, 27_000_000, "refusal gas");
    }

    /// 7,085 entries pass the threshold whatever their names (7,085 x 37 = 262,145, every name being at least a byte),
    /// so the count alone refuses: not one name is read.
    function test_entryCountAloneRefuses() public {
        bytes[] memory names = new bytes[](7085);
        for (uint256 i; i < 7085; i++) {
            names[i] = _digits(i, 5);
        }
        bytes32 d = writeLargeDir(names, _same(x, 7085), new bool[](7085));
        _expectShards(5, "short7085");
        vm.expectCall(address(directoryStore), abi.encodeWithSelector(IDirectoryStore.getEntries.selector), 0);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 7085 * 37));
        uint256 g = gasleft();
        resolver.computeIpfsCid(d);
        uint256 used = g - gasleft();
        emit log_named_uint("gas to refuse 7,085 entries by count", used);
        assertLt(used, 100_000, "a refusal by count reads no name");
    }

    // ---- subdirectories count like any entry --------------------------------

    /// A subdirectory brings the estimate to exactly 262,144: flat for Kubo and the importer, derived here.
    function test_subdirectoryAtTheThresholdDerives() public {
        bytes32 d = _longPlus(bytes(_tail(208)), true);
        assertEq(resolver.computeIpfsCid(d), _importer(6, "subdirectoryAtThreshold", false));
    }

    /// A subdirectory takes the estimate past the threshold. Kubo shards it; the importer, which leaves non-empty
    /// subdirectories out of its estimate, keeps it flat (the fixture records that). The resolver follows Kubo.
    function test_subdirectoryOverRefuses() public {
        bytes32 d = _longPlus(bytes(_tail(255)), true);
        assertTrue(vm.parseJsonBool(json, ".[7].kuboShards"), "Kubo shards it");
        assertEq(vm.parseJsonString(json, ".[7].importerType"), "directory", "the importer does not");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 262_191));
        resolver.computeIpfsCid(d);
    }

    /// An empty subdirectory has a CID from the start, so the importer counts it too: both shard.
    function test_emptySubdirectoryOverRefuses() public {
        string[] memory none = new string[](0);
        assertEq(writeDir(none, new bytes32[](0), new bool[](0)), directoryStore.EMPTY_DIRECTORY());
        bytes[] memory names = _longNames(901);
        names[900] = bytes(_tail(255));
        bytes32[] memory cids = _same(x, 901);
        cids[900] = directoryStore.EMPTY_DIRECTORY();
        bool[] memory dirs = new bool[](901);
        dirs[900] = true;
        bytes32 d = writeLargeDir(names, cids, dirs);
        _expectShards(8, "emptySubdirectoryOver");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 262_191));
        resolver.computeIpfsCid(d);
    }

    /// A refused directory refuses every directory above it, with its own CID in the error.
    function test_refusalReachesTheRoot() public {
        bytes32 d = _longPlus(bytes(_tail(209)), false);
        string[] memory n = new string[](1);
        n[0] = "big";
        bytes32[] memory c = new bytes32[](1);
        c[0] = d;
        bool[] memory dirs = new bool[](1);
        dirs[0] = true;
        bytes32 parent = writeDir(n, c, dirs);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, THRESHOLD + 1));
        resolver.computeIpfsCid(parent);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, THRESHOLD + 1));
        resolver.directoryLink(parent);
    }

    // ---- the decision, over any entry list ----------------------------------

    /// Entry lists summing to the threshold plus or minus three, with the extra bytes anywhere: refused exactly when
    /// the sum passes it, at the last entry (the sum before it is at least 37 lower).
    function testFuzz_refusesExactlyPastTheThreshold(uint256 countSeed, int256 deltaSeed, uint256 shift) public {
        uint256 n = bound(countSeed, 901, 1500);
        int256 delta = bound(deltaSeed, -3, 3);
        uint256 total = uint256(int256(THRESHOLD) + delta);
        uint256[] memory lens = new uint256[](n);
        uint256 nameBytes = total - 36 * n;
        shift %= n;
        for (uint256 i; i < n; i++) {
            lens[(i + shift) % n] = nameBytes / n + (i < nameBytes % n ? 1 : 0);
        }
        bytes32 d = keccak256(abi.encode("mocked", n, delta, shift));
        _mockEntries(d, lens);
        if (total > THRESHOLD) {
            vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, total));
        }
        harness.refuseSharded(d, n);
    }

    /// Names of random lengths: refused at the first entry whose running sum passes the threshold, with that sum, or
    /// not at all.
    function testFuzz_refusesAtTheFirstEntryPast(uint256 countSeed, uint256 seed) public {
        uint256 n = bound(countSeed, 901, 2500);
        uint256[] memory lens = new uint256[](n);
        uint256 run;
        uint256 crossing;
        for (uint256 i; i < n; i++) {
            lens[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % (seed % 2 == 0 ? 255 : 150);
            run += lens[i] + 36;
            if (crossing == 0 && run > THRESHOLD) crossing = run;
        }
        bytes32 d = keccak256(abi.encode("mocked", n, seed));
        _mockEntries(d, lens);
        if (crossing != 0) {
            vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, crossing));
        }
        harness.refuseSharded(d, n);
    }

    /// The count shortcut sits exactly at 7,085 entries: 7,084 one-byte names (262,108) are read and pass; 7,085 entries
    /// are refused unread.
    function test_countShortcutBoundary() public {
        uint256[] memory ones = new uint256[](7084);
        for (uint256 i; i < 7084; i++) {
            ones[i] = 1;
        }
        bytes32 d = keccak256("one-byte names");
        _mockEntries(d, ones);
        harness.refuseSharded(d, 7084);
        vm.expectCall(address(directoryStore), abi.encodeWithSelector(IDirectoryStore.getEntries.selector), 0);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNeedsSharding.selector, d, 262_145));
        harness.refuseSharded(d, 7085);
    }

    // ---- every CID the profile links is 36 bytes ----------------------------

    /// The estimate counts 36 bytes per CID. Every kind of child the profile links is a CIDv1 with a one-byte codec
    /// (0x55 or 0x70) and a sha2-256 multihash: 1 + 1 + 2 + 32 bytes, which base32 writes as 58 symbols after "b".
    function test_everyChildCidIs36Bytes() public {
        bytes32 rawLeaf = writeFile("hello\n", "text/plain");
        bytes32 dagPbFile = writeFile(deterministicBytes(262_145, "two blocks"), "application/octet-stream");
        bytes32 emptyFile = fileStore.createFile(bytes32(0), "text/plain", 0, bytes32(0));
        bytes32 emptyDir = directoryStore.EMPTY_DIRECTORY();
        (uint256 c1,,) = resolver.fileLink(rawLeaf);
        (uint256 c2,,) = resolver.fileLink(dagPbFile);
        (uint256 c3,,) = resolver.fileLink(emptyFile);
        (uint256 c4,,) = resolver.directoryLink(xDir);
        (uint256 c5,,) = resolver.directoryLink(emptyDir);
        assertEq(c1, 0x55, "raw leaf");
        assertEq(c2, 0x70, "dag-pb file");
        assertEq(c3, 0x55, "empty file");
        assertEq(c4, 0x70, "directory");
        assertEq(c5, 0x70, "empty directory");
        assertEq(bytes(resolver.computeFileCid(rawLeaf)).length, 59);
        assertEq(bytes(resolver.computeFileCid(dagPbFile)).length, 59);
        assertEq(bytes(resolver.computeFileCid(emptyFile)).length, 59);
        assertEq(bytes(resolver.computeIpfsCid(xDir)).length, 59);
        assertEq(bytes(resolver.computeIpfsCid(emptyDir)).length, 59);
    }

    // ---- helpers ---------------------------------------------------------------

    /// @dev 900 long names linking `x`, then `last` linking `x` or the directory holding it.
    function _longPlus(bytes memory last, bool lastIsDir) internal returns (bytes32) {
        bytes[] memory names = _longNames(901);
        names[900] = last;
        bytes32[] memory cids = _same(x, 901);
        bool[] memory dirs = new bool[](901);
        if (lastIsDir) (cids[900], dirs[900]) = (xDir, true);
        return writeLargeDir(names, cids, dirs);
    }

    /// @dev long(i): "a" x 249, then i in six digits.
    function _longNames(uint256 n) internal pure returns (bytes[] memory names) {
        names = new bytes[](n);
        bytes memory as249 = bytes(_repeat("a", 249));
        for (uint256 i; i < n; i++) {
            names[i] = bytes.concat(as249, _digits(i, 6));
        }
    }

    function _tail(uint256 n) internal pure returns (string memory) {
        return _repeat("b", n);
    }

    function _repeat(bytes1 c, uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; i++) {
            b[i] = c;
        }
        return string(b);
    }

    function _digits(uint256 v, uint256 width) internal pure returns (bytes memory b) {
        b = new bytes(width);
        for (uint256 i = width; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
    }

    function _same(bytes32 cid, uint256 n) internal pure returns (bytes32[] memory cids) {
        cids = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            cids[i] = cid;
        }
    }

    /// @dev The importer's CID for a case it keeps flat.
    function _importer(uint256 k, string memory label, bool shards) internal view returns (string memory) {
        string memory at = string.concat(".[", vm.toString(k), "]");
        assertEq(vm.parseJsonString(json, string.concat(at, ".label")), label, "fixture order");
        assertEq(vm.parseJsonBool(json, string.concat(at, ".kuboShards")), shards, "Kubo");
        assertEq(
            vm.parseJsonString(json, string.concat(at, ".importerType")), "directory", "the importer keeps it flat"
        );
        return vm.parseJsonString(json, string.concat(at, ".importerCid"));
    }

    /// @dev A case both Kubo and the importer shard.
    function _expectShards(uint256 k, string memory label) internal view {
        string memory at = string.concat(".[", vm.toString(k), "]");
        assertEq(vm.parseJsonString(json, string.concat(at, ".label")), label, "fixture order");
        assertTrue(vm.parseJsonBool(json, string.concat(at, ".kuboShards")), "Kubo shards it");
        assertEq(
            vm.parseJsonString(json, string.concat(at, ".importerType")),
            "hamt-sharded-directory",
            "so does the importer"
        );
    }

    /// @dev Answer `getEntries` for `d` page by page (64 entries) with names of the given lengths.
    function _mockEntries(bytes32 d, uint256[] memory lens) internal {
        uint256 n = lens.length;
        for (uint256 start; start < n; start += 64) {
            uint256 end = start + 64 < n ? start + 64 : n;
            IDirectoryStore.Entry[] memory es = new IDirectoryStore.Entry[](end - start);
            for (uint256 i = start; i < end; i++) {
                es[i - start] = IDirectoryStore.Entry({name: string(new bytes(lens[i])), cid: x, isDirectory: false});
            }
            vm.mockCall(
                address(directoryStore), abi.encodeCall(IDirectoryStore.getEntries, (d, start, end)), abi.encode(es)
            );
        }
    }
}
