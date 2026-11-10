// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest, UnreadableBackend} from "./Base.t.sol";
import {ContentReader, IContentReaderHook} from "../src/ContentReader.sol";
import {AbxContentReader} from "../src/AbxContentReader.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

contract ReaderOrg {
    address internal immutable _hook;

    constructor(address hook_) {
        _hook = hook_;
    }

    function paramHooks() external view returns (address, address, address) {
        return (_hook, address(0), address(0));
    }
}

contract ReaderHook is IContentReaderHook {
    mapping(address => bytes32[]) internal _roots;

    function add(address org, bytes32 cid) external {
        _roots[org].push(cid);
    }

    function versionAt(address org, uint256, uint256 version) external view returns (Version memory) {
        return Version(_roots[org][version - 1], 0, address(0));
    }

    function latestVersion(address org, uint256) external view returns (uint256 version, bytes32 cid) {
        version = _roots[org].length;
        cid = _roots[org][version - 1];
    }

    function getTag(address org, uint256, string calldata tag) external view returns (uint256, bytes32) {
        require(keccak256(bytes(tag)) == keccak256("stable"), "missing tag");
        return (1, _roots[org][0]);
    }
}

/// @dev Deliberately inconsistent records; readChunk reverts unless the test supplies a response.
contract ReaderFileMock {
    IFileStore.FileInfo internal _info;
    bytes internal _chunk;
    bool internal _allowRead;

    function setInfo(uint256 size, uint256 count, bytes32 codec) external {
        _info.size = size;
        _info.chunkCount = count;
        _info.codec = codec;
        _info.mimeType = "text/plain";
    }

    function setChunk(bytes memory data) external {
        _chunk = data;
        _allowRead = true;
    }

    function getFileInfo(bytes32) external view returns (IFileStore.FileInfo memory) {
        return _info;
    }

    function readChunk(bytes32, uint256) external view returns (bytes memory) {
        require(_allowRead, "must refuse before read");
        return _chunk;
    }

    function locateByte(bytes32, uint256) external view returns (uint256, uint256, bytes32, uint256) {
        return (0, 0, bytes32(0), _info.size);
    }
}

contract ReaderDirectoryMock {
    address public immutable fileStore;

    constructor(address files) {
        fileStore = files;
    }
}

contract ContentReaderTest is BaseCompanionTest {
    ContentReader internal reader;

    function setUp() public override {
        super.setUp();
        reader = new ContentReader(address(directoryStore), address(fileStore));
    }

    function test_storePairMustMatch() public {
        vm.expectRevert(ContentReader.StoreMismatch.selector);
        new ContentReader(address(directoryStore), address(0x123));
    }

    function test_readsRealRawAndFastLzChunks() public {
        bytes memory content = runBytes(60_000);
        uint256[] memory sizes = new uint256[](3);
        sizes[0] = 20_000;
        sizes[1] = 20_000;
        sizes[2] = 20_000;
        bytes32 rawCid = writeFileSized(content, sizes, false, "text/html; charset=utf-8");
        bytes32 flzCid = writeFileSized(content, sizes, true, "text/html; charset=utf-8");
        (string memory mime, bytes memory data) = reader.readFile(rawCid, content.length, 3);
        assertEq(mime, "text/html; charset=utf-8");
        assertEq(data, content);
        (, data) = reader.readFile(flzCid, content.length, 3);
        assertEq(data, content);
    }

    function test_emptyFileAndDirectorySemantics() public {
        bytes32 emptyFile = writeFile("", "text/plain");
        (bytes32 cid, bool isDirectory) = reader.resolve(emptyFile, "");
        assertEq(cid, emptyFile);
        assertFalse(isDirectory);
        (, bytes memory data) = reader.readFile(emptyFile, 0, 0);
        assertEq(data.length, 0);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.NotDirectory.selector, emptyFile));
        reader.resolve(emptyFile, "anything");
        bytes32 emptyDir = directoryStore.createDirectory(0);
        (cid, isDirectory) = reader.resolve(emptyDir, "");
        assertEq(cid, emptyDir);
        assertTrue(isDirectory);
        vm.expectRevert();
        reader.readPath(emptyDir, "", 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.RootNotFound.selector, bytes32(uint256(123))));
        reader.resolve(bytes32(uint256(123)), "");
    }

    function test_directoryIndexesAndNestedPaths() public {
        bytes32 file = writeFile(bytes("hello"), "text/html");
        string[] memory names = new string[](1);
        names[0] = "index.html";
        bytes32[] memory cids = new bytes32[](1);
        cids[0] = file;
        bool[] memory dirs = new bool[](1);
        bytes32 child = writeDir(names, cids, dirs);
        names[0] = "site";
        cids[0] = child;
        dirs[0] = true;
        bytes32 root = writeDir(names, cids, dirs);
        (, bytes memory data) = reader.readPath(root, "site", 5, 1);
        assertEq(data, bytes("hello"));
        (, data) = reader.readPath(root, "site/index.html", 5, 1);
        assertEq(data, bytes("hello"));
        (bytes32 exact, bool isDir) = reader.resolve(root, "site");
        assertEq(exact, child);
        assertTrue(isDir);
        vm.expectRevert();
        reader.resolve(root, "/site");
        vm.expectRevert();
        reader.resolve(root, "site/");
        vm.expectRevert();
        reader.resolve(root, "site//index.html");
        vm.expectRevert();
        reader.resolve(root, "site/index.html/child");
    }

    function test_refusesIndexThatIsDirectory() public {
        string[] memory names = new string[](1);
        names[0] = "index.html";
        bytes32[] memory cids = new bytes32[](1);
        cids[0] = directoryStore.createDirectory(0);
        bool[] memory dirs = new bool[](1);
        dirs[0] = true;
        bytes32 root = writeDir(names, cids, dirs);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.IsDirectory.selector, cids[0]));
        reader.readPath(root, "", 100, 10);
    }

    function test_fileLevelCodecRefusedBeforeChunkRead() public {
        bytes32 rawCid = writeFile("gzip bytes", "text/plain");
        bytes32 encoded =
            fileStore.createFile(fileStore.getFileInfo(rawCid).root, "text/plain", "gzip", keccak256("decoded"));
        vm.expectRevert(abi.encodeWithSelector(ContentReader.CodecNotSupported.selector, bytes32("gzip")));
        reader.readFile(encoded, 100, 10);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.CodecNotSupported.selector, bytes32("gzip")));
        reader.readFileRange(encoded, 0, 0, 100, 10);
    }

    function test_wholeLimitsAndUnreadableBackend() public {
        bytes32 cid = writeFileChunked("abcdef", 2, "text/plain");
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ByteLimitExceeded.selector, 6, 5));
        reader.readFile(cid, 5, 3);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ChunkLimitExceeded.selector, 3, 2));
        reader.readFile(cid, 6, 2);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = chunkStore.write(address(new UnreadableBackend()), "unreadable", keccak256("abc"), 3);
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = 3;
        cid = createFileFromChunks(ids, sizes, "text/plain");
        vm.expectRevert();
        reader.readFile(cid, 3, 1);
    }

    function test_rangeBoundsIncludeFullDecodedChunkCost() public {
        bytes memory content = runBytes(20_000);
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = content.length;
        bytes32 cid = writeFileSized(content, sizes, true, "image/svg+xml");
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ByteLimitExceeded.selector, 20_000, 1));
        reader.readFileRange(cid, 19_999, 1, 1, 1);
        (, bytes memory data) = reader.readFileRange(cid, 19_999, 1, 20_000, 1);
        assertEq(data, slice(content, 19_999, 1));
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ChunkLimitExceeded.selector, 1, 0));
        reader.readFileRange(cid, 0, 1, 20_000, 0);
        (, data) = reader.readFileRange(cid, 20_000, 0, 0, 0);
        assertEq(data.length, 0);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.RangeOutOfBounds.selector, type(uint256).max, 1, 20_000));
        reader.readFileRange(cid, type(uint256).max, 1, 20_000, 1);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.RangeOutOfBounds.selector, 20_000, 1, 20_000));
        reader.readFileRange(cid, 20_000, 1, 20_000, 1);
    }

    function test_rangeSkipsUnreadablePrefixAndReadsBoundaryChunks() public {
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = chunkStore.write(address(new UnreadableBackend()), "offchain", keccak256("abc"), 3);
        ids[1] = rawChunk("def");
        ids[2] = flzChunk("ghij");
        uint256[] memory sizes = new uint256[](3);
        sizes[0] = 3;
        sizes[1] = 3;
        sizes[2] = 4;
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        (, bytes memory data) = reader.readFileRange(cid, 4, 4, 7, 2);
        assertEq(data, bytes("efgh"));
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ChunkLimitExceeded.selector, 2, 1));
        reader.readFileRange(cid, 4, 4, 7, 1);
    }

    function test_preflightRejectsHostileRecordsAndChecksReadLength() public {
        ReaderFileMock files = new ReaderFileMock();
        ContentReader hostileReader =
            new ContentReader(address(new ReaderDirectoryMock(address(files))), address(files));
        files.setInfo(type(uint256).max, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ByteLimitExceeded.selector, type(uint256).max, 100));
        hostileReader.readFile(0, 100, 1);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ByteLimitExceeded.selector, 101, 100));
        hostileReader.readFileRange(0, 0, 101, 100, 1);
        files.setInfo(1, type(uint256).max, 0);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ChunkLimitExceeded.selector, type(uint256).max, 1));
        hostileReader.readFile(0, 100, 1);
        files.setInfo(2, 1, 0);
        files.setChunk("a");
        vm.expectRevert(ContentReader.InvalidFileLength.selector);
        hostileReader.readFile(0, 2, 1);
        vm.expectRevert(ContentReader.InvalidFileLength.selector);
        hostileReader.readFileRange(0, 0, 1, 2, 1);
        files.setChunk("abc");
        vm.expectRevert(ContentReader.InvalidFileLength.selector);
        hostileReader.readFile(0, 2, 1);
        vm.expectRevert(ContentReader.InvalidFileLength.selector);
        hostileReader.readFileRange(0, 0, 1, 2, 1);
    }

    function test_projectSelectorsDiscoverEachOrgsOwnHook() public {
        ReaderHook oldHook = new ReaderHook();
        ReaderHook newHook = new ReaderHook();
        ReaderOrg oldOrg = new ReaderOrg(address(oldHook));
        ReaderOrg newOrg = new ReaderOrg(address(newHook));
        bytes32 v1 = writeFile("old", "text/plain");
        bytes32 v2 = writeFile("new", "text/plain");
        oldHook.add(address(oldOrg), v1);
        oldHook.add(address(oldOrg), v2);
        newHook.add(address(newOrg), v2);
        assertEq(reader.projectRoot(address(oldOrg), 1, 0, ""), v2);
        assertEq(reader.projectRoot(address(oldOrg), 1, 1, ""), v1);
        assertEq(reader.projectRoot(address(oldOrg), 1, 0, "stable"), v1);
        assertEq(reader.projectRoot(address(newOrg), 1, 1, ""), v2);
        (, bytes memory data) = reader.readProject(address(oldOrg), 1, 1, "", "", 3, 1);
        assertEq(data, bytes("old"));
        vm.expectRevert(ContentReader.InvalidProjectSelector.selector);
        reader.projectRoot(address(oldOrg), 1, 1, "stable");
        ReaderOrg noHook = new ReaderOrg(address(0));
        vm.expectRevert(ContentReader.ConfigureHookNotFound.selector);
        reader.projectRoot(address(noHook), 1, 0, "");
        vm.expectRevert();
        reader.projectRoot(address(oldOrg), 1, 3, "");
        vm.expectRevert();
        reader.projectRoot(address(oldOrg), 1, 0, "missing");
    }

    function test_abxAdapterHasOneFixedSourcePointer() public {
        bytes32 cid = writeFile("hello", "text/plain");
        AbxContentReader adapter = new AbxContentReader(address(reader), cid, "", 5, 1);
        assertEq(adapter.read(address(adapter)), bytes("hello"));
        vm.expectRevert(abi.encodeWithSelector(AbxContentReader.InvalidPointer.selector, address(reader)));
        adapter.read(address(reader));
        AbxContentReader limited = new AbxContentReader(address(reader), cid, "", 4, 1);
        vm.expectRevert(abi.encodeWithSelector(ContentReader.ByteLimitExceeded.selector, 5, 4));
        limited.read(address(limited));
    }

    function testFuzz_rangesEqualSlice(bytes memory content, uint256 startSeed, uint256 lengthSeed, bool fastLz)
        public
    {
        vm.assume(content.length <= 2_000);
        uint256[] memory sizes = new uint256[]((content.length + 112) / 113);
        for (uint256 i; i < sizes.length; ++i) {
            sizes[i] = i + 1 == sizes.length ? content.length - i * 113 : 113;
        }
        bytes32 cid = writeFileSized(content, sizes, fastLz, "application/octet-stream");
        uint256 start = startSeed % (content.length + 1);
        uint256 length = lengthSeed % (content.length - start + 1);
        (, bytes memory data) = reader.readFileRange(cid, start, length, content.length, sizes.length);
        assertEq(data, slice(content, start, length));
        (, data) = reader.readFile(cid, content.length, sizes.length);
        assertEq(data, content);
    }
}
