// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ChunkStore} from "../src/ChunkStore.sol";
import {IChunkStore} from "../src/interfaces/IChunkStore.sol";
import {Sstore2Backend} from "../src/backends/Sstore2Backend.sol";
import {LogBackend, MeteredBackend, ScriptedBackend, ReentrantBackend} from "./mocks/Backends.sol";

contract ChunkStoreTest is Test {
    ChunkStore internal chunks;
    Sstore2Backend internal raw;
    LogBackend internal logBackend;
    ScriptedBackend internal scripted;

    event ChunkWritten(
        bytes32 indexed id, address indexed backend, bytes32 pointer, bytes32 inputHash, bytes32 dataHash, uint48 size
    );

    function setUp() public {
        chunks = new ChunkStore();
        raw = new Sstore2Backend();
        logBackend = new LogBackend();
        scripted = new ScriptedBackend();
    }

    function _write(address backend, bytes memory data) internal returns (bytes32) {
        return chunks.write(backend, data, keccak256(data), uint48(data.length));
    }

    // ---- ids -----------------------------------------------------------

    function test_idFormula() public view {
        bytes32 expected = keccak256(
            abi.encodePacked(bytes1(0x30), address(raw), keccak256("in"), keccak256("out"), uint48(7))
        );
        assertEq(chunks.chunkId(address(raw), keccak256("in"), keccak256("out"), 7), expected);
    }

    function test_idBindsEveryPart() public {
        bytes memory d = "hello";
        bytes32 a = _write(address(raw), d);
        Sstore2Backend raw2 = new Sstore2Backend();
        bytes32 b = _write(address(raw2), d);
        assertTrue(a != b, "backend is in the id");
        bytes32 c = chunks.write(address(logBackend), d, keccak256(d), uint48(d.length));
        bytes32 c2 = chunks.write(address(logBackend), d, keccak256("other"), uint48(d.length));
        bytes32 c3 = chunks.write(address(logBackend), d, keccak256(d), uint48(d.length + 1));
        bytes32 c4 = chunks.write(address(logBackend), "hellO", keccak256(d), uint48(d.length));
        assertTrue(c != c2 && c != c3 && c != c4 && c2 != c3 && c2 != c4 && c3 != c4, "input, hash and size are in the id");
    }

    // ---- readable backends --------------------------------------------

    function test_writeReadRaw() public {
        bytes memory d = "some chunk data";
        bytes32 expected = chunks.chunkId(address(raw), keccak256(d), keccak256(d), uint48(d.length));
        vm.expectEmit(true, true, false, false, address(chunks));
        emit ChunkWritten(expected, address(raw), bytes32(0), bytes32(0), bytes32(0), 0);
        bytes32 id = _write(address(raw), d);
        assertEq(id, expected);
        assertTrue(chunks.exists(id));
        assertEq(chunks.sizeOf(id), d.length);
        (address b, uint48 size, bytes32 pointer, bytes32 dataHash) = chunks.recordOf(id);
        assertEq(b, address(raw));
        assertEq(size, d.length);
        assertEq(dataHash, keccak256(d));
        assertTrue(address(uint160(uint256(pointer))).code.length > 0);
        assertEq(chunks.read(id), d);
    }

    function test_dedupSkipsBackend() public {
        bytes memory d = "dedup";
        bytes32 a = _write(address(scripted), d);
        assertEq(scripted.stores(), 1);
        bytes32 b = _write(address(scripted), d);
        assertEq(a, b);
        assertEq(scripted.stores(), 1, "an existing id never calls the backend");
    }

    /// @dev `store` receives the account that called `write`, directly or through `multicall`, so a backend can bill
    ///      writers; a backend that checks `msg.sender` cannot be billed for someone else, and dedup charges once.
    function test_backendSeesTheWriter() public {
        MeteredBackend metered = new MeteredBackend(address(chunks));
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        metered.deposit(alice, 10);
        bytes memory d = "0123456789";

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MeteredBackend.InsufficientDeposit.selector, bob));
        chunks.write(address(metered), d, keccak256(d), 10);

        vm.prank(alice);
        bytes32 id = chunks.write(address(metered), d, keccak256(d), 10);
        assertEq(metered.lastCaller(), alice);
        assertEq(metered.deposits(alice), 0);
        assertEq(chunks.read(id), d);

        // An existing chunk never reaches the backend, so bob writes it for free.
        vm.prank(bob);
        assertEq(chunks.write(address(metered), d, keccak256(d), 10), id);

        // Through multicall the caller is still the writer.
        metered.deposit(bob, 3);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(IChunkStore.write, (address(metered), bytes("abc"), keccak256("abc"), 3));
        vm.prank(bob);
        chunks.multicall(calls);
        assertEq(metered.lastCaller(), bob);
        assertEq(metered.deposits(bob), 0);

        // Called directly, a gated backend refuses: nobody can spend alice's deposit by naming her.
        metered.deposit(alice, 5);
        vm.expectRevert(MeteredBackend.NotChunkStore.selector);
        metered.store("x", alice);
    }

    function test_readableClaimsAreChecked() public {
        bytes memory d = "claimed";
        bytes32 wrongHash = keccak256("not it");
        bytes32 id1 = chunks.chunkId(address(raw), keccak256(d), wrongHash, uint48(d.length));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id1));
        chunks.write(address(raw), d, wrongHash, uint48(d.length));
        bytes32 id2 = chunks.chunkId(address(raw), keccak256(d), keccak256(d), uint48(d.length + 1));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id2));
        chunks.write(address(raw), d, keccak256(d), uint48(d.length + 1));
        assertFalse(chunks.exists(id1) || chunks.exists(id2));
    }

    function test_lyingBackendAtWriteIsRefused() public {
        scripted.set("something else");
        bytes memory d = "truth";
        bytes32 id = chunks.chunkId(address(scripted), keccak256(d), keccak256(d), uint48(d.length));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        _write(address(scripted), d);
    }

    function test_retrieveRevertingAtWriteFailsTheWrite() public {
        scripted.setFail(true);
        vm.expectRevert(bytes("scripted failure"));
        _write(address(scripted), "x");
    }

    function test_mutatedBackendIsCaughtOnRead() public {
        bytes memory d = "original";
        bytes32 id = _write(address(scripted), d);
        assertEq(chunks.read(id), d);
        scripted.set("changed!"); // same length, different bytes
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        chunks.read(id);
        scripted.set("shorter"); // well formed, inside the padded window, wrong length
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        chunks.read(id);
        scripted.set(new bytes(100)); // larger than the record allows: never copied
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(scripted)));
        chunks.read(id);
        scripted.setFail(true);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(scripted)));
        chunks.read(id);
    }

    function test_malformedReturnsAreRetrieveFailed() public {
        bytes memory d = new bytes(40);
        d[0] = 0x01;
        bytes32 id = _write(address(scripted), d);

        // offset word is not 0x20
        scripted.setRaw(abi.encodePacked(uint256(0x40), uint256(40), d, new bytes(24)));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(scripted)));
        chunks.read(id);
        // shorter than an offset and a length
        scripted.setRaw(hex"00");
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(scripted)));
        chunks.read(id);
        // far more than the record's size: refused before any of it is copied
        scripted.setRaw(abi.encode(new bytes(100_000)));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(scripted)));
        chunks.read(id);
        // a well-formed `bytes` of another length that still fits the padded window
        scripted.setRaw(abi.encode(new bytes(33)));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        chunks.read(id);
        // unpadded but complete: accepted
        scripted.setRaw(abi.encodePacked(uint256(0x20), uint256(40), d));
        assertEq(chunks.read(id), d);
    }

    // ---- unreadable backends ------------------------------------------

    function test_unreadableClaimsAreBoundNotChecked() public {
        bytes memory input = "compressed or elsewhere";
        bytes32 dataHash = keccak256("the real data");
        bytes32 id = chunks.write(address(logBackend), input, dataHash, 1_000_000);
        assertEq(id, chunks.chunkId(address(logBackend), keccak256(input), dataHash, 1_000_000));
        assertEq(chunks.sizeOf(id), 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.RetrieveFailed.selector, id, address(logBackend)));
        chunks.read(id);
    }

    /// A false claim cannot occupy the id an honest writer computes for the same data.
    function test_falseClaimCannotSquat() public {
        bytes memory real = "real bytes";
        bytes32 squat = chunks.write(address(logBackend), "garbage", keccak256(real), uint48(real.length));
        bytes32 honest = chunks.write(address(logBackend), real, keccak256(real), uint48(real.length));
        assertTrue(squat != honest);
        assertEq(logBackend.stores(), 2);
    }

    function test_readableFlagChangingLaterStillChecks() public {
        // Written while claiming to be unreadable (claims unchecked), served later while claiming to be readable.
        scripted.setReadable(false);
        scripted.set("served bytes");
        bytes32 id = chunks.write(address(scripted), "input", keccak256("claimed"), 12);
        scripted.setReadable(true);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.DataMismatch.selector, id));
        chunks.read(id);
    }

    // ---- re-entrancy ---------------------------------------------------

    function test_reentrySameIdStands() public {
        ReentrantBackend r = new ReentrantBackend(chunks);
        r.setSame(true);
        bytes memory d = "re-enter";
        bytes32 id = _write(address(r), d);
        assertTrue(chunks.exists(id));
        assertEq(chunks.sizeOf(id), d.length);
    }

    function test_reentryOtherIdIsOwnNamespace() public {
        ReentrantBackend r = new ReentrantBackend(chunks);
        bytes memory d = "outer";
        bytes32 id = _write(address(r), d);
        bytes memory inner = bytes.concat(d, "!");
        bytes32 innerId = chunks.chunkId(address(r), keccak256(inner), keccak256(inner), uint48(inner.length));
        assertTrue(chunks.exists(id) && chunks.exists(innerId));
        (address b,,,) = chunks.recordOf(innerId);
        assertEq(b, address(r));
    }

    // ---- rejects -------------------------------------------------------

    function test_rejects() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.InvalidBackend.selector, eoa));
        chunks.write(eoa, "x", keccak256("x"), 1);
        vm.expectRevert(IChunkStore.EmptyChunk.selector);
        chunks.write(address(raw), "x", keccak256("x"), 0);
        vm.expectRevert(abi.encodeWithSelector(Sstore2Backend.InputSize.selector, 0));
        chunks.write(address(raw), "", keccak256(""), 1);
        bytes32 nope = bytes32(uint256(1));
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.ChunkNotFound.selector, nope));
        chunks.read(nope);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.ChunkNotFound.selector, nope));
        chunks.sizeOf(nope);
        vm.expectRevert(abi.encodeWithSelector(IChunkStore.ChunkNotFound.selector, nope));
        chunks.recordOf(nope);
        assertFalse(chunks.exists(nope));
    }

    function test_noEth() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(ChunkStore.write, (address(raw), bytes("x"), keccak256("x"), uint48(1)));
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        chunks.multicall{value: 1}(calls);
        (bool ok,) = address(chunks).call{value: 1}("");
        assertFalse(ok, "no receive");
        chunks.multicall(calls);
        assertTrue(chunks.exists(chunks.chunkId(address(raw), keccak256("x"), keccak256("x"), 1)));
    }

    // ---- gas -----------------------------------------------------------

    function test_gas_fullChunk() public {
        bytes memory d = new bytes(24_575);
        for (uint256 i; i < d.length; i += 97) d[i] = bytes1(uint8(i));
        uint256 g = gasleft();
        bytes32 id = _write(address(raw), d);
        emit log_named_uint("gas: 24,575-byte chunk, raw SSTORE2 (warm test context)", g - gasleft());
        g = gasleft();
        chunks.read(id);
        emit log_named_uint("gas: read it back", g - gasleft());
    }
}
