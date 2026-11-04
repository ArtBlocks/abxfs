// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest, UnreadableBackend} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {IIpfsCidResolver} from "../src/interfaces/IIpfsCidResolver.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {CID} from "@abxfs/protobuf/CID.sol";
import {DagPB} from "@abxfs/protobuf/DagPB.sol";
import {UnixFS} from "@abxfs/protobuf/UnixFS.sol";

/// @notice The resolver against vectors produced OFF chain: `ipfs-unixfs-importer` fixtures (which depend only on
///         content and names) and the SDK's `ipfsFileCidWithSize` / `ipfsDirectoryCid`, each cross-checked
///         against `ipfs-unixfs-importer`. No expectation is derived from the resolver itself.
contract IpfsCidResolverTest is BaseCompanionTest {
    IpfsCidResolver internal resolver;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
    }

    function _names(string memory a) internal pure returns (string[] memory n) {
        n = new string[](1);
        n[0] = a;
    }

    function _names(string memory a, string memory b) internal pure returns (string[] memory n) {
        n = new string[](2);
        (n[0], n[1]) = (a, b);
    }

    function _cids(bytes32 a) internal pure returns (bytes32[] memory c) {
        c = new bytes32[](1);
        c[0] = a;
    }

    function _cids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory c) {
        c = new bytes32[](2);
        (c[0], c[1]) = (a, b);
    }

    function _dirs(bool a) internal pure returns (bool[] memory d) {
        d = new bool[](1);
        d[0] = a;
    }

    function _dirs(bool a, bool b) internal pure returns (bool[] memory d) {
        d = new bool[](2);
        (d[0], d[1]) = (a, b);
    }

    // ─────────────────── Vectors from ipfs-unixfs-importer ───────────────────

    function test_singleSmallFile() public {
        bytes32 f = writeFile(bytes("hello\n"), "text/plain");
        assertEq(resolver.computeFileCid(f), "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
        (uint256 codec, bytes32 digest, uint256 tsize) = resolver.fileLink(f);
        assertEq(codec, 0x55);
        assertEq(digest, 0x5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03);
        assertEq(tsize, 6);
    }

    function test_twoFileDirectory() public {
        bytes32 d = writeDir(
            _names("a.txt", "b.txt"),
            _cids(writeFile(bytes("alpha"), "text/plain"), writeFile(bytes("beta"), "text/plain")),
            _dirs(false, false)
        );
        assertEq(resolver.computeIpfsCid(d), "bafybeibxcoycwgpijt7dpfnkmoy6ikbjdqtrsljuoauatmohmlou3tb23a");
    }

    function test_nestedDirectories() public {
        bytes32 inner = writeDir(_names("l.txt"), _cids(writeFile(bytes("leaf"), "text/plain")), _dirs(false));
        bytes32 outer = writeDir(_names("inner"), _cids(inner), _dirs(true));
        // The outer link's Tsize is cumulative: 53 (inner block) + 4 (raw "leaf").
        assertEq(resolver.computeIpfsCid(outer), "bafybeif4srdnpctid4t4zf3w3c576kyxeii6ovoqbd4aguzy7s5iwy46pa");
        assertEq(resolver.computeIpfsCid(inner), "bafybeiddvzalyat4hfxk4gmphkncxiiy4zjmassy6wcq3wlds32qddglfe");
        (,, uint256 tsize) = resolver.directoryLink(inner);
        assertEq(tsize, 57);
    }

    /// fixtures/nested-chunked.json: a 280 KiB (two-block) file and a sibling under sub/, under root/.
    function test_nestedWithChunkedFile() public {
        bytes32 big = writeFile(deterministicBytes(280 * 1024, "nested-chunked"), "application/octet-stream");
        bytes32 note = writeFile(bytes("hello from inside the subdirectory\n"), "text/plain");
        bytes32 sub = writeDir(_names("big.bin", "note.txt"), _cids(big, note), _dirs(false, false));
        bytes32 root = writeDir(_names("sub"), _cids(sub), _dirs(true));
        assertEq(resolver.computeIpfsCid(root), "bafybeifllaegbpepwifwm7jpyaopntcjtbouh3cqq2vjp6nyauzvy2tmoe");
        assertEq(resolver.computeIpfsCid(sub), "bafybeibphmfjjukcpirhkuv52n5aqxldii3vabcw7nhnb7brbbn5kxpmfm");
        assertEq(resolver.computeFileCid(big), "bafybeiertmu2yxxbydwhjlxcuw3ykvwvn6shpnqvhzdlhpuzfrewnzoysm");
    }

    function test_dottedFilenames() public {
        string[] memory names = new string[](3);
        (names[0], names[1], names[2]) = (".gitignore", "README.md", "package.json");
        bytes32[] memory cids = new bytes32[](3);
        cids[0] = writeFile(bytes("node_modules\n"), "text/plain");
        cids[1] = writeFile(bytes("# Demo\n"), "text/markdown");
        cids[2] = writeFile(bytes('{"name":"demo"}'), "application/json");
        bytes32 d = writeDir(names, cids, new bool[](3));
        assertEq(resolver.computeIpfsCid(d), "bafybeigyrfeofgyduhdwhvqjn3rj5tqqpevrelfghfp7p4v7vhgb6thyzq");
    }

    /// fixtures/multi-block-files.json "two-chunk-file": 256 KiB + 1 KiB.
    function test_twoBlockFile() public {
        bytes32 f = writeFile(deterministicBytes(263_168, "two-chunk-file"), "application/octet-stream");
        assertEq(resolver.computeFileCid(f), "bafybeibvo6ge7pbsu4qnsedhcrqadpgioj75ejjdhnkt2czgjhy5fhrkri");
    }

    // ─────────────────── Block boundaries (SDK + importer vectors) ───────────────────

    function test_exactlyOneBlock() public {
        bytes32 f = writeFile(deterministicBytes(262_144, "exact-block"), "application/octet-stream");
        assertEq(resolver.computeFileCid(f), "bafkreigp4axaimfyrj57qsxkhnfwb5h2m7sxlhn5dqjgdqff3pfr655ddm");
        (uint256 codec,, uint256 tsize) = resolver.fileLink(f);
        assertEq(codec, 0x55, "a single block stays raw");
        assertEq(tsize, 262_144);
    }

    function test_oneBlockPlusOneByte() public {
        bytes32 f = writeFile(deterministicBytes(262_145, "block-plus-one"), "application/octet-stream");
        assertEq(resolver.computeFileCid(f), "bafybeihdrpc5h5upefeuowwbbtaozqqhupyrszdkmltxmxy4fv6pphiry4");
        (uint256 codec,, uint256 tsize) = resolver.fileLink(f);
        assertEq(codec, 0x70);
        assertEq(tsize, 262_249);
    }

    /// Chunk sizes unrelated to 256 KiB, so chunk boundaries straddle block boundaries everywhere, including tiny
    /// chunks at a boundary.
    function test_mixedChunkSizesStraddlingBlocks() public {
        bytes memory data = deterministicBytes(1_060_921, "mixed-chunks");
        uint256[6] memory cycle = [uint256(24_575), 1000, 17_777, 9, 24_575, 3333];
        uint256 count;
        for (uint256 off; off < data.length; count++) off += cycle[count % 6];
        uint256[] memory sizes = new uint256[](count);
        uint256 used;
        for (uint256 i; i < count; i++) {
            sizes[i] = i + 1 == count ? data.length - used : cycle[i % 6];
            used += sizes[i];
        }
        bytes32 f = writeFileSized(data, sizes, false, "application/octet-stream");
        assertEq(resolver.computeFileCid(f), "bafybeibvefj5nele4keawpal2miuw2l5ecbncu66ihd7xsgjysh3vr2rra");
        (,, uint256 tsize) = resolver.fileLink(f);
        assertEq(tsize, 1_061_177);
    }

    /// The same content stored raw and as FastLZ chunks (inflated on chain) has one IPFS CID.
    function test_fastLzEqualsRaw() public {
        bytes memory data = runBytes(600_000);
        bytes32 rawFile = writeFile(data, "application/octet-stream");
        uint256[] memory sizes = new uint256[](4);
        (sizes[0], sizes[1], sizes[2], sizes[3]) = (150_000, 150_000, 150_000, 150_000);
        bytes32 flzFile = writeFileSized(data, sizes, true, "application/octet-stream");
        assertTrue(rawFile != flzFile, "different ABX FS CIDs");
        string memory expected = "bafybeiadwidwfwo7d7opoge2hqav74rwacxbnxzvvqpypmxajvzjqqmqvy";
        assertEq(resolver.computeFileCid(rawFile), expected);
        assertEq(resolver.computeFileCid(flzFile), expected);
        (,, uint256 tsize) = resolver.fileLink(flzFile);
        assertEq(tsize, 600_158);
    }

    /// One FastLZ chunk inflating to 600,000 bytes: more than two blocks and more than the block buffer, so a single
    /// read grows the buffer in place and fills it twice over before it is hashed and shifted down. Same CID as above.
    function test_oneChunkOfManyBlocks() public {
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = 600_000;
        bytes32 f = writeFileSized(runBytes(600_000), sizes, true, "application/octet-stream");
        assertEq(resolver.computeFileCid(f), "bafybeiadwidwfwo7d7opoge2hqav74rwacxbnxzvvqpypmxajvzjqqmqvy");
        (,, uint256 tsize) = resolver.fileLink(f);
        assertEq(tsize, 600_158);
    }

    // ─────────────────── Empty files and directories ───────────────────

    function test_emptyFile() public {
        bytes32 f = fileStore.createFile(bytes32(0), "text/plain", 0, bytes32(0));
        assertEq(resolver.computeFileCid(f), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
        (uint256 codec, bytes32 digest, uint256 tsize) = resolver.fileLink(f);
        assertEq(codec, 0x55);
        assertEq(digest, sha256(""));
        assertEq(tsize, 0);
    }

    function test_emptyDirectory() public {
        bytes32 empty = directoryStore.EMPTY_DIRECTORY();
        assertEq(resolver.computeIpfsCid(empty), "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
        (, bytes32 digest, uint256 tsize) = resolver.directoryLink(empty);
        assertEq(digest, sha256(hex"0a020801"));
        assertEq(tsize, 4);
    }

    function test_directoryHoldingEmptyFileAndEmptyDirectory() public {
        bytes32 emptyFile = fileStore.createFile(bytes32(0), "text/plain", 0, bytes32(0));
        bytes32 d = writeDir(
            _names(".nojekyll", "e"), _cids(emptyFile, directoryStore.EMPTY_DIRECTORY()), _dirs(false, true)
        );
        assertEq(resolver.computeIpfsCid(d), "bafybeiclcy44vdcyb6atlmofnggbvdfxq3gzisx4i6tzvnc4ldd5mulcgu");
        (,, uint256 tsize) = resolver.directoryLink(d);
        assertEq(tsize, 106);
    }

    /// site/ { assets/ { a.bin }, index.html } with index.html two blocks of FastLZ chunks: every Tsize path at once.
    function test_siteWithFastLzAndNesting() public {
        bytes32 aBin = writeFile(deterministicBytes(5000, "a"), "application/octet-stream");
        uint256[] memory sizes = new uint256[](2);
        (sizes[0], sizes[1]) = (200_000, 100_000);
        bytes32 index = writeFileSized(runBytes(300_000), sizes, true, "text/html");
        bytes32 assets = writeDir(_names("a.bin"), _cids(aBin), _dirs(false));
        bytes32 site = writeDir(_names("assets", "index.html"), _cids(assets, index), _dirs(true, false));
        assertEq(resolver.computeIpfsCid(site), "bafybeib7teztbv25jtv3ra5wijdpadybqhx77ckdacawmjjg6ocdzscs6m");
        assertEq(resolver.computeIpfsCid(assets), "bafybeifxj2bvptojaeakri7qoiuogfthsqroeukevi3he2zglorf2uwdd4");
        assertEq(resolver.computeFileCid(index), "bafybeiez3mw6gw6uwcv5yxs5rqaxkjxn6v7obc7kdbaitts3e3ioz7gpbu");
        (,, uint256 siteT) = resolver.directoryLink(site);
        (,, uint256 assetsT) = resolver.directoryLink(assets);
        (,, uint256 indexT) = resolver.fileLink(index);
        assertEq(siteT, 305_273);
        assertEq(assetsT, 5054);
        assertEq(indexT, 300_108);
    }

    // ─────────────────── Refusals ───────────────────

    function test_codecNotSupported() public {
        bytes memory d = bytes("gzip stream would go here");
        bytes32 id = rawChunk(d);
        bytes32 leaf = fileStore.putChunkNode(abi.encodePacked(hex"00", id, uint48(d.length)));
        bytes32 f = fileStore.createFile(leaf, "text/plain", bytes32("gzip"), keccak256("decoded"));
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.CodecNotSupported.selector, bytes32("gzip")));
        resolver.computeFileCid(f);
        // A directory holding it cannot be derived either.
        bytes32 dir = writeDir(_names("x.txt"), _cids(f), _dirs(false));
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.CodecNotSupported.selector, bytes32("gzip")));
        resolver.computeIpfsCid(dir);
    }

    function test_unreadableChunkReverts() public {
        UnreadableBackend logs = new UnreadableBackend();
        bytes memory d = bytes("only in a log");
        bytes32 id = chunkStore.write(address(logs), d, keccak256(d), uint48(d.length));
        bytes32 leaf = fileStore.putChunkNode(abi.encodePacked(hex"00", id, uint48(d.length)));
        bytes32 f = fileStore.createFile(leaf, "text/plain", 0, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(logs)));
        resolver.computeFileCid(f);
    }

    function test_notFound() public {
        bytes32 ghost = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNotFound.selector, ghost));
        resolver.computeIpfsCid(ghost);
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.FileNotFound.selector, ghost));
        resolver.computeFileCid(ghost);
        // A file is not a directory and the other way round.
        bytes32 f = writeFile(bytes("x"), "text/plain");
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.DirectoryNotFound.selector, f));
        resolver.computeIpfsCid(f);
        bytes32 empty = directoryStore.EMPTY_DIRECTORY();
        vm.expectRevert(abi.encodeWithSelector(IIpfsCidResolver.FileNotFound.selector, empty));
        resolver.computeFileCid(empty);
    }

    /// The resolver no longer asks the stores whether a CID exists before reading it: for a CID they do not hold,
    /// `getFileInfo` and `entryCount` revert with errors of the same name and argument as this interface's, and the
    /// resolver passes them up untouched. Same selector, same argument, so callers decoding either see no difference.
    function test_notFoundIsTheStoresOwnRevert() public {
        assertEq(FileStore.FileNotFound.selector, IIpfsCidResolver.FileNotFound.selector);
        assertEq(DirectoryStore.DirectoryNotFound.selector, IIpfsCidResolver.DirectoryNotFound.selector);
        bytes32 ghost = keccak256("nope");
        vm.expectCall(address(fileStore), abi.encodeCall(fileStore.fileExists, (ghost)), 0);
        vm.expectRevert(abi.encodeWithSelector(FileStore.FileNotFound.selector, ghost));
        resolver.fileLink(ghost);
        vm.expectCall(address(directoryStore), abi.encodeCall(directoryStore.directoryExists, (ghost)), 0);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.DirectoryNotFound.selector, ghost));
        resolver.directoryLink(ghost);
    }

    /// Names are bytes, and the resolver links them byte for byte. Names that are not UTF-8 (the store accepts them)
    /// stay distinct, as in Kubo, whose names are Go strings. JavaScript tools that decode a name as text before
    /// hashing would turn both 0xfe and 0xff into U+FFFD and derive something else.
    function test_namesAreHashedAsRawBytes() public {
        bytes32 f = writeFile(bytes("x"), "text/plain");
        bytes32 d = directoryStore.createDirectory(
            directoryStore.putEntryNode(
                bytes.concat(hex"00", hex"0002", hex"0000", hex"0023", hex"01fe00", f, hex"01ff00", f)
            )
        );
        DagPB.Link[] memory links = new DagPB.Link[](2);
        bytes memory leaf = CID.binary(CID.CODEC_RAW, sha256("x"));
        links[0] = DagPB.Link({hash: leaf, name: string(bytes(hex"fe")), tsize: 1});
        links[1] = DagPB.Link({hash: leaf, name: string(bytes(hex"ff")), tsize: 1});
        bytes memory node = DagPB.encodeNode(links, UnixFS.directoryData());
        assertEq(resolver.computeIpfsCid(d), CID.encode(CID.CODEC_DAG_PB, sha256(node)));
        // the replacement-character reading of both names would be another node
        links[0].name = string(hex"efbfbd"); // U+FFFD
        links[1].name = string(hex"efbfbd");
        assertTrue(sha256(DagPB.encodeNode(links, UnixFS.directoryData())) != sha256(node));
    }

    function test_constructorRefusesMismatchedStores() public {
        FileStore otherFiles = new FileStore(address(chunkStore));
        vm.expectRevert(IIpfsCidResolver.StoreMismatch.selector);
        new IpfsCidResolver(address(otherFiles), address(directoryStore));
        DirectoryStore otherDirs = new DirectoryStore(address(otherFiles));
        IpfsCidResolver ok = new IpfsCidResolver(address(otherFiles), address(otherDirs));
        assertEq(address(ok.chunkStore()), address(chunkStore));
    }

    function test_deterministic() public {
        bytes32 d = writeDir(
            _names("a", "b"),
            _cids(writeFile(bytes("one"), "text/plain"), writeFile(bytes("two"), "text/plain")),
            _dirs(false, false)
        );
        assertEq(resolver.computeIpfsCid(d), resolver.computeIpfsCid(d));
    }
}
