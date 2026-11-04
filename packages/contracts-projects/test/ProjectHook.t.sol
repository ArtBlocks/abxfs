// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";

/// @dev The hook is a VETO on every governed write. A bug that wrongly reverts freezes publishing
///      for the whole protocol, and after the collection renounces ownership it can never be swapped
///      or cleared. So this suite weights the "must NOT revert" cases as heavily as the "must
///      revert" ones — the former are the unrecoverable failure mode.
contract ProjectHookTest is Test {
    ProjectHook internal hook;
    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxToken internal token;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_NAME = "abxfs.name";
    bytes32 internal constant KEY_GATEWAY = "abxfs.gateway";

    bytes32 internal constant DIR_A = keccak256("dir-a");
    bytes32 internal constant DIR_B = keccak256("dir-b");
    bytes32 internal constant FILE_A = keccak256("file-a");
    bytes32 internal constant UNKNOWN = keccak256("nowhere");

    uint256 internal constant TOKEN = 7;
    uint256 internal constant COLLECTION_SENTINEL = type(uint256).max;

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        token = new MockAbxToken(address(hook));

        dirStore.add(DIR_A);
        dirStore.add(DIR_B);
        fileStore.add(FILE_A);

        token.setOwner(TOKEN, alice);
    }

    function _publish(uint256 tokenId, bytes32 cid) internal {
        vm.prank(alice);
        token.configure(tokenId, KEY_CID, cid);
    }

    // ─── Publishing ───────────────────────────────────────────────────────────

    function test_FirstPublish_RecordsVersionAndLocksDirectoryKind() public {
        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectVersionPublished(
            address(token), TOKEN, 1, DIR_A, IProjectHook.ContentKind.Directory, alice
        );
        _publish(TOKEN, DIR_A);

        assertEq(hook.versionCount(address(token), TOKEN), 1);
        assertEq(
            uint8(hook.kindOf(address(token), TOKEN)),
            uint8(IProjectHook.ContentKind.Directory)
        );

        (uint256 version, bytes32 cid) = hook.latestVersion(address(token), TOKEN);
        assertEq(version, 1);
        assertEq(cid, DIR_A);

        IProjectHook.Version memory rec = hook.versionAt(address(token), TOKEN, 1);
        assertEq(rec.cid, DIR_A);
        assertEq(rec.publisher, alice);
        assertEq(rec.publishedAt, uint40(block.timestamp));
    }

    function test_FirstPublish_FileCidLocksFileKind() public {
        _publish(TOKEN, FILE_A);
        assertEq(
            uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.File)
        );
    }

    /// @dev The guarantee that a project cannot point at nothing.
    function test_Publish_RevertsWhenCidInNeitherStore() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, UNKNOWN));
        _publish(TOKEN, UNKNOWN);
    }

    function test_Publish_RevertsOnKindSwitch() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector,
                IProjectHook.ContentKind.Directory,
                IProjectHook.ContentKind.File
            )
        );
        _publish(TOKEN, FILE_A);
    }

    function test_Publish_RevertsOnRepublishingHead() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, DIR_A));
        _publish(TOKEN, DIR_A);
    }

    /// @dev Republishing an EARLIER cid is allowed — that is a rollback, and history stays append-only.
    function test_Publish_AllowsRollbackToEarlierCid() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);
        _publish(TOKEN, DIR_A);

        assertEq(hook.versionCount(address(token), TOKEN), 3);
        (, bytes32 cid) = hook.latestVersion(address(token), TOKEN);
        assertEq(cid, DIR_A);
    }

    function test_History_RangeAndBounds() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);

        IProjectHook.Version[] memory all = hook.versionsRange(address(token), TOKEN, 0, 2);
        assertEq(all.length, 2);
        assertEq(all[0].cid, DIR_A);
        assertEq(all[1].cid, DIR_B);

        // Half-open, so an empty window is legal.
        assertEq(hook.versionsRange(address(token), TOKEN, 1, 1).length, 0);

        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 0, 3, 2)
        );
        hook.versionsRange(address(token), TOKEN, 0, 3);

        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 2, 1, 2)
        );
        hook.versionsRange(address(token), TOKEN, 2, 1);
    }

    function test_Reads_OnUnpublishedProject() public {
        assertEq(hook.versionCount(address(token), TOKEN), 0);
        assertEq(
            uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.Unset)
        );

        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.NoVersions.selector, address(token), TOKEN)
        );
        hook.latestVersion(address(token), TOKEN);

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 1, 0));
        hook.versionAt(address(token), TOKEN, 1);
    }

    function test_VersionAt_RejectsZeroBecauseVersionsAreOneIndexed() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 0, 1));
        hook.versionAt(address(token), TOKEN, 0);
    }

    // ─── Must NOT revert ──────────────────────────────────────────────────────

    /// @dev THE most important test in the file. `setParamSchema` can add a key right up until the
    ///      collection renounces ownership, while the hook set is frozen earlier. A hook that
    ///      reverted on keys it did not recognize would permanently forbid every future key.
    function test_UnknownKey_IsIgnoredNotRejected() public {
        vm.prank(alice);
        token.configure(TOKEN, "some.future.key", bytes32(uint256(1234)));

        // Ignored means ignored: no version recorded, no kind locked.
        assertEq(hook.versionCount(address(token), TOKEN), 0);
        assertEq(
            uint8(hook.kindOf(address(token), TOKEN)), uint8(IProjectHook.ContentKind.Unset)
        );
    }

    /// @dev An unknown key whose value happens not to exist in either store must still pass — the
    ///      store probe belongs to `abxfs.cid` alone.
    function test_UnknownKey_WithUnresolvableValue_StillPasses() public {
        vm.prank(alice);
        token.configure(TOKEN, "other", UNKNOWN);
        assertEq(hook.versionCount(address(token), TOKEN), 0);
    }

    /// @dev A write against the collection surface (`contractURI`) is legitimate but carries no
    ///      project. Ignore rather than revert.
    function test_CollectionSentinel_IsIgnored() public {
        vm.prank(alice);
        token.configure(COLLECTION_SENTINEL, KEY_CID, UNKNOWN);
        assertEq(hook.versionCount(address(token), COLLECTION_SENTINEL), 0);
    }

    // ─── Blob size policing ───────────────────────────────────────────────────

    function test_Name_AtCapIsAccepted() public {
        vm.prank(alice);
        token.configureData(TOKEN, KEY_NAME, _bytesOfLength(hook.MAX_NAME_BYTES()));
    }

    function test_Name_OverCapReverts() public {
        uint256 over = hook.MAX_NAME_BYTES() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.BlobTooLarge.selector, KEY_NAME, over, hook.MAX_NAME_BYTES()
            )
        );
        vm.prank(alice);
        token.configureData(TOKEN, KEY_NAME, _bytesOfLength(over));
    }

    function test_Gateway_OverCapReverts() public {
        uint256 over = hook.MAX_GATEWAY_BYTES() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.BlobTooLarge.selector, KEY_GATEWAY, over, hook.MAX_GATEWAY_BYTES()
            )
        );
        vm.prank(alice);
        token.configureData(TOKEN, KEY_GATEWAY, _bytesOfLength(over));
    }

    /// @dev Unknown data keys are deliberately unpoliced: capping them would mean an immutable hook
    ///      dictating the size budget of every key declared after it was armed.
    function test_UnknownDataKey_IsNotSizeCapped() public {
        vm.prank(alice);
        token.configureData(TOKEN, "big.payload", _bytesOfLength(10_000));
    }

    // ─── Per-collection namespacing ───────────────────────────────────────────

    /// @dev One hook deployment serves every ABX FS collection. State keys on `msg.sender`, and only
    ///      the collection itself can be `msg.sender`, so there is no cross-collection write path.
    function test_TwoCollections_SameTokenId_HaveIndependentHistories() public {
        MockAbxToken other = new MockAbxToken(address(hook));
        other.setOwner(TOKEN, bob);

        _publish(TOKEN, DIR_A);

        vm.prank(bob);
        other.configure(TOKEN, KEY_CID, FILE_A);

        assertEq(hook.versionCount(address(token), TOKEN), 1);
        assertEq(hook.versionCount(address(other), TOKEN), 1);

        (, bytes32 a) = hook.latestVersion(address(token), TOKEN);
        (, bytes32 b) = hook.latestVersion(address(other), TOKEN);
        assertEq(a, DIR_A);
        assertEq(b, FILE_A);

        // Kinds are independent too — the lock is per project, not per hook.
        assertEq(
            uint8(hook.kindOf(address(token), TOKEN)),
            uint8(IProjectHook.ContentKind.Directory)
        );
        assertEq(
            uint8(hook.kindOf(address(other), TOKEN)), uint8(IProjectHook.ContentKind.File)
        );
    }

    /// @dev Calling the hook directly writes history under the caller's own address, never under a
    ///      real collection's. Harmless, and the reason namespacing by `msg.sender` is safe.
    function test_DirectHookCall_CannotPolluteAnotherCollection() public {
        vm.prank(bob);
        hook.onParamConfigured(TOKEN, KEY_CID, DIR_A, bob, 0, address(0));

        assertEq(hook.versionCount(address(token), TOKEN), 0);
        assertEq(hook.versionCount(bob, TOKEN), 1);
    }

    // ─── Tags ─────────────────────────────────────────────────────────────────

    function test_SetTag_ByOwner() public {
        _publish(TOKEN, DIR_A);

        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagSet(address(token), TOKEN, "v1.0.0", 1);
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "v1.0.0", 1);

        (uint256 version, bytes32 cid) = hook.getTag(address(token), TOKEN, "v1.0.0");
        assertEq(version, 1);
        assertEq(cid, DIR_A);
        assertEq(hook.tagCount(address(token), TOKEN), 1);
        assertEq(hook.getTagAt(address(token), TOKEN, 0), "v1.0.0");
    }

    function test_SetTag_ByNonOwnerReverts() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.NotProjectOwner.selector, address(token), TOKEN, bob
            )
        );
        vm.prank(bob);
        hook.setTag(address(token), TOKEN, "stable", 1);
    }

    /// @dev Tag authority follows the NFT, with no handshake and no migration step: a transfer is the
    ///      whole ownership change.
    function test_SetTag_FollowsNftOwnership() public {
        _publish(TOKEN, DIR_A);
        token.setOwner(TOKEN, bob);

        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.NotProjectOwner.selector, address(token), TOKEN, alice
            )
        );
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 1);

        vm.prank(bob);
        hook.setTag(address(token), TOKEN, "stable", 1);
        (uint256 version,) = hook.getTag(address(token), TOKEN, "stable");
        assertEq(version, 1);
    }

    function test_SetTag_IsUpsertAndEmitsMoved() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);

        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 1);

        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagMoved(address(token), TOKEN, "stable", 1, 2);
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 2);

        (uint256 version, bytes32 cid) = hook.getTag(address(token), TOKEN, "stable");
        assertEq(version, 2);
        assertEq(cid, DIR_B);
        assertEq(hook.tagCount(address(token), TOKEN), 1, "move must not duplicate the list entry");
    }

    function test_SetTag_RejectsVersionOutOfRange() public {
        _publish(TOKEN, DIR_A);

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 2, 1));
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 2);

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, 0, 1));
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 0);
    }

    /// @dev `latest` is virtual: always defined, always the head, never stored. That removes the
    ///      "project has no tags yet" special case from every off-chain resolver.
    function test_ReservedTag_LatestResolvesToHeadAndCannotBeWritten() public {
        _publish(TOKEN, DIR_A);
        _publish(TOKEN, DIR_B);

        (uint256 version, bytes32 cid) = hook.getTag(address(token), TOKEN, "latest");
        assertEq(version, 2);
        assertEq(cid, DIR_B);
        assertEq(hook.tagCount(address(token), TOKEN), 0, "latest must not occupy the tag list");

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.ReservedTag.selector, "latest"));
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "latest", 1);

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.ReservedTag.selector, "latest"));
        vm.prank(alice);
        hook.removeTag(address(token), TOKEN, "latest");
    }

    function test_RemoveTag() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "stable", 1);

        vm.expectEmit(true, true, false, true, address(hook));
        emit IProjectHook.ProjectTagRemoved(address(token), TOKEN, "stable");
        hook.removeTag(address(token), TOKEN, "stable");
        vm.stopPrank();

        assertEq(hook.tagCount(address(token), TOKEN), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.TagNotFound.selector, address(token), TOKEN, "stable"
            )
        );
        hook.getTag(address(token), TOKEN, "stable");
    }

    function test_RemoveTag_UnknownReverts() public {
        _publish(TOKEN, DIR_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.TagNotFound.selector, address(token), TOKEN, "ghost"
            )
        );
        vm.prank(alice);
        hook.removeTag(address(token), TOKEN, "ghost");
    }

    /// @dev Swap-and-pop keeps removal O(1) at the cost of list order. Verify the surviving set is
    ///      intact and the moved entry's index bookkeeping still resolves.
    function test_RemoveTag_SwapAndPopKeepsRemainingTagsAddressable() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "a", 1);
        hook.setTag(address(token), TOKEN, "b", 1);
        hook.setTag(address(token), TOKEN, "c", 1);
        hook.removeTag(address(token), TOKEN, "a"); // index 0, swapped with "c"
        vm.stopPrank();

        assertEq(hook.tagCount(address(token), TOKEN), 2);
        string[] memory tags = hook.listTags(address(token), TOKEN);
        assertEq(tags.length, 2);

        // Both survivors still resolve, and re-removal works through the rewritten index.
        (uint256 vb,) = hook.getTag(address(token), TOKEN, "b");
        (uint256 vc,) = hook.getTag(address(token), TOKEN, "c");
        assertEq(vb, 1);
        assertEq(vc, 1);

        vm.prank(alice);
        hook.removeTag(address(token), TOKEN, "c");
        assertEq(hook.tagCount(address(token), TOKEN), 1);
        assertEq(hook.getTagAt(address(token), TOKEN, 0), "b");
    }

    function test_TagName_Charset() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);

        // Semver shapes must work — that is why `.` is permitted.
        hook.setTag(address(token), TOKEN, "v1.2.3-rc.1", 1);
        hook.setTag(address(token), TOKEN, "nightly_build", 1);
        hook.setTag(address(token), TOKEN, "0", 1);

        string[4] memory bad = ["Stable", "-leading", ".leading", "has space"];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, bad[i])
            );
            hook.setTag(address(token), TOKEN, bad[i], 1);
        }

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, ""));
        hook.setTag(address(token), TOKEN, "", 1);
        vm.stopPrank();
    }

    function test_TagName_LengthCap() public {
        _publish(TOKEN, DIR_A);
        string memory ok = _stringOfLength(64);
        string memory tooLong = _stringOfLength(65);

        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, ok, 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.InvalidTagName.selector, tooLong));
        hook.setTag(address(token), TOKEN, tooLong, 1);
        vm.stopPrank();
    }

    function test_GetTagsRange_Bounds() public {
        _publish(TOKEN, DIR_A);
        vm.startPrank(alice);
        hook.setTag(address(token), TOKEN, "a", 1);
        hook.setTag(address(token), TOKEN, "b", 1);
        vm.stopPrank();

        assertEq(hook.getTagsRange(address(token), TOKEN, 0, 2).length, 2);
        assertEq(hook.getTagsRange(address(token), TOKEN, 1, 1).length, 0);

        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.RangeOutOfBounds.selector, 0, 3, 2)
        );
        hook.getTagsRange(address(token), TOKEN, 0, 3);

        vm.expectRevert(abi.encodeWithSelector(IProjectHook.IndexOutOfRange.selector, 2, 2));
        hook.getTagAt(address(token), TOKEN, 2);
    }

    /// @dev A tag pinned to version N keeps resolving to N's CID after the head moves on. That is the
    ///      point of tags: an NFT contract reading `tag/stable/render.js` is not dragged forward by an
    ///      unrelated publish.
    function test_Tag_PinsHistoricalCidAcrossPublishes() public {
        _publish(TOKEN, DIR_A);
        vm.prank(alice);
        hook.setTag(address(token), TOKEN, "stable", 1);

        _publish(TOKEN, DIR_B);

        (uint256 version, bytes32 cid) = hook.getTag(address(token), TOKEN, "stable");
        assertEq(version, 1);
        assertEq(cid, DIR_A, "tag must not follow the head");

        (, bytes32 head) = hook.getTag(address(token), TOKEN, "latest");
        assertEq(head, DIR_B);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Any CID present in a store is publishable; any CID absent from both is not. No input
    ///      should reach a different outcome.
    ///
    ///      The expectation is derived from the SAME predicates the hook consults rather than from a
    ///      list of the fixture's constants. An earlier version excluded DIR_A and DIR_B by name and
    ///      forgot FILE_A, which made the test pass until Foundry's fuzz dictionary — which harvests
    ///      values it sees in the contract — happened to produce FILE_A. A hardcoded exclusion list
    ///      is a latent failure waiting for the corpus to find it.
    function testFuzz_PublishSucceedsExactlyWhenCidIsStored(bytes32 cid, bool store) public {
        vm.assume(cid != bytes32(0));

        bool resolvable = dirStore.has(cid) || fileStore.has(cid) || store;
        if (store) dirStore.add(cid);

        if (!resolvable) {
            vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, cid));
        }
        _publish(TOKEN, cid);
    }

    function testFuzz_UnknownKeysNeverRevert(bytes32 key, bytes32 value) public {
        vm.assume(key != KEY_CID && key != KEY_NAME && key != KEY_GATEWAY);
        vm.prank(alice);
        token.configure(TOKEN, key, value);
        assertEq(hook.versionCount(address(token), TOKEN), 0);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _bytesOfLength(uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = "x";
        }
    }

    function _stringOfLength(uint256 n) internal pure returns (string memory) {
        return string(_bytesOfLength(n));
    }
}
