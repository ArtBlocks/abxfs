// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm, stdError} from "forge-std/Test.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockRegistry} from "./mocks/AbxMocks.sol";
import {RawStub} from "./mocks/Hostile.sol";

/// @dev `ProjectHook` is a veto on every publish and holds the tag, history and ledger state. These tests take each
///      condition in it (every leg of every `||` and `&&`, every boundary of every cap) and assert the exact error and
///      arguments, or the exact value and the state left behind.
contract ProjectHookBranchesTest is Test {
    ProjectHook internal hook;
    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxToken internal token;
    MockRegistry internal registry;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant DIR_A = keccak256("dir-a");
    bytes32 internal constant DIR_B = keccak256("dir-b");
    bytes32 internal constant DIR_C = keccak256("dir-c");
    bytes32 internal constant FILE_A = keccak256("file-a");
    bytes32 internal constant FILE_B = keccak256("file-b");
    uint256 internal constant TOKEN = 7;
    uint256 internal constant SENTINEL = type(uint256).max;

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        registry = new MockRegistry();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(registry));
        token = new MockAbxToken(address(hook));
        dirStore.add(DIR_A);
        dirStore.add(DIR_B);
        dirStore.add(DIR_C);
        fileStore.add(FILE_A);
        fileStore.add(FILE_B);
        token.setOwner(TOKEN, alice);
        registry.set(address(token), true);
    }

    function _publish(uint256 id, bytes32 cid) internal {
        vm.prank(alice);
        token.configure(id, KEY_CID, cid);
    }

    /// @dev Call the hook directly as `msg.sender == caller`, the way a collection (or anyone) can.
    function _configure(address caller, uint256 id, bytes32 key, bytes32 value, uint256 dataLength) internal {
        vm.prank(caller);
        hook.onParamConfigured(id, key, value, alice, dataLength, address(0));
    }

    function test_theConstructorArgumentsAreImmutableGetters() public view {
        assertEq(address(hook.directoryStore()), address(dirStore));
        assertEq(address(hook.fileStore()), address(fileStore));
        assertEq(hook.factory(), address(registry));
        assertEq(hook.KEY_CID(), "abxfs.cid");
        assertEq(hook.KEY_GATEWAY(), "abxfs.gateway");
        assertEq(hook.KEY_NAME(), "abxfs.name");
        assertEq(hook.KEY_VIEW(), "abxfs.view");
        assertEq(hook.KEY_META(), "abxfs.meta");
        assertEq(hook.MAX_NAME_BYTES(), 128);
        assertEq(hook.MAX_GATEWAY_BYTES(), 512);
        assertEq(hook.MAX_VIEW_BYTES(), 512);
        assertEq(hook.MAX_META_BYTES(), 4096);
    }

    // ─── onParamConfigured: the sentinel, the five keys, and every other key ──

    /// @dev "The collection surface carries no project": ignored for every key, whatever the length or value, including
    ///      a cid no store has and a name far over its cap.
    function test_theCollectionSentinelIsIgnoredForEveryKey() public {
        bytes32[6] memory keys =
            [KEY_CID, bytes32("abxfs.name"), bytes32("abxfs.gateway"), bytes32("abxfs.view"), bytes32("abxfs.meta"), bytes32("whatever")];
        for (uint256 i; i < keys.length; ++i) {
            _configure(address(token), SENTINEL, keys[i], keccak256("no store has this"), type(uint256).max);
        }
        assertEq(hook.versionCount(address(token), SENTINEL), 0);
        assertEq(hook.publishCount(address(token)), 0);
        assertEq(hook.globalPublishCount(), 0);
        // And the id just below it is a real token id: not ignored.
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, keccak256("no store has this")));
        _configure(address(token), SENTINEL - 1, KEY_CID, keccak256("no store has this"), 0);
    }

    function _capCase(bytes32 key, uint256 cap) internal {
        _configure(address(token), TOKEN, key, 0, 0);
        _configure(address(token), TOKEN, key, 0, cap - 1);
        _configure(address(token), TOKEN, key, 0, cap);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, key, cap + 1, cap));
        _configure(address(token), TOKEN, key, 0, cap + 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, key, type(uint256).max, cap));
        _configure(address(token), TOKEN, key, 0, type(uint256).max);
        // The value word is a keccak commitment for a data param: not interpreted.
        _configure(address(token), TOKEN, key, keccak256("anything"), cap);
    }

    function test_everySizeCapIsInclusiveAndNamesItsKey() public {
        _capCase("abxfs.name", 128);
        _capCase("abxfs.gateway", 512);
        _capCase("abxfs.view", 512);
        _capCase("abxfs.meta", 4096);
    }

    /// @dev Each key's cap is its own: one key's cap does not apply to another, and an unknown key has none.
    function test_theCapsAreIndependentPerKey() public {
        _configure(address(token), TOKEN, "abxfs.meta", 0, 4096); // far over name's 128
        _configure(address(token), TOKEN, "abxfs.gateway", 0, 512); // over name's, equal to view's
        _configure(address(token), TOKEN, "abxfs.future", 0, type(uint256).max);
        _configure(address(token), TOKEN, bytes32(0), 0, type(uint256).max);
        _configure(address(token), TOKEN, "abxfs.cid ", 0, type(uint256).max); // a near miss of the cid key is unknown, so
        // it is ignored: no store probe, no version
        assertEq(hook.versionCount(address(token), TOKEN), 0);
    }

    /// @dev `abxfs.cid` carries a bytes32 and has no size: its `dataLength` is not policed.
    function test_theCidKeyIgnoresDataLength() public {
        _configure(address(token), TOKEN, KEY_CID, DIR_A, type(uint256).max);
        assertEq(hook.versionCount(address(token), TOKEN), 1);
    }

    // ─── _recordVersion ──────────────────────────────────────────────────────

    function test_rootNotFoundNamesTheCid() public {
        bytes32 nowhere = keccak256("nowhere");
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, nowhere));
        _publish(TOKEN, nowhere);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, bytes32(0)));
        _publish(TOKEN, bytes32(0));
        assertEq(hook.versionCount(address(token), TOKEN), 0, "a veto records nothing");
        assertEq(hook.publishCount(address(token)), 0);
        assertEq(hook.globalPublishCount(), 0);
        assertEq(uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.Unset));
    }

    /// @dev A cid both stores report is a directory (the directory store is asked first).
    function test_aCidInBothStoresIsADirectory() public {
        bytes32 both = keccak256("both");
        dirStore.add(both);
        fileStore.add(both);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectVersionPublished(address(token), TOKEN, 1, both, IProjectHook.ContentKind.Directory, alice);
        _publish(TOKEN, both);
        assertEq(uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.Directory));
    }

    function test_theKindLockNamesBothKindsInBothDirections() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.Directory, IProjectHook.ContentKind.File)
        );
        _publish(TOKEN, FILE_A);

        token.setOwner(8, alice);
        _publish(8, FILE_A);
        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.File, IProjectHook.ContentKind.Directory)
        );
        _publish(8, DIR_A);
        // Nothing was recorded by either veto.
        assertEq(hook.versionCount(address(token), TOKEN), 1);
        assertEq(hook.versionCount(address(token), 8), 1);
        assertEq(hook.publishCount(address(token)), 2);
    }

    /// @dev Only the head is compared: republishing the head is refused, an earlier root is a rollback.
    function test_sameRootNamesTheCidAndOnlyChecksTheHead() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, DIR_A));
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        _publish(TOKEN, DIR_A); // an earlier root is not the head: a rollback is allowed
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, DIR_A));
        _publish(TOKEN, DIR_A);
        assertEq(hook.versionCount(address(token), TOKEN), 3);
    }

    /// @dev Another token's head does not count, and the same token id in another collection is independent.
    function test_sameRootIsPerProject() public {
        token.setOwner(8, alice);
        _publish(TOKEN, DIR_A);
        _publish(8, DIR_A);
        MockAbxToken other = new MockAbxToken(address(hook));
        other.setOwner(TOKEN, alice);
        vm.prank(alice);
        other.configure(TOKEN, KEY_CID, DIR_A);
        assertEq(hook.versionCount(address(token), TOKEN), 1);
        assertEq(hook.versionCount(address(token), 8), 1);
        assertEq(hook.versionCount(address(other), TOKEN), 1);
    }

    function test_theVersionEventAndRecordCarryEverything() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectVersionPublished(address(token), TOKEN, 1, FILE_A, IProjectHook.ContentKind.File, alice);
        _publish(TOKEN, FILE_A);
        vm.warp(1_700_000_100);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectVersionPublished(address(token), TOKEN, 2, FILE_B, IProjectHook.ContentKind.File, alice);
        _publish(TOKEN, FILE_B);

        IProjectHook.Version memory v = hook.versionAt(address(token), TOKEN, 2);
        assertEq(v.cid, FILE_B);
        assertEq(v.publishedAt, 1_700_000_100);
        assertEq(v.publisher, alice);
        IProjectHook.PublishRecord memory r = hook.publishAt(address(token), 1);
        assertEq(r.cid, FILE_B);
        assertEq(r.publisher, alice);
        assertEq(r.publishedAt, 1_700_000_100);
        assertEq(r.version, 2);
        assertEq(r.tokenId, TOKEN);
    }

    /// @dev The stores are trusted constructor arguments, and the veto fails closed on them: a store that reverts, has
    ///      no code or answers with something that is not a bool blocks the publish and records nothing.
    function test_aMisbehavingStoreBlocksThePublishAndRecordsNothing() public {
        RawStub store = new RawStub();
        bytes4 dirSel = bytes4(keccak256("directoryExists(bytes32)"));
        bytes4 fileSel = bytes4(keccak256("fileExists(bytes32)"));
        address[3] memory stores = [address(store), address(0xDEAD), address(store)];
        for (uint256 i; i < stores.length; ++i) {
            if (i == 0) {
                store.boom(dirSel);
            } else if (i == 2) {
                store.ret(dirSel, abi.encode(uint256(2))); // not a bool
            }
            ProjectHook h = new ProjectHook(stores[i], address(fileStore), address(0));
            MockAbxToken t = new MockAbxToken(address(h));
            t.setOwner(1, alice);
            vm.prank(alice);
            vm.expectRevert();
            t.configure(1, KEY_CID, DIR_A);
            assertEq(h.versionCount(address(t), 1), 0);
            assertEq(h.publishCount(address(t)), 0);
        }
        // The file store is asked when the directory store says no, and fails closed the same way.
        store.ret(dirSel, abi.encode(false));
        store.boom(fileSel);
        ProjectHook hf = new ProjectHook(address(store), address(store), address(0));
        MockAbxToken tf = new MockAbxToken(address(hf));
        tf.setOwner(1, alice);
        vm.prank(alice);
        vm.expectRevert();
        tf.configure(1, KEY_CID, DIR_A);
        assertEq(hf.versionCount(address(tf), 1), 0);
        // and a "no" from both is RootNotFound.
        store.ret(fileSel, abi.encode(false));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, DIR_A));
        tf.configure(1, KEY_CID, DIR_A);
    }

    // ─── The global ledger ───────────────────────────────────────────────────

    function test_theGlobalLedgerPacksOrgAndOrgIndex() public {
        MockAbxToken second = new MockAbxToken(address(hook));
        second.setOwner(1, bob);
        registry.set(address(second), true);
        MockAbxToken stranger = new MockAbxToken(address(hook)); // not registered
        stranger.setOwner(1, bob);

        _publish(TOKEN, DIR_A); // token #0
        vm.prank(bob);
        second.configure(1, KEY_CID, DIR_A); // second #0
        vm.prank(bob);
        stranger.configure(1, KEY_CID, DIR_A); // not listed
        _publish(TOKEN, DIR_B); // token #1
        vm.prank(bob);
        second.configure(1, KEY_CID, DIR_B); // second #1

        assertEq(hook.globalPublishCount(), 4, "the stranger's publish is in its own ledger only");
        assertEq(hook.publishCount(address(stranger)), 1);
        address[4] memory orgs = [address(token), address(second), address(token), address(second)];
        uint256[4] memory idx = [uint256(0), 0, 1, 1];
        for (uint256 i; i < 4; ++i) {
            (address o, uint256 k) = hook.globalPublishAt(i);
            assertEq(o, orgs[i]);
            assertEq(k, idx[i]);
        }
    }

    function test_globalPublishAtOutOfRangeNamesIndexAndCount() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, 0, 0));
        hook.globalPublishAt(0);
        _publish(TOKEN, DIR_A);
        hook.globalPublishAt(0);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, 1, 1));
        hook.globalPublishAt(1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, type(uint256).max, 1));
        hook.globalPublishAt(type(uint256).max);
    }

    function test_globalPublishRangeClampsAtEveryEdge() public {
        bytes32[4] memory cids = [DIR_A, DIR_B, DIR_C, keccak256("dir-d")];
        dirStore.add(cids[3]);
        for (uint256 i; i < 4; ++i) {
            _publish(TOKEN, cids[i]);
        }
        uint256[2][8] memory q =
            [[uint256(0), 0], [uint256(0), 4], [uint256(0), 9], [uint256(1), 2], [uint256(3), 5], [uint256(4), 1], [uint256(9), 1], [uint256(1), type(uint256).max]];
        uint256[8] memory want = [uint256(0), 4, 4, 2, 1, 0, 0, 3];
        for (uint256 i; i < q.length; ++i) {
            (address[] memory orgs, uint256[] memory ks) = hook.globalPublishRange(q[i][0], q[i][1]);
            assertEq(orgs.length, want[i]);
            assertEq(ks.length, want[i]);
            for (uint256 k; k < want[i]; ++k) {
                assertEq(orgs[k], address(token));
                assertEq(ks[k], q[i][0] + k, "the org-log index, in order");
            }
        }
        (address[] memory none,) = hook.globalPublishRange(type(uint256).max, type(uint256).max);
        assertEq(none.length, 0);
    }

    // ─── The per-org ledger ──────────────────────────────────────────────────

    function _four() internal {
        dirStore.add(keccak256("dir-d"));
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        _publish(TOKEN, DIR_C);
        _publish(TOKEN, keccak256("dir-d"));
    }

    function test_publishAtPastTheEndIsAPanic() public {
        _four();
        assertEq(hook.publishAt(address(token), 3).version, 4);
        vm.expectRevert(stdError.indexOOBError);
        hook.publishAt(address(token), 4);
        vm.expectRevert(stdError.indexOOBError);
        hook.publishAt(address(0xDEAD), 0);
    }

    function test_publishRangeAtEveryEdge() public {
        _four();
        uint256[2][9] memory q = [
            [uint256(0), 0],
            [uint256(0), 4],
            [uint256(0), 5],
            [uint256(1), 2],
            [uint256(3), 1],
            [uint256(3), 9],
            [uint256(4), 1],
            [uint256(1), type(uint256).max],
            [type(uint256).max, type(uint256).max]
        ];
        uint256[9] memory want = [uint256(0), 4, 4, 2, 1, 1, 0, 3, 0];
        for (uint256 i; i < q.length; ++i) {
            IProjectHook.PublishRecord[] memory w = hook.publishRange(address(token), q[i][0], q[i][1]);
            assertEq(w.length, want[i]);
            for (uint256 k; k < want[i]; ++k) {
                assertEq(w[k].version, q[i][0] + k + 1, "oldest first, from `start`");
            }
        }
    }

    /// @dev `recentPublishesBefore(token, before, count)`: newest first, strictly before `before`, clamped to the log.
    function test_recentBeforeAtEveryEdge() public {
        _four();
        // (beforeIndex, count) -> first version returned (newest), length
        uint256[2][9] memory q = [
            [uint256(4), 4], // everything, newest first
            [uint256(4), 2],
            [uint256(4), 9], // count past the start clamps
            [uint256(3), 3], // strictly before index 3
            [uint256(1), 1],
            [uint256(0), 3], // nothing before the start
            [uint256(9), 2], // a cursor past the end is the end
            [uint256(4), 0], // count zero
            [type(uint256).max, type(uint256).max]
        ];
        uint256[9] memory length = [uint256(4), 2, 4, 3, 1, 0, 2, 0, 4];
        uint256[9] memory newest = [uint256(4), 4, 4, 3, 1, 0, 4, 0, 4];
        for (uint256 i; i < q.length; ++i) {
            IProjectHook.PublishRecord[] memory w = hook.recentPublishesBefore(address(token), q[i][0], q[i][1]);
            assertEq(w.length, length[i], "length");
            for (uint256 k; k < w.length; ++k) {
                assertEq(w[k].version, newest[i] - k, "newest first");
            }
        }
        // recentPublishes is "before the end".
        assertEq(hook.recentPublishes(address(token), 2).length, 2);
        assertEq(hook.recentPublishes(address(token), 2)[0].version, 4);
        assertEq(hook.recentPublishes(address(token), type(uint256).max).length, 4);
        assertEq(hook.recentPublishes(address(0xDEAD), 5).length, 0);
        assertEq(hook.recentPublishesBefore(address(0xDEAD), 5, 5).length, 0);
    }

    // ─── Versions and ranges ─────────────────────────────────────────────────

    function test_versionAtBoundaries() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 0, 0));
        hook.versionAt(address(token), TOKEN, 0);
        _four();
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 0, 4));
        hook.versionAt(address(token), TOKEN, 0);
        assertEq(hook.versionAt(address(token), TOKEN, 1).cid, DIR_A);
        assertEq(hook.versionAt(address(token), TOKEN, 4).cid, keccak256("dir-d"));
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 5, 4));
        hook.versionAt(address(token), TOKEN, 5);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, type(uint256).max, 4));
        hook.versionAt(address(token), TOKEN, type(uint256).max);
    }

    function test_versionsRangeBoundariesAndErrors() public {
        // An unpublished project: the only valid range is empty.
        assertEq(hook.versionsRange(address(token), TOKEN, 0, 0).length, 0);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 0, 1, 0));
        hook.versionsRange(address(token), TOKEN, 0, 1);
        _four();
        assertEq(hook.versionsRange(address(token), TOKEN, 0, 4).length, 4);
        assertEq(hook.versionsRange(address(token), TOKEN, 4, 4).length, 0, "start == end == count is empty");
        assertEq(hook.versionsRange(address(token), TOKEN, 2, 2).length, 0);
        IProjectHook.Version[] memory mid = hook.versionsRange(address(token), TOKEN, 1, 3);
        assertEq(mid.length, 2);
        assertEq(mid[0].cid, DIR_B);
        assertEq(mid[1].cid, DIR_C);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 3, 2, 4));
        hook.versionsRange(address(token), TOKEN, 3, 2); // start > end
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 0, 5, 4));
        hook.versionsRange(address(token), TOKEN, 0, 5); // end > count
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 5, 5, 4));
        hook.versionsRange(address(token), TOKEN, 5, 5); // start == end, both past the count
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 5, 4, 4));
        hook.versionsRange(address(token), TOKEN, 5, 4); // both legs at once
    }

    function test_latestVersionAndKind() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.NoVersions.selector, address(token), TOKEN));
        hook.latestVersion(address(token), TOKEN);
        _publish(TOKEN, FILE_A);
        (uint256 v, bytes32 cid) = hook.latestVersion(address(token), TOKEN);
        assertEq(v, 1);
        assertEq(cid, FILE_A);
        assertEq(uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.File));
        _publish(TOKEN, FILE_B);
        (v, cid) = hook.latestVersion(address(token), TOKEN);
        assertEq(v, 2);
        assertEq(cid, FILE_B);
    }

    // ─── Tags ────────────────────────────────────────────────────────────────

    function _isLowerAlnum(uint256 c) internal pure returns (bool) {
        return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
    }

    /// @dev `^[a-z0-9][a-z0-9._-]{0,63}$`, byte value by byte value: as the first byte, and as a later byte.
    function test_tagCharsetByEveryByteValue() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        for (uint256 c; c < 256; ++c) {
            // As the first byte of a two-byte tag.
            string memory first = string(abi.encodePacked(bytes1(uint8(c)), "x"));
            if (_isLowerAlnum(c)) {
                hook.setTag(address(token), TOKEN, first, 1);
                hook.removeTag(address(token), TOKEN, first);
            } else {
                vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, first));
                hook.setTag(address(token), TOKEN, first, 1);
            }
            // As a later byte: also `.`, `_` and `-`.
            string memory later = string(abi.encodePacked("x", bytes1(uint8(c)), "y"));
            if (_isLowerAlnum(c) || c == 0x2e || c == 0x5f || c == 0x2d) {
                hook.setTag(address(token), TOKEN, later, 1);
                hook.removeTag(address(token), TOKEN, later);
            } else {
                vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, later));
                hook.setTag(address(token), TOKEN, later, 1);
            }
        }
        vm.stopPrank();
        assertEq(hook.tagCount(address(token), TOKEN), 0);
    }

    function _a(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    function test_tagLengthBoundaries() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, _a(1), 1);
        hook.setTag(address(token), TOKEN, _a(64), 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, _a(65)));
        hook.setTag(address(token), TOKEN, _a(65), 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, ""));
        hook.setTag(address(token), TOKEN, "", 1);
        // The same bounds on removal and the same error.
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, _a(65)));
        hook.removeTag(address(token), TOKEN, _a(65));
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, ""));
        hook.removeTag(address(token), TOKEN, "");
        // A 64-byte tag that is not the one set is just not found.
        hook.removeTag(address(token), TOKEN, _a(64));
        vm.stopPrank();
        assertEq(hook.tagCount(address(token), TOKEN), 1, "only the one-byte tag is left");
    }

    function test_theReservedTagIsRefusedByNameOnBothWrites_andIsCheckedAfterTheCharset() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.ReservedTag.selector, "latest"));
        hook.setTag(address(token), TOKEN, "latest", 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.ReservedTag.selector, "latest"));
        hook.removeTag(address(token), TOKEN, "latest");
        // Near misses are ordinary tags (or invalid), not reserved.
        hook.setTag(address(token), TOKEN, "latest1", 1);
        hook.setTag(address(token), TOKEN, "latesu", 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, "Latest"));
        hook.setTag(address(token), TOKEN, "Latest", 1);
        vm.stopPrank();
    }

    /// @dev Checks run in a fixed order: the project's owner first, then the tag's shape, then reserved, then the
    ///      version, so each error is reached by the call that fails only that one.
    function test_setTagChecksRunInOrder() public {
        _publish(TOKEN, DIR_A);
        // Not the owner AND an invalid tag AND a reserved tag AND a bad version: the owner error wins.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.NotProjectOwner.selector, address(token), TOKEN, bob));
        hook.setTag(address(token), TOKEN, "", 99);
        // Owner, invalid tag, bad version: the tag error wins.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, "BAD"));
        hook.setTag(address(token), TOKEN, "BAD", 99);
        // Owner, reserved, bad version: the reserved error wins.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.ReservedTag.selector, "latest"));
        hook.setTag(address(token), TOKEN, "latest", 99);
        // Only the version is wrong.
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 0, 1));
        hook.setTag(address(token), TOKEN, "ok", 0);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 2, 1));
        hook.setTag(address(token), TOKEN, "ok", 2);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, type(uint256).max, 1));
        hook.setTag(address(token), TOKEN, "ok", type(uint256).max);
        // A version that would fit a uint32 only after truncation is still out of range, not wrapped.
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, (uint256(1) << 32) + 1, 1));
        hook.setTag(address(token), TOKEN, "ok", (uint256(1) << 32) + 1);
        hook.setTag(address(token), TOKEN, "ok", 1);
        vm.stopPrank();
    }

    function test_removeTagChecksRunInOrder() public {
        _publish(TOKEN, DIR_A);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.NotProjectOwner.selector, address(token), TOKEN, bob));
        hook.removeTag(address(token), TOKEN, "nope");
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), TOKEN, "nope"));
        hook.removeTag(address(token), TOKEN, "nope");
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, "NOPE"));
        hook.removeTag(address(token), TOKEN, "NOPE");
        vm.stopPrank();
    }

    /// @dev `ownerOf` reverting for a token that does not exist propagates; a no-code token reverts too. Neither
    ///      silently authorizes anyone.
    function test_tagWritesOnATokenThatCannotAnswerOwnerOfRevert() public {
        vm.prank(alice);
        vm.expectRevert(bytes("nonexistent token"));
        hook.setTag(address(token), 12345, "x", 1);
        vm.prank(alice);
        vm.expectRevert(bytes("nonexistent token"));
        hook.removeTag(address(token), 12345, "x");
        vm.prank(alice);
        vm.expectRevert();
        hook.setTag(address(0xDEAD), TOKEN, "x", 1);
        vm.prank(alice);
        vm.expectRevert();
        hook.removeTag(address(0), TOKEN, "x");
    }

    function test_theTagEventsCarryTheirArguments() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        vm.startPrank(alice);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagSet(address(token), TOKEN, "stable", 1);
        hook.setTag(address(token), TOKEN, "stable", 1);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagMoved(address(token), TOKEN, "stable", 1, 2);
        hook.setTag(address(token), TOKEN, "stable", 2);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagMoved(address(token), TOKEN, "stable", 2, 2); // the same version again
        hook.setTag(address(token), TOKEN, "stable", 2);
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagRemoved(address(token), TOKEN, "stable");
        hook.removeTag(address(token), TOKEN, "stable");
        // A removed tag is new again.
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagSet(address(token), TOKEN, "stable", 1);
        hook.setTag(address(token), TOKEN, "stable", 1);
        vm.stopPrank();
        assertEq(hook.tagCount(address(token), TOKEN), 1, "no duplicate left by the cycle");
    }

    /// @dev Removing from the front, the middle and the back of a list of four, with every survivor still addressable
    ///      and removable afterwards.
    function test_removeTagFromEveryPosition() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        string[4] memory names = ["a", "b", "c", "d"];
        vm.startPrank(alice);
        for (uint256 i; i < 4; ++i) {
            hook.setTag(address(token), TOKEN, names[i], 1 + (i % 2));
        }

        hook.removeTag(address(token), TOKEN, "d"); // the last: no swap
        assertEq(_join(hook.listTags(address(token), TOKEN)), "a,b,c");
        hook.setTag(address(token), TOKEN, "d", 2);
        hook.removeTag(address(token), TOKEN, "a"); // the first: the last moves into its place
        assertEq(_join(hook.listTags(address(token), TOKEN)), "d,b,c");
        (uint256 v,) = hook.getTag(address(token), TOKEN, "d");
        assertEq(v, 2, "the moved tag keeps its version");
        hook.removeTag(address(token), TOKEN, "b"); // the middle
        assertEq(_join(hook.listTags(address(token), TOKEN)), "d,c");
        hook.removeTag(address(token), TOKEN, "d"); // the moved tag is still removable: its position was updated
        assertEq(_join(hook.listTags(address(token), TOKEN)), "c");
        hook.removeTag(address(token), TOKEN, "c"); // the only one
        assertEq(hook.tagCount(address(token), TOKEN), 0);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), TOKEN, "a"));
        hook.getTag(address(token), TOKEN, "a");
    }

    // Storage layout (`forge inspect ProjectHook storage-layout`).
    uint256 internal constant SLOT_TAG_RECORDS = 3;
    uint256 internal constant SLOT_TAG_INDEX = 5;

    function _tagSlot(uint256 mapSlot, string memory tag) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(tag)), keccak256(abi.encode(TOKEN, keccak256(abi.encode(address(token), mapSlot))))));
    }

    /// @dev A removed tag's record and position are deleted (not merely unlinked), and a moved tag's position is updated.
    ///      Read from storage, since nothing else can tell a stale entry from a deleted one: a re-added tag overwrites it.
    function test_removeTagDeletesItsRecordAndPosition() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "a", 1);
        hook.setTag(address(token), TOKEN, "b", 1);
        hook.setTag(address(token), TOKEN, "c", 1);
        vm.stopPrank();
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, "a"))), 1);
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, "c"))), 3);
        assertTrue(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_RECORDS, "a"))) != 0, "a record is stored");

        vm.prank(alice);
        hook.removeTag(address(token), TOKEN, "a"); // `c` moves into `a`'s place
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, "a"))), 0, "the removed tag's position is cleared");
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_RECORDS, "a"))), 0, "and its record");
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, "c"))), 1, "the moved tag's position is updated");
        assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, "b"))), 2, "an untouched tag keeps its position");

        vm.startPrank(alice);
        hook.removeTag(address(token), TOKEN, "b");
        hook.removeTag(address(token), TOKEN, "c");
        vm.stopPrank();
        string[3] memory all = ["a", "b", "c"];
        for (uint256 i; i < 3; ++i) {
            assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_INDEX, all[i]))), 0, "no position left");
            assertEq(uint256(vm.load(address(hook), _tagSlot(SLOT_TAG_RECORDS, all[i]))), 0, "no record left");
        }
    }

    function _join(string[] memory s) internal pure returns (string memory out) {
        for (uint256 i; i < s.length; ++i) {
            out = i == 0 ? s[0] : string.concat(out, ",", s[i]);
        }
    }

    function test_getTagResolvesLatestAndNamedTagsAndRefusesTheRest() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.NoVersions.selector, address(token), TOKEN));
        hook.getTag(address(token), TOKEN, "latest");
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), TOKEN, "stable"));
        hook.getTag(address(token), TOKEN, "stable");

        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 1);
        (uint256 v, bytes32 cid) = hook.getTag(address(token), TOKEN, "latest");
        assertEq(v, 2);
        assertEq(cid, DIR_B);
        (v, cid) = hook.getTag(address(token), TOKEN, "stable");
        assertEq(v, 1);
        assertEq(cid, DIR_A);
        // An invalid tag name on a READ is just not found: only writes validate the shape.
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), TOKEN, "Stable"));
        hook.getTag(address(token), TOKEN, "Stable");
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), TOKEN, ""));
        hook.getTag(address(token), TOKEN, "");
    }

    function test_tagListViews() public {
        _publish(TOKEN, DIR_A);
        assertEq(hook.listTags(address(token), TOKEN).length, 0);
        assertEq(hook.tagCount(address(token), TOKEN), 0);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, 0, 0));
        hook.getTagAt(address(token), TOKEN, 0);
        assertEq(hook.getTagsRange(address(token), TOKEN, 0, 0).length, 0);

        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "a", 1);
        hook.setTag(address(token), TOKEN, "b", 1);
        hook.setTag(address(token), TOKEN, "c", 1);
        vm.stopPrank();

        assertEq(hook.getTagAt(address(token), TOKEN, 2), "c");
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, 3, 3));
        hook.getTagAt(address(token), TOKEN, 3);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, type(uint256).max, 3));
        hook.getTagAt(address(token), TOKEN, type(uint256).max);

        assertEq(_join(hook.getTagsRange(address(token), TOKEN, 0, 3)), "a,b,c");
        assertEq(_join(hook.getTagsRange(address(token), TOKEN, 1, 3)), "b,c");
        assertEq(hook.getTagsRange(address(token), TOKEN, 3, 3).length, 0);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 2, 1, 3));
        hook.getTagsRange(address(token), TOKEN, 2, 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 0, 4, 3));
        hook.getTagsRange(address(token), TOKEN, 0, 4);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 4, 4, 3));
        hook.getTagsRange(address(token), TOKEN, 4, 4);
    }

    /// @dev Tags are per project: the same name on another token or another collection is a different tag.
    function test_tagsArePerProject() public {
        token.setOwner(8, alice);
        _publish(TOKEN, DIR_A);
        _publish(8, DIR_B);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "v1", 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(token), 8, "v1"));
        hook.getTag(address(token), 8, "v1");
        hook.setTag(address(token), 8, "v1", 1);
        vm.stopPrank();
        (, bytes32 a) = hook.getTag(address(token), TOKEN, "v1");
        (, bytes32 b) = hook.getTag(address(token), 8, "v1");
        assertEq(a, DIR_A);
        assertEq(b, DIR_B);
    }
}
