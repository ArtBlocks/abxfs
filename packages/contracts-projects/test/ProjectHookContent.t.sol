// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ChunkStore} from "@abxfs/core/ChunkStore.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {Sstore2Backend} from "@abxfs/core/backends/Sstore2Backend.sol";
import {IStorageBackend} from "@abxfs/core/interfaces/IStorageBackend.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";
import {MockAbxToken} from "./mocks/Mocks.sol";

/// @dev A backend whose bytes are elsewhere and which reverts on every call once `brick()` is called, so any call
///      the hook made to it would revert the publish.
contract BrickableBackend is IStorageBackend {
    bool public bricked;

    function brick() external {
        bricked = true;
    }

    function store(bytes calldata input, address) external view returns (bytes32) {
        require(!bricked, "bricked");
        return keccak256(input);
    }

    function readable() external view returns (bool) {
        require(!bricked, "bricked");
        return false;
    }

    function retrieve(bytes32) external pure returns (bytes memory) {
        revert NotEvmReadable();
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("test", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @dev The hook against the REAL ABX FS content stores: empty roots publish like
///      any other, and the hook never calls a storage backend.
contract ProjectHookContentTest is Test {
    ChunkStore internal chunks;
    Sstore2Backend internal raw;
    FileStore internal files;
    DirectoryStore internal dirs;
    ProjectHook internal hook;
    MockAbxToken internal token;

    address internal alice = address(0xA11CE);
    bytes32 internal constant KEY_CID = "abxfs.cid";

    function setUp() public {
        chunks = new ChunkStore();
        raw = new Sstore2Backend();
        files = new FileStore(address(chunks));
        dirs = new DirectoryStore(address(files));
        hook = new ProjectHook(address(dirs), address(files), address(0));
        token = new MockAbxToken(address(hook));
        for (uint256 id = 1; id <= 6; ++id) token.setOwner(id, alice);
    }

    function _publish(uint256 tokenId, bytes32 cid) internal {
        vm.prank(alice);
        token.configure(tokenId, KEY_CID, cid);
    }

    function _kind(uint256 tokenId) internal view returns (uint8) {
        return uint8(hook.kindOf(address(token), tokenId));
    }

    function _file(address backend, bytes memory body) internal returns (bytes32) {
        bytes32 chunk = chunks.write(backend, body, keccak256(body), uint48(body.length));
        bytes32 leaf = files.putChunkNode(abi.encodePacked(hex"00", chunk, uint48(body.length)));
        return files.createFile(leaf, "text/html", bytes32(0), bytes32(0));
    }

    function _dirWith(string memory name, bytes32 cid, bool isDir) internal returns (bytes32) {
        bytes memory n = bytes(name);
        bytes memory rec = abi.encodePacked(uint8(n.length), n, uint8(isDir ? 1 : 0), cid);
        return dirs.createDirectory(dirs.putEntryNode(abi.encodePacked(hex"00", uint16(1), uint16(0), rec)));
    }

    function test_emptyDirectoryPublishesAsDirectoryWithoutBeingCreated() public {
        bytes32 empty = dirs.EMPTY_DIRECTORY();
        _publish(1, empty);
        assertEq(_kind(1), uint8(IProjectHook.ContentKind.Directory));
        (uint256 v, bytes32 cid) = hook.latestVersion(address(token), 1);
        assertEq(v, 1);
        assertEq(cid, empty);
    }

    function test_emptyFilePublishesAsFileOnceCreated() public {
        bytes32 empty = files.fileCid(bytes32(0), "text/plain", bytes32(0), bytes32(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, empty));
        token.configure(2, KEY_CID, empty);

        assertEq(files.createFile(bytes32(0), "text/plain", bytes32(0), bytes32(0)), empty);
        _publish(2, empty);
        assertEq(_kind(2), uint8(IProjectHook.ContentKind.File));
    }

    function test_kindLockHoldsAcrossEmptyAndNonEmptyRoots() public {
        bytes32 site = _dirWith("index.html", _file(address(raw), "<p>hi</p>"), false);
        _publish(3, dirs.EMPTY_DIRECTORY());
        _publish(3, site); // directory to directory, empty to non-empty
        assertEq(hook.versionCount(address(token), 3), 2);

        bytes32 emptyFile = files.createFile(bytes32(0), "text/plain", bytes32(0), bytes32(0));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.Directory, IProjectHook.ContentKind.File
            )
        );
        token.configure(3, KEY_CID, emptyFile);
    }

    function test_realNestedDirectoryWithEmptyChildren() public {
        bytes32 emptyFile = files.createFile(bytes32(0), "text/plain", bytes32(0), bytes32(0));
        bytes memory a = bytes(".nojekyll");
        bytes memory b = bytes("assets");
        bytes memory c = bytes("index.html");
        bytes32 index = _file(address(raw), "<h1>site</h1>");
        bytes memory r1 = abi.encodePacked(uint8(a.length), a, uint8(0), emptyFile);
        bytes memory r2 = abi.encodePacked(uint8(b.length), b, uint8(1), dirs.EMPTY_DIRECTORY());
        bytes memory r3 = abi.encodePacked(uint8(c.length), c, uint8(0), index);
        bytes memory leaf = abi.encodePacked(
            hex"00", uint16(3), uint16(0), uint16(r1.length), uint16(r1.length + r2.length), r1, r2, r3
        );
        bytes32 site = dirs.createDirectory(dirs.putEntryNode(leaf));
        _publish(4, site);
        assertEq(_kind(4), uint8(IProjectHook.ContentKind.Directory));
    }

    /// The hook asks the stores, never a backend: a backend that reverts on every call cannot stop a publish of
    /// content stored through it.
    function test_publishNeverCallsAStorageBackend() public {
        BrickableBackend backend = new BrickableBackend();
        bytes memory body = "stored elsewhere";
        bytes32 chunk = chunks.write(address(backend), body, keccak256(body), uint48(body.length));
        bytes32 leaf = files.putChunkNode(abi.encodePacked(hex"00", chunk, uint48(body.length)));
        bytes32 file = files.createFile(leaf, "text/plain", bytes32(0), bytes32(0));
        bytes32 site = _dirWith("a.txt", file, false);
        backend.brick();

        vm.expectCall(address(backend), "", 0); // counted at the end of the test: zero calls across both publishes
        _publish(5, site);
        assertEq(_kind(5), uint8(IProjectHook.ContentKind.Directory));
        _publish(6, file);
        assertEq(_kind(6), uint8(IProjectHook.ContentKind.File));
    }
}
