// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {ChunkStore} from "../src/ChunkStore.sol";
import {IChunkStore} from "../src/interfaces/IChunkStore.sol";
import {IStorageBackend} from "../src/interfaces/IStorageBackend.sol";
import {Sstore2Backend} from "../src/backends/Sstore2Backend.sol";
import {FastLzSstore2Backend} from "../src/backends/FastLzSstore2Backend.sol";
import {CodeStore} from "../src/utils/CodeStore.sol";

contract BackendsTest is Test {
    ChunkStore internal chunks;
    Sstore2Backend internal raw;
    FastLzSstore2Backend internal flz;

    function setUp() public {
        chunks = new ChunkStore();
        raw = new Sstore2Backend();
        flz = new FastLzSstore2Backend();
    }

    function _text(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        bytes memory words = "the quick brown fox jumps over the lazy dog, ";
        for (uint256 i; i < n; i++) b[i] = words[i % words.length];
    }

    function _salt0(Sstore2Backend backend, bytes memory data, uint256 i) internal pure returns (address) {
        return CodeStore.predict(SSTORE2.initCodeHash(data), bytes32(i), address(backend));
    }

    // ---- Sstore2Backend ------------------------------------------------

    function test_raw_roundTripAndDedup() public {
        bytes memory d = "stored as code";
        bytes32 p = raw.store(d, address(this));
        assertEq(uint256(p) >> 160, 0);
        address a = address(uint160(uint256(p)));
        assertEq(a, _salt0(raw, d, 0));
        assertEq(a.code, bytes.concat(hex"00", d), "STOP then the data");
        assertEq(raw.retrieve(p), d);
        assertEq(raw.store(d, address(this)), p, "identical input is stored once");
        assertTrue(raw.readable());
        assertEq(raw.maxInputSize(), 24_575);
        (bytes32 scheme,) = raw.retrieval();
        assertEq(scheme, bytes32("evm"));
    }

    function test_raw_sizeLimits() public {
        vm.expectRevert(abi.encodeWithSelector(Sstore2Backend.InputSize.selector, 0));
        raw.store("", address(this));
        vm.expectRevert(abi.encodeWithSelector(Sstore2Backend.InputSize.selector, 24_576));
        raw.store(new bytes(24_576), address(this));
        bytes32 p = raw.store(new bytes(24_575), address(this));
        assertEq(raw.retrieve(p).length, 24_575);
    }

    function test_raw_retrieveRefusesNonPointers() public {
        bytes32 noCode = bytes32(uint256(uint160(makeAddr("nothing"))));
        vm.expectRevert(abi.encodeWithSelector(Sstore2Backend.NoData.selector, noCode));
        raw.retrieve(noCode);
        bytes32 dirty = bytes32(uint256(1) << 200 | uint256(uint160(address(raw))));
        vm.expectRevert(abi.encodeWithSelector(Sstore2Backend.NoData.selector, dirty));
        raw.retrieve(dirty);
    }

    /// Foreign code at the first candidate address (a planted account) is skipped, never reused.
    function test_raw_plantedCodeIsSkipped() public {
        bytes memory d = "target data";
        address first = _salt0(raw, d, 0);
        vm.etch(first, hex"ef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // an EIP-7702 designator's shape
        bytes32 p = raw.store(d, address(this));
        assertEq(address(uint160(uint256(p))), _salt0(raw, d, 1));
        assertEq(raw.retrieve(p), d);
        assertEq(raw.store(d, address(this)), p, "the second candidate is found and reused next time");

        // Through ChunkStore, the planted address changes nothing for the writer.
        bytes32 id = chunks.write(address(raw), d, keccak256(d), uint48(d.length));
        assertEq(chunks.read(id), d);
    }

    function test_raw_everyCandidatePlanted() public {
        bytes memory d = "all taken";
        for (uint256 i; i < CodeStore.ATTEMPTS; i++) {
            vm.etch(_salt0(raw, d, i), hex"fe");
        }
        vm.expectRevert(CodeStore.NoFreeAddress.selector);
        raw.store(d, address(this));
    }

    // ---- FastLzSstore2Backend -----------------------------------------

    function test_flz_inflatesOnChain() public {
        bytes memory data = _text(20_000);
        bytes memory packed = LibZip.flzCompress(data);
        assertLt(packed.length, data.length / 4);
        bytes32 id = chunks.write(address(flz), packed, keccak256(data), uint48(data.length));
        assertEq(chunks.read(id), data, "the chain returns the inflated data");
        assertEq(chunks.sizeOf(id), data.length);
        assertEq(id, chunks.chunkId(address(flz), keccak256(packed), keccak256(data), uint48(data.length)));
        (,, bytes32 pointer,) = chunks.recordOf(id);
        assertEq(address(uint160(uint256(pointer))).code, bytes.concat(hex"00", packed), "stored compressed");
    }

    function test_flz_claimsAreAboutTheInflatedData() public {
        bytes memory data = _text(5_000);
        bytes memory packed = LibZip.flzCompress(data);
        bytes32 id = chunks.chunkId(address(flz), keccak256(packed), keccak256(packed), uint48(packed.length));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        chunks.write(address(flz), packed, keccak256(packed), uint48(packed.length));
    }

    function test_flz_inflatedLargerThanAnyContract() public {
        // A chunk's data may exceed the code limit: only the compressed input is stored as code.
        bytes memory data = _text(100_000);
        bytes memory packed = LibZip.flzCompress(data);
        assertLe(packed.length, 24_575);
        bytes32 id = chunks.write(address(flz), packed, keccak256(data), uint48(data.length));
        assertEq(chunks.read(id).length, 100_000);
    }

    function test_flz_rawAndFlzAreSeparate() public {
        bytes memory d = "same input bytes";
        bytes32 a = raw.store(d, address(this));
        bytes32 b = flz.store(d, address(this));
        assertTrue(a != b, "each backend deploys from its own address");
        (bytes32 scheme,) = flz.retrieval();
        assertEq(scheme, bytes32("evm"));
    }

    // ---- gas -----------------------------------------------------------

    function test_gas_flzChunk() public {
        bytes memory data = _text(60_000);
        bytes memory packed = LibZip.flzCompress(data);
        uint256 g = gasleft();
        bytes32 id = chunks.write(address(flz), packed, keccak256(data), uint48(data.length));
        emit log_named_uint("gas: FastLZ chunk write (60,000 bytes of text)", g - gasleft());
        emit log_named_uint("     stored bytes", packed.length);
        g = gasleft();
        chunks.read(id);
        emit log_named_uint("gas: FastLZ chunk read (inflate + check)", g - gasleft());
    }
}

/// @dev `CodeStore` is an internal library, so a deployed wrapper is the only way to call it directly. Every contract
///      that uses it checks the size first (`NodeTree._putNode`, `Sstore2Backend.store`), so `DataSize` is its own
///      guard that no deployed path reaches; it is exercised here, at the library's own boundary.
contract CodeStoreHarness {
    function place(bytes memory data) external returns (address) {
        return CodeStore.place(data);
    }
}

contract CodeStoreTest is Test {
    CodeStoreHarness internal harness;

    function setUp() public {
        harness = new CodeStoreHarness();
    }

    function test_place_refusesEmptyAndOversizedData() public {
        vm.expectRevert(abi.encodeWithSelector(CodeStore.DataSize.selector, 0));
        harness.place("");
        vm.expectRevert(abi.encodeWithSelector(CodeStore.DataSize.selector, 24_576));
        harness.place(new bytes(24_576));
        vm.expectRevert(abi.encodeWithSelector(CodeStore.DataSize.selector, type(uint16).max));
        harness.place(new bytes(type(uint16).max));
    }

    function test_place_storesAtTheLargestSizeAndReusesTheAddress() public {
        bytes memory max = new bytes(CodeStore.MAX_DATA);
        for (uint256 i; i < max.length; i++) max[i] = bytes1(uint8(i));
        address a = harness.place(max);
        assertEq(a, CodeStore.predict(SSTORE2.initCodeHash(max), bytes32(0), address(harness)), "first salt");
        assertEq(a.code, bytes.concat(hex"00", max), "STOP, then the data, at the EIP-170 limit");
        assertEq(harness.place(max), a, "identical data is stored once");

        bytes memory one = hex"ff";
        address b = harness.place(one);
        assertEq(b.code, hex"00ff");
        assertEq(harness.place(one), b);
    }

    /// Planted code at the first candidates is skipped one salt at a time, and the first free salt is used; once a
    /// candidate holds exactly `0x00 ‖ data` (placed earlier) it is reused even when earlier salts are planted.
    function test_place_skipsForeignCodeAndReusesOwnCode() public {
        bytes memory d = "placed after skipping";
        bytes32 initHash = SSTORE2.initCodeHash(d);
        for (uint256 i; i < 3; i++) {
            vm.etch(CodeStore.predict(initHash, bytes32(i), address(harness)), hex"fe");
        }
        address third = harness.place(d);
        assertEq(third, CodeStore.predict(initHash, bytes32(uint256(3)), address(harness)), "salt 3 is the first free");
        assertEq(third.code, bytes.concat(hex"00", d));
        assertEq(harness.place(d), third, "its own code, found again past the planted ones");
        // Code that is the right data but not behind the leading STOP is foreign too.
        bytes memory e = "no stop byte";
        vm.etch(CodeStore.predict(SSTORE2.initCodeHash(e), bytes32(0), address(harness)), e);
        address skipped = harness.place(e);
        assertEq(skipped, CodeStore.predict(SSTORE2.initCodeHash(e), bytes32(uint256(1)), address(harness)));
    }
}

/// @dev `IStorageBackend` stays the shape the spec states.
contract BackendInterfaceTest is Test {
    function test_selectors() public pure {
        assertEq(IStorageBackend.store.selector, bytes4(keccak256("store(bytes,address)")));
        assertEq(IStorageBackend.readable.selector, bytes4(keccak256("readable()")));
        assertEq(IStorageBackend.retrieve.selector, bytes4(keccak256("retrieve(bytes32)")));
        assertEq(IStorageBackend.retrieval.selector, bytes4(keccak256("retrieval()")));
        assertEq(IStorageBackend.maxInputSize.selector, bytes4(keccak256("maxInputSize()")));
    }
}
