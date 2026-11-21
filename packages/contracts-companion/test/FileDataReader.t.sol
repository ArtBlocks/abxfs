// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest, UnreadableBackend} from "./Base.t.sol";
import {FileDataReader} from "../src/FileDataReader.sol";
import {ContentReader} from "../src/ContentReader.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

/// @dev A file store and chunk store in one, answering whatever records a test sets, so the reader's own length checks
///      can be driven with records the real stores would never hold.
contract HostileStores {
    IFileStore.FileInfo internal _info;
    bytes32[] internal _ids;
    uint48[] internal _sizes;
    bytes internal _chunk;

    function set(uint256 size, uint48[] memory sizes, bytes memory chunk) external {
        _info.size = size;
        _info.chunkCount = sizes.length;
        _info.mimeType = "text/plain";
        delete _ids;
        for (uint256 i; i < sizes.length; i++) {
            _ids.push(bytes32(i + 1));
        }
        _sizes = sizes;
        _chunk = chunk;
    }

    function chunkStore() external view returns (address) {
        return address(this);
    }

    function fileStore() external view returns (address) {
        return address(this);
    }

    function getFileInfo(bytes32) external view returns (IFileStore.FileInfo memory) {
        return _info;
    }

    function getChunkIds(bytes32, uint256, uint256) external view returns (bytes32[] memory) {
        return _ids;
    }

    /// Backend zero: never the reader's raw backend, so every chunk takes the `read` path.
    function recordOf(bytes32 id) external view returns (address, uint48, bytes32, bytes32) {
        return (address(0), _sizes[uint256(id) - 1], bytes32(0), bytes32(0));
    }

    function read(bytes32) external view returns (bytes memory) {
        return _chunk;
    }
}

/// @dev Gas of one static call, with the return data left unread so its size costs the caller nothing.
contract GasMeter {
    function measure(address target, bytes memory data) external view returns (uint256 used) {
        bool ok;
        uint256 g = gasleft();
        assembly ("memory-safe") {
            ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0)
        }
        used = g - gasleft();
        require(ok, "measured call reverted");
    }
}

contract FileDataReaderTest is BaseCompanionTest {
    FileDataReader internal reader;
    ContentReader internal contentReader;

    bytes32 internal constant GZIP = "gzip";
    /// gzip (level 9, OS byte 3) of `console.log("hello from ABX FS");\n` repeated 8 times, from node:zlib.
    bytes internal constant HELLO_GZIP =
        hex"1f8b08000000000002034bcecf2bcecf49d5cbc94fd750ca48cdc9c957482bcacf5570748a50700b56d2b4e64a1e512a0044cd107b10010000";

    function setUp() public override {
        super.setUp();
        reader = new FileDataReader(address(directoryStore), address(fileStore), address(raw));
        contentReader = new ContentReader(address(directoryStore), address(fileStore));
    }

    // ---- helpers ---------------------------------------------------------

    /// @dev The file's data the long way: every chunk through `FileStore.readChunk`.
    function joined(bytes32 cid) internal view returns (bytes memory out) {
        uint256 n = fileStore.chunkCount(cid);
        for (uint256 i; i < n; i++) {
            out = bytes.concat(out, fileStore.readChunk(cid, i));
        }
    }

    /// @dev The same chunk tree as `cid`, bound as a file with a codec.
    function withCodec(bytes32 cid, bytes32 codec, bytes32 outputHash) internal returns (bytes32) {
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        return fileStore.createFile(info.root, info.mimeType, codec, outputHash);
    }

    function helloContent() internal pure returns (bytes memory out) {
        for (uint256 i; i < 8; i++) {
            out = bytes.concat(out, 'console.log("hello from ABX FS");\n');
        }
    }

    function assertData(FileDataReader r, bytes32 cid, bytes memory expected) internal view {
        (,,, bytes memory data) = r.readFileData(cid, expected.length, type(uint256).max);
        assertEq(data, expected, "data");
        assertEq(data, joined(cid), "data vs FileStore.readChunk");
    }

    // ---- wiring ----------------------------------------------------------

    function test_wiringFollowsTheStores() public {
        assertEq(address(reader.directoryStore()), address(directoryStore));
        assertEq(address(reader.fileStore()), address(fileStore));
        assertEq(address(reader.chunkStore()), address(chunkStore));
        assertEq(reader.sstore2Backend(), address(raw));
        address otherFiles = address(new FileStore(address(chunkStore)));
        vm.expectRevert(FileDataReader.StoreMismatch.selector);
        new FileDataReader(address(directoryStore), otherFiles, address(raw));
    }

    // ---- data ------------------------------------------------------------

    function test_rawChunksMatchFileStoreReadChunk() public {
        bytes memory content = deterministicBytes(70_000, "raw");
        bytes32 cid = writeFile(content, "application/octet-stream");
        assertEq(fileStore.chunkCount(cid), 3);
        (string memory mime, bytes32 codec, bytes32 outputHash, bytes memory data) =
            reader.readFileData(cid, content.length, 3);
        assertEq(mime, "application/octet-stream");
        assertEq(codec, bytes32(0));
        assertEq(outputHash, bytes32(0));
        assertEq(data, content);
        assertEq(data, joined(cid));
    }

    function test_fastLzChunksReadThroughTheStore() public {
        bytes memory content = runBytes(60_000);
        uint256[] memory sizes = new uint256[](3);
        (sizes[0], sizes[1], sizes[2]) = (20_000, 20_000, 20_000);
        bytes32 cid = writeFileSized(content, sizes, true, "text/html");
        assertData(reader, cid, content);
    }

    function test_rawAndFastLzChunksInOneFile() public {
        bytes memory content = bytes.concat(deterministicBytes(9_000, "mixed"), runBytes(30_000), bytes("tail"));
        bytes32[] memory ids = new bytes32[](4);
        uint256[] memory sizes = new uint256[](4);
        (sizes[0], sizes[1], sizes[2], sizes[3]) = (9_000, 15_000, 15_000, 4);
        ids[0] = rawChunk(slice(content, 0, 9_000));
        ids[1] = flzChunk(slice(content, 9_000, 15_000));
        ids[2] = rawChunk(slice(content, 24_000, 15_000));
        ids[3] = flzChunk(slice(content, 39_000, 4));
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        assertData(reader, cid, content);
    }

    function test_repeatedChunkInOneFile() public {
        bytes memory piece = deterministicBytes(1_000, "again");
        bytes32 id = rawChunk(piece);
        bytes32[] memory ids = new bytes32[](3);
        uint256[] memory sizes = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (id, id, id);
        (sizes[0], sizes[1], sizes[2]) = (1_000, 1_000, 1_000);
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        assertData(reader, cid, bytes.concat(piece, piece, piece));
    }

    function test_singleChunkAndEmptyFile() public {
        bytes32 one = writeFile("x", "text/plain");
        assertData(reader, one, "x");
        bytes32 empty = writeFile("", "text/plain");
        (string memory mime, bytes32 codec,, bytes memory data) = reader.readFileData(empty, 0, 0);
        assertEq(mime, "text/plain");
        assertEq(codec, bytes32(0));
        assertEq(data.length, 0);
        (,,, string memory b64) = reader.readFileDataBase64(empty, 0, 0);
        assertEq(b64, "");
    }

    function test_multiLevelChunkTree() public {
        bytes memory content = deterministicBytes(700 * 16, "levels");
        bytes32 cid = writeFileChunked(content, 16, "text/plain");
        IFileStore.FileInfo memory info = fileStore.getFileInfo(cid);
        assertEq(info.chunkCount, 700);
        assertEq(info.rootLevel, 1, "two leaves under a branch");
        assertData(reader, cid, content);
    }

    // ---- codecs ----------------------------------------------------------

    function test_gzipFileReturnsItsStoredBytesAndLabels() public {
        bytes memory content = helloContent();
        bytes32 cid = withCodec(writeFile(HELLO_GZIP, "text/javascript"), GZIP, keccak256(content));
        (string memory mime, bytes32 codec, bytes32 outputHash, bytes memory data) =
            reader.readFileData(cid, HELLO_GZIP.length, 1);
        assertEq(mime, "text/javascript");
        assertEq(codec, GZIP);
        assertEq(outputHash, keccak256(content));
        assertEq(data, HELLO_GZIP, "the stored (encoded) bytes, never decoded");
        // The content-level reader refuses the same file: this companion is its data-level counterpart.
        vm.expectRevert(abi.encodeWithSelector(ContentReader.CodecNotSupported.selector, GZIP));
        contentReader.readFile(cid, 1_000, 1);
    }

    function test_multiChunkCodecFile() public {
        bytes memory encoded = deterministicBytes(60_000, "encoded");
        bytes32 cid = withCodec(writeFile(encoded, "text/javascript"), "br", keccak256("decoded elsewhere"));
        (, bytes32 codec, bytes32 outputHash, bytes memory data) = reader.readFileData(cid, encoded.length, 3);
        assertEq(codec, bytes32("br"));
        assertEq(outputHash, keccak256("decoded elsewhere"));
        assertEq(data, encoded);
        assertEq(data, joined(cid));
    }

    // ---- base64 ----------------------------------------------------------

    function test_base64MatchesForgeStd() public {
        uint256[6] memory lengths = [uint256(1), 2, 3, 4, 24_576, 50_001];
        for (uint256 i; i < lengths.length; i++) {
            bytes memory content = deterministicBytes(lengths[i], "b64");
            bytes32 cid = writeFile(content, "application/octet-stream");
            (,,, string memory b64) = reader.readFileDataBase64(cid, content.length, 3);
            assertEq(b64, vm.toBase64(content));
        }
        bytes32 gz = withCodec(writeFile(HELLO_GZIP, "text/javascript"), GZIP, keccak256(helloContent()));
        (,,, string memory gzB64) = reader.readFileDataBase64(gz, HELLO_GZIP.length, 1);
        assertEq(gzB64, vm.toBase64(HELLO_GZIP));
    }

    // ---- paths -----------------------------------------------------------

    /// @dev root/{index.html, libs/hello-1.0.0.min.js (gzip)}.
    function pathFixture() internal returns (bytes32 root, bytes32 libs, bytes32 lib) {
        lib = withCodec(writeFile(HELLO_GZIP, "text/javascript"), GZIP, keccak256(helloContent()));
        string[] memory names = new string[](1);
        bytes32[] memory cids = new bytes32[](1);
        bool[] memory dirs = new bool[](1);
        (names[0], cids[0]) = ("hello-1.0.0.min.js", lib);
        libs = writeDir(names, cids, dirs);
        names = new string[](2);
        cids = new bytes32[](2);
        dirs = new bool[](2);
        (names[0], cids[0], dirs[0]) = ("index.html", writeFile("<html></html>", "text/html"), false);
        (names[1], cids[1], dirs[1]) = ("libs", libs, true);
        root = writeDir(names, cids, dirs);
    }

    function test_pathsResolveLikeContentReader() public {
        (bytes32 root, bytes32 libs, bytes32 lib) = pathFixture();
        (, bytes32 codec,, bytes memory data) = reader.readPathData(root, "libs/hello-1.0.0.min.js", 100, 1);
        assertEq(codec, GZIP);
        assertEq(data, HELLO_GZIP);
        (,,, string memory b64) = reader.readPathDataBase64(root, "libs/hello-1.0.0.min.js", 100, 1);
        assertEq(b64, vm.toBase64(HELLO_GZIP));
        // A directory reads its index.html; a file root with an empty path is the file.
        (string memory mime,,, bytes memory page) = reader.readPathData(root, "", 100, 1);
        assertEq(mime, "text/html");
        assertEq(page, "<html></html>");
        (,,, data) = reader.readPathData(lib, "", 100, 1);
        assertEq(data, HELLO_GZIP);
        (bytes32 resolved, bool isDirectory) = reader.resolve(root, "libs");
        assertEq(resolved, libs);
        assertTrue(isDirectory);
    }

    function test_pathFailures() public {
        (bytes32 root, bytes32 libs, bytes32 lib) = pathFixture();
        // A directory without index.html.
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "index.html"));
        reader.readPathData(libs, "", 100, 1);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.NotDirectory.selector, lib));
        reader.readPathData(lib, "anything", 100, 1);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.RootNotFound.selector, bytes32(uint256(7))));
        reader.readPathData(bytes32(uint256(7)), "", 100, 1);
        vm.expectRevert(abi.encodeWithSelector(DirectoryStore.PathNotFound.selector, "libs/missing.js"));
        reader.readPathData(root, "libs/missing.js", 100, 1);
    }

    function test_indexThatIsADirectoryIsRefused() public {
        bytes32 inner = directoryStore.createDirectory(0);
        string[] memory names = new string[](1);
        bytes32[] memory cids = new bytes32[](1);
        bool[] memory dirs = new bool[](1);
        (names[0], cids[0], dirs[0]) = ("index.html", inner, true);
        bytes32 root = writeDir(names, cids, dirs);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.IsDirectory.selector, inner));
        reader.readPathData(root, "", 100, 1);
    }

    function test_aDirectoryCidIsNotAFile() public {
        bytes32 dir = directoryStore.createDirectory(0);
        vm.expectRevert(abi.encodeWithSelector(FileStore.FileNotFound.selector, dir));
        reader.readFileData(dir, 100, 1);
    }

    // ---- limits and failures ---------------------------------------------

    function test_limitsRefuseBeforeReading() public {
        bytes32 cid = writeFileChunked("abcdef", 2, "text/plain");
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ByteLimitExceeded.selector, 6, 5));
        reader.readFileData(cid, 5, 3);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ChunkLimitExceeded.selector, 3, 2));
        reader.readFileData(cid, 6, 2);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ByteLimitExceeded.selector, 6, 5));
        reader.readFileDataBase64(cid, 5, 3);
    }

    /// A raw chunk whose code no longer matches its record (only a test can do this: SSTORE2 code is immutable) fails the
    /// direct read's hash check, falls back to ChunkStore, and reverts exactly as `FileStore.readChunk` does.
    function test_tamperedRawChunkRevertsLikeTheStore() public {
        bytes memory content = deterministicBytes(30_000, "tamper");
        bytes32 cid = writeFile(content, "application/octet-stream");
        bytes32 id = fileStore.getChunkId(cid, 1);
        (,, bytes32 pointer,) = chunkStore.recordOf(id);
        address p = address(uint160(uint256(pointer)));

        bytes memory forged = p.code;
        forged[100] = forged[100] ^ 0x01; // same length, one bit off
        vm.etch(p, forged);
        bytes memory storeError = _readChunkError(cid, 1);
        assertEq(storeError, abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        vm.expectRevert(storeError);
        reader.readFileData(cid, content.length, 2);

        vm.etch(p, bytes.concat(forged, hex"00")); // one byte longer: not the recorded shape
        storeError = _readChunkError(cid, 1);
        vm.expectRevert(storeError);
        reader.readFileData(cid, content.length, 2);
    }

    function test_unreadableBackendRevertsLikeTheStore() public {
        bytes32[] memory ids = new bytes32[](1);
        UnreadableBackend offChain = new UnreadableBackend();
        ids[0] = chunkStore.write(address(offChain), "unreadable", keccak256("abc"), 3);
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = 3;
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, ids[0], address(offChain)));
        reader.readFileData(cid, 3, 1);
    }

    /// The raw-backend address only picks which chunks try the direct read: a wrong one costs gas, never correctness.
    function test_aWrongRawBackendStillReadsCorrectly() public {
        bytes memory content = bytes.concat(runBytes(40_000), deterministicBytes(20_000, "wrong"));
        uint256[] memory sizes = new uint256[](3);
        (sizes[0], sizes[1], sizes[2]) = (20_000, 20_000, 20_000);
        bytes32 flzCid = writeFileSized(content, sizes, true, "text/plain");
        bytes32 rawCid = writeFileSized(content, sizes, false, "text/plain");
        FileDataReader[2] memory others = [
            new FileDataReader(address(directoryStore), address(fileStore), address(flz)),
            new FileDataReader(address(directoryStore), address(fileStore), address(0))
        ];
        for (uint256 i; i < others.length; i++) {
            assertData(others[i], flzCid, content);
            assertData(others[i], rawCid, content);
        }
    }

    function test_inconsistentRecordsAreRefused() public {
        HostileStores stores = new HostileStores();
        FileDataReader hostile = new FileDataReader(address(stores), address(stores), address(raw));
        uint48[] memory sizes = new uint48[](2);

        (sizes[0], sizes[1]) = (0, 2); // an empty chunk record
        stores.set(2, sizes, "");
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileData(0, 10, 10);

        (sizes[0], sizes[1]) = (2, 2); // records longer than the file
        stores.set(3, sizes, "ab");
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileData(0, 10, 10);

        (sizes[0], sizes[1]) = (1, 1); // records shorter than the file
        stores.set(3, sizes, "a");
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileData(0, 10, 10);

        (sizes[0], sizes[1]) = (2, 1); // a read of a different length than its record
        stores.set(3, sizes, "a");
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileData(0, 10, 10);

        sizes = new uint48[](1); // consistent
        sizes[0] = 3;
        stores.set(3, sizes, "abc");
        (,,, bytes memory data) = hostile.readFileData(0, 10, 10);
        assertEq(data, "abc");
    }

    // ---- gas -------------------------------------------------------------

    /// Ten full raw chunks (about 240 KiB), each path measured by `GasMeter` (so no returned bytes land in the test's
    /// own large memory) after `vm.cool` on the stores, the backend and every chunk contract (the file was just written,
    /// which warmed them): the direct read, the same reader forced onto `ChunkStore.read` (raw backend unset), and
    /// `ContentReader`, which reads every chunk through `FileStore.readChunk`.
    function test_directReadGas() public {
        bytes memory content = deterministicBytes(10 * RAW_MAX, "gas");
        bytes32 cid = writeFile(content, "application/octet-stream");
        FileDataReader viaStore = new FileDataReader(address(directoryStore), address(fileStore), address(0));
        GasMeter meter = new GasMeter();
        bytes memory call = abi.encodeCall(FileDataReader.readFileData, (cid, content.length, 10));

        _coolFile(cid);
        uint256 direct = meter.measure(address(reader), call);
        _coolFile(cid);
        uint256 store = meter.measure(address(viaStore), call);
        _coolFile(cid);
        uint256 viaReadChunk =
            meter.measure(address(contentReader), abi.encodeCall(ContentReader.readFile, (cid, content.length, 10)));
        _coolFile(cid);
        uint256 directBase64 = meter.measure(
            address(reader), abi.encodeCall(FileDataReader.readFileDataBase64, (cid, content.length, 10))
        );

        emit log_named_uint("direct (EXTCODECOPY + dataHash check)", direct);
        emit log_named_uint("ChunkStore.read per chunk", store);
        emit log_named_uint("ContentReader (FileStore.readChunk per chunk)", viaReadChunk);
        emit log_named_uint("direct + base64", directBase64);
        assertLt(direct * 2, store, "direct read is cheaper than the store path");
        assertLt(direct * 2, viaReadChunk, "direct read is cheaper than readChunk per chunk");
    }

    function _coolFile(bytes32 cid) internal {
        bytes32[] memory ids = fileStore.getChunkIds(cid, 0, fileStore.chunkCount(cid));
        for (uint256 i; i < ids.length; i++) {
            (,, bytes32 pointer,) = chunkStore.recordOf(ids[i]);
            vm.cool(address(uint160(uint256(pointer))));
        }
        vm.cool(address(chunkStore));
        vm.cool(address(fileStore));
        vm.cool(address(directoryStore));
        vm.cool(address(raw));
        vm.cool(address(flz));
        vm.cool(address(reader));
        vm.cool(address(contentReader));
    }

    // ---- fuzz ------------------------------------------------------------

    /// Any chunking and any mix of raw and FastLZ chunks reads back as the content and as `FileStore.readChunk` joins it.
    function testFuzz_anyChunkingAndBackends(uint256 seed, uint8 count, uint256 rawMask) public {
        uint256 n = bound(count, 1, 12);
        uint256[] memory sizes = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            sizes[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % 3_000;
            total += sizes[i];
        }
        // Compressible and incompressible halves, so FastLZ chunks both shrink and do not.
        bytes memory content = bytes.concat(runBytes(total / 2), deterministicBytes(total - total / 2, "fuzz"));
        bytes32[] memory ids = new bytes32[](n);
        uint256 off;
        for (uint256 i; i < n; i++) {
            bytes memory piece = slice(content, off, sizes[i]);
            ids[i] = (rawMask >> i) & 1 == 1 ? rawChunk(piece) : flzChunk(piece);
            off += sizes[i];
        }
        bytes32 cid = createFileFromChunks(ids, sizes, "application/octet-stream");
        assertData(reader, cid, content);
        (,,, string memory b64) = reader.readFileDataBase64(cid, content.length, n);
        assertEq(b64, vm.toBase64(content));
    }

    function _readChunkError(bytes32 cid, uint256 index) internal view returns (bytes memory err) {
        bool ok;
        (ok, err) = address(fileStore).staticcall(abi.encodeCall(IFileStore.readChunk, (cid, index)));
        assertFalse(ok, "the store refuses the chunk");
    }
}
