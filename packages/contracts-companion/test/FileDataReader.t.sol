// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest, UnreadableBackend} from "./Base.t.sol";
import {FileDataReader} from "../src/FileDataReader.sol";
import {ContentReader} from "../src/ContentReader.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {IStorageBackend} from "@abxfs/core/interfaces/IStorageBackend.sol";

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

    /// `locateByte` answers from a fixed table keyed by offset, so a test can make the two ends of a range disagree.
    mapping(uint256 => uint256[3]) internal _located;

    function setLocate(uint256 offset, uint256 index, uint256 chunkStart, uint256 chunkSize) external {
        _located[offset] = [index, chunkStart, chunkSize];
    }

    function locateByte(bytes32, uint256 offset) external view returns (uint256, uint256, bytes32, uint256) {
        uint256[3] memory l = _located[offset];
        return (l[0], l[1], bytes32(l[0] + 1), l[2]);
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

/// @dev A readable backend whose pointers have bits above the address range, so none can be an SSTORE2 contract. It
///      keeps each input in storage.
contract HighBitsBackend is IStorageBackend {
    mapping(bytes32 => bytes) internal held;

    function store(bytes calldata input, address) external returns (bytes32 pointer) {
        pointer = keccak256(input) | bytes32(uint256(1) << 255);
        held[pointer] = input;
    }

    function readable() external pure returns (bool) {
        return true;
    }

    function retrieve(bytes32 pointer) external view returns (bytes memory) {
        return held[pointer];
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("evm-storage", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
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

    // ---- the returned encoding ---------------------------------------------

    /// @dev The reader builds its return value by hand; it must be byte for byte what Solidity's own encoder makes.
    function assertCanonical(bytes32 cid, bytes memory content, string memory mime, bytes32 codec, bytes32 outputHash)
        internal
        view
    {
        uint256 n = fileStore.chunkCount(cid);
        (bool ok, bytes memory ret) =
            address(reader).staticcall(abi.encodeCall(FileDataReader.readFileData, (cid, content.length, n)));
        assertTrue(ok, "readFileData");
        assertEq(ret, abi.encode(mime, codec, outputHash, content), "readFileData encoding");
        (ok, ret) =
            address(reader).staticcall(abi.encodeCall(FileDataReader.readFileDataBase64, (cid, content.length, n)));
        assertTrue(ok, "readFileDataBase64");
        assertEq(ret, abi.encode(mime, codec, outputHash, Base64.encode(content)), "readFileDataBase64 encoding");
    }

    function mimeOfLength(uint256 n) internal pure returns (string memory) {
        bytes memory m = new bytes(n);
        for (uint256 i; i < n; i++) {
            m[i] = bytes1(uint8(0x61 + i % 26));
        }
        return string(m);
    }

    /// Every data length around the word, base64-group and chunk boundaries, under MIME types around the word
    /// boundaries too, with and without a codec, against `abi.encode` of the same values.
    function test_returnIsTheCanonicalEncoding() public {
        uint256[15] memory lengths = [uint256(0), 1, 2, 3, 4, 5, 6, 31, 32, 33, 63, 64, 65, RAW_MAX, RAW_MAX + 1];
        uint256[5] memory mimes = [uint256(1), 31, 32, 33, 127];
        for (uint256 i; i < lengths.length; i++) {
            bytes memory content = deterministicBytes(lengths[i], "canonical");
            for (uint256 j; j < mimes.length; j++) {
                string memory mime = mimeOfLength(mimes[j]);
                bytes32 cid = writeFile(content, mime);
                assertCanonical(cid, content, mime, 0, 0);
                if (lengths[i] != 0) {
                    bytes32 coded = withCodec(cid, GZIP, keccak256(abi.encode(i, j)));
                    assertCanonical(coded, content, mime, GZIP, keccak256(abi.encode(i, j)));
                }
            }
        }
    }

    /// The in-place base64 at every length from 1 to 400: the encoding runs over the data it reads, and its margin
    /// grows with the length, so short files are where an off-by-one would show.
    function test_inPlaceBase64AtEverySmallLength() public {
        bytes memory all = deterministicBytes(400, "every length");
        for (uint256 n = 1; n <= 400; n++) {
            bytes memory content = slice(all, 0, n);
            bytes32 cid = writeFile(content, "application/octet-stream");
            (,,, string memory b64) = reader.readFileDataBase64(cid, n, 1);
            assertEq(b64, vm.toBase64(content));
        }
    }

    // ---- ranges ----------------------------------------------------------

    /// @dev Raw and FastLZ chunks of 9,000 / 15,000 / 15,000 / 4 bytes, so ranges cut both kinds.
    function mixedFile() internal returns (bytes32 cid, bytes memory content) {
        content = bytes.concat(deterministicBytes(9_000, "range"), runBytes(30_000), bytes("tail"));
        bytes32[] memory ids = new bytes32[](4);
        uint256[] memory sizes = new uint256[](4);
        (sizes[0], sizes[1], sizes[2], sizes[3]) = (9_000, 15_000, 15_000, 4);
        ids[0] = rawChunk(slice(content, 0, 9_000));
        ids[1] = flzChunk(slice(content, 9_000, 15_000));
        ids[2] = rawChunk(slice(content, 24_000, 15_000));
        ids[3] = flzChunk(slice(content, 39_000, 4));
        cid = createFileFromChunks(ids, sizes, "text/plain");
    }

    function assertRange(bytes32 cid, bytes memory content, uint256 start, uint256 length) internal view {
        (bool ok, bytes memory ret) = address(reader)
            .staticcall(
                abi.encodeCall(
                    FileDataReader.readFileDataRange, (cid, start, length, type(uint256).max, type(uint256).max)
                )
            );
        assertTrue(ok, "readFileDataRange");
        assertEq(ret, abi.encode("text/plain", bytes32(0), bytes32(0), slice(content, start, length)), "range encoding");
    }

    /// Ranges inside one chunk, across every boundary, exactly on chunk edges, the whole file and empty ranges, each
    /// against a slice of the content and the canonical encoding.
    function test_rangesAreSlicesOfTheData() public {
        (bytes32 cid, bytes memory content) = mixedFile();
        uint256 n = content.length; // 39,004
        uint256[2][16] memory cases = [
            [uint256(0), 1],
            [uint256(0), 9_000],
            [uint256(8_999), 2],
            [uint256(9_000), 15_000],
            [uint256(100), 8_000],
            [uint256(12_345), 6_789],
            [uint256(8_000), 20_000],
            [uint256(1), n - 2],
            [uint256(0), n],
            [uint256(38_999), 5],
            [n - 1, 1],
            [n - 4, 4],
            [uint256(0), 0],
            [uint256(20_000), 0],
            [n, 0],
            [uint256(23_999), 15_002]
        ];
        for (uint256 i; i < cases.length; i++) {
            assertRange(cid, content, cases[i][0], cases[i][1]);
        }
    }

    /// Base64 pages of any multiple of 3, the last ending at the end of the file, concatenate to the whole file's
    /// base64, and each is a slice of it.
    function test_base64RangesConcatenateToTheWholeFile() public {
        (bytes32 cid, bytes memory content) = mixedFile();
        string memory whole = vm.toBase64(content);
        uint256[5] memory pages = [uint256(3), 8_997, 9_000, 24_576, 30_000];
        for (uint256 p; p < pages.length; p++) {
            bytes memory joinedB64;
            for (uint256 start; start < content.length; start += pages[p]) {
                uint256 length = content.length - start < pages[p] ? content.length - start : pages[p];
                if (pages[p] == 3 && start > 120 && start + 300 < content.length) continue; // keep the 3-byte walk short
                (bool ok, bytes memory ret) = address(reader)
                    .staticcall(
                        abi.encodeCall(
                            FileDataReader.readFileDataRangeBase64,
                            (cid, start, length, type(uint256).max, type(uint256).max)
                        )
                    );
                assertTrue(ok, "readFileDataRangeBase64");
                string memory page = Base64.encode(slice(content, start, length));
                assertEq(ret, abi.encode("text/plain", bytes32(0), bytes32(0), page), "page encoding");
                joinedB64 = bytes.concat(joinedB64, bytes(page));
            }
            if (pages[p] != 3) assertEq(string(joinedB64), whole, "pages concatenate");
        }
    }

    function test_rangeBoundsAndAlignment() public {
        (bytes32 cid, bytes memory content) = mixedFile();
        uint256 n = content.length;
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.RangeOutOfBounds.selector, n + 1, 0, n));
        reader.readFileDataRange(cid, n + 1, 0, n, 4);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.RangeOutOfBounds.selector, 10, n - 9, n));
        reader.readFileDataRange(cid, 10, n - 9, n, 4);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.RangeOutOfBounds.selector, 0, type(uint256).max, n));
        reader.readFileDataRange(cid, 0, type(uint256).max, n, 4);

        vm.expectRevert(abi.encodeWithSelector(FileDataReader.UnalignedBase64Range.selector, 1, 3));
        reader.readFileDataRangeBase64(cid, 1, 3, n, 4);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.UnalignedBase64Range.selector, 3, 4));
        reader.readFileDataRangeBase64(cid, 3, 4, n, 4);
        // n = 39,004 = 3 * 13,001 + 1: a range ending at the end of the file may have any length.
        (,,, string memory tail) = reader.readFileDataRangeBase64(cid, 39_000, 4, n, 4);
        assertEq(tail, Base64.encode(slice(content, 39_000, 4)));
        // An empty range is valid anywhere in bounds, aligned or not, in both forms.
        (,,, tail) = reader.readFileDataRangeBase64(cid, 7, 0, 0, 0);
        assertEq(tail, "");
        (,,, bytes memory none) = reader.readFileDataRange(cid, n, 0, 0, 0);
        assertEq(none.length, 0);
        // The empty file has only the empty range.
        bytes32 empty = writeFile("", "text/plain");
        (,,, none) = reader.readFileDataRange(empty, 0, 0, 0, 0);
        assertEq(none.length, 0);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.RangeOutOfBounds.selector, 0, 1, 0));
        reader.readFileDataRange(empty, 0, 1, 1, 1);
    }

    /// Limits count every chunk the range touches in full, as `ContentReader.readFileRange` does: each is read whole to
    /// check its hash. The returned length alone is refused first.
    function test_rangeLimitsCountWholeTouchedChunks() public {
        (bytes32 cid,) = mixedFile();
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ByteLimitExceeded.selector, 10, 9));
        reader.readFileDataRange(cid, 0, 10, 9, 1);
        // Bytes 8,999..9,000 touch the first two chunks: 24,000 bytes read.
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ByteLimitExceeded.selector, 24_000, 23_999));
        reader.readFileDataRange(cid, 8_999, 2, 23_999, 2);
        vm.expectRevert(abi.encodeWithSelector(FileDataReader.ChunkLimitExceeded.selector, 2, 1));
        reader.readFileDataRange(cid, 8_999, 2, 24_000, 1);
        (,,, bytes memory two) = reader.readFileDataRange(cid, 8_999, 2, 24_000, 2);
        assertEq(two.length, 2);
    }

    function test_rangeOfACodecFileIsOfItsEncodedData() public {
        bytes memory encoded = deterministicBytes(60_000, "encoded");
        bytes32 cid = withCodec(writeFile(encoded, "text/javascript"), GZIP, keccak256("content"));
        (string memory mime, bytes32 codec, bytes32 outputHash, bytes memory data) =
            reader.readFileDataRange(cid, 24_000, 12_000, 60_000, 3);
        assertEq(mime, "text/javascript");
        assertEq(codec, GZIP);
        assertEq(outputHash, keccak256("content"));
        assertEq(data, slice(encoded, 24_000, 12_000));
    }

    /// A raw chunk the range cuts is still checked whole: a forged one fails the direct read and reverts as the store
    /// does, even when the forged byte lies outside the range.
    function test_tamperedChunkInARangeRevertsLikeTheStore() public {
        bytes memory content = deterministicBytes(30_000, "tamper range");
        bytes32 cid = writeFile(content, "application/octet-stream");
        bytes32 id = fileStore.getChunkId(cid, 1);
        (,, bytes32 pointer,) = chunkStore.recordOf(id);
        address p = address(uint160(uint256(pointer)));
        bytes memory forged = p.code;
        forged[forged.length - 1] = forged[forged.length - 1] ^ 0x01;
        vm.etch(p, forged);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        reader.readFileDataRange(cid, 24_575, 10, content.length, 2);
    }

    /// Any range of any chunking and backend mix is the matching slice; any aligned base64 range is the matching slice
    /// of the whole file's base64.
    function testFuzz_ranges(uint256 seed, uint8 count, uint256 rawMask, uint256 start, uint256 length) public {
        uint256 n = bound(count, 1, 8);
        uint256[] memory sizes = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            sizes[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % 3_000;
            total += sizes[i];
        }
        bytes memory content = bytes.concat(runBytes(total / 2), deterministicBytes(total - total / 2, "fuzz range"));
        bytes32[] memory ids = new bytes32[](n);
        uint256 off;
        for (uint256 i; i < n; i++) {
            bytes memory piece = slice(content, off, sizes[i]);
            ids[i] = (rawMask >> i) & 1 == 1 ? rawChunk(piece) : flzChunk(piece);
            off += sizes[i];
        }
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        start = bound(start, 0, total);
        length = bound(length, 0, total - start);
        assertRange(cid, content, start, length);

        start = start / 3 * 3;
        length = start + length >= total ? total - start : length / 3 * 3;
        (,,, string memory b64) =
            reader.readFileDataRangeBase64(cid, start, length, type(uint256).max, type(uint256).max);
        assertEq(b64, Base64.encode(slice(content, start, length)));
    }

    /// Ranges and aligned base64 pages over a two-level chunk tree: 700 chunks, so leaves of 512 and 188 under one
    /// branch, with ranges inside each leaf, across the leaf boundary and over the whole file.
    function test_rangesOverAMultiLevelChunkTree() public {
        bytes memory content = deterministicBytes(700 * 16, "levels");
        bytes32 cid = writeFileChunked(content, 16, "text/plain");
        assertEq(fileStore.getFileInfo(cid).rootLevel, 1, "two leaves under a branch");
        uint256 leafEnd = LEAF_MAX * 16;
        assertRange(cid, content, 5, 40);
        assertRange(cid, content, leafEnd - 100, 300);
        assertRange(cid, content, leafEnd, 16);
        assertRange(cid, content, leafEnd + 7, content.length - leafEnd - 7);
        assertRange(cid, content, 0, content.length);

        string memory pages;
        for (uint256 start; start < content.length; start += 3_000) {
            uint256 length = start + 3_000 > content.length ? content.length - start : 3_000;
            (,,, string memory page) =
                reader.readFileDataRangeBase64(cid, start, length, type(uint256).max, type(uint256).max);
            pages = string.concat(pages, page);
        }
        assertEq(pages, Base64.encode(content), "pages joined");
    }

    /// `testFuzz_ranges` with full-size chunks (the raw backend's maximum, 24,575 bytes) and a short tail, raw or
    /// FastLZ where the compressed chunk fits, so ranges cut chunks at any offset of the largest chunk the store allows.
    function testFuzz_rangesOverFullSizeChunks(
        uint256 seed,
        uint8 count,
        uint256 rawMask,
        uint256 start,
        uint256 length
    ) public {
        uint256 n = bound(count, 1, 3) + 1;
        uint256[] memory sizes = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            sizes[i] = i + 1 < n ? RAW_MAX : 1 + seed % RAW_MAX;
            total += sizes[i];
        }
        bytes memory content = bytes.concat(runBytes(total / 2), deterministicBytes(total - total / 2, "full size"));
        bytes32[] memory ids = new bytes32[](n);
        uint256 off;
        for (uint256 i; i < n; i++) {
            bytes memory piece = slice(content, off, sizes[i]);
            bool fastLz = (rawMask >> i) & 1 == 0 && LibZip.flzCompress(piece).length <= flz.maxInputSize();
            ids[i] = fastLz ? flzChunk(piece) : rawChunk(piece);
            off += sizes[i];
        }
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        start = bound(start, 0, total);
        length = bound(length, 0, total - start);
        assertRange(cid, content, start, length);

        start = start / 3 * 3;
        length = start + length >= total ? total - start : length / 3 * 3;
        (,,, string memory b64) =
            reader.readFileDataRangeBase64(cid, start, length, type(uint256).max, type(uint256).max);
        assertEq(b64, Base64.encode(slice(content, start, length)));
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

    /// A pointer with bits above the address range cannot name an SSTORE2 contract, so the direct read declines it,
    /// even when its backend is the reader's raw backend, and the store's read serves the chunk.
    function test_aPointerAboveTheAddressRangeReadsThroughTheStore() public {
        HighBitsBackend highBits = new HighBitsBackend();
        FileDataReader r = new FileDataReader(address(directoryStore), address(fileStore), address(highBits));
        bytes memory content = deterministicBytes(5_000, "high bits");
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = chunkStore.write(address(highBits), content, keccak256(content), uint48(content.length));
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = content.length;
        bytes32 cid = createFileFromChunks(ids, sizes, "text/plain");
        (address backend,, bytes32 pointer,) = chunkStore.recordOf(ids[0]);
        assertEq(backend, r.sstore2Backend(), "the reader's raw backend");
        assertGt(uint256(pointer) >> 160, 0, "pointer above the address range");
        assertData(r, cid, content);
        (,,, bytes memory part) = r.readFileDataRange(cid, 1_000, 2_000, type(uint256).max, type(uint256).max);
        assertEq(part, slice(content, 1_000, 2_000), "range");
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

    /// A store whose `locateByte` answers do not bracket the range is refused before any chunk is read.
    function test_inconsistentRangeEndsAreRefused() public {
        HostileStores stores = new HostileStores();
        FileDataReader hostile = new FileDataReader(address(stores), address(stores), address(raw));
        uint48[] memory sizes = new uint48[](2);
        (sizes[0], sizes[1]) = (5, 5);
        stores.set(10, sizes, "abcde");

        stores.setLocate(2, 0, 3, 5); // the chunk said to hold byte 2 starts after it
        stores.setLocate(6, 1, 5, 5);
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileDataRange(0, 2, 5, 10, 2);

        stores.setLocate(2, 1, 0, 5); // the first end lies in a later chunk than the last
        stores.setLocate(6, 0, 5, 5);
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileDataRange(0, 2, 5, 10, 2);

        stores.setLocate(2, 0, 0, 2); // the chunk said to hold byte 2 ends before it
        stores.setLocate(6, 1, 5, 5);
        vm.expectRevert(FileDataReader.InvalidFileLength.selector);
        hostile.readFileDataRange(0, 2, 5, 10, 2);

        stores.setLocate(2, 0, 0, 5); // consistent: bytes 2..6 of "abcde" + "abcde"
        (,,, bytes memory data) = hostile.readFileDataRange(0, 2, 5, 10, 2);
        assertEq(data, "cdeab");
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
        string memory mime = mimeOfLength(1 + seed % 127);
        bytes32 cid = createFileFromChunks(ids, sizes, mime);
        assertData(reader, cid, content);
        (,,, string memory b64) = reader.readFileDataBase64(cid, content.length, n);
        assertEq(b64, vm.toBase64(content));
        assertCanonical(cid, content, mime, 0, 0);
    }

    function _readChunkError(bytes32 cid, uint256 index) internal view returns (bytes memory err) {
        bool ok;
        (ok, err) = address(fileStore).staticcall(abi.encodeCall(IFileStore.readChunk, (cid, index)));
        assertFalse(ok, "the store refuses the chunk");
    }
}
