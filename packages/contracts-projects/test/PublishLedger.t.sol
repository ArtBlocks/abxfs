// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";

/// @notice The collection-wide publish ledger.
///
/// @dev The per-token version history already answers "what did project N publish?". This answers
///      "what did the whole collection publish, most recently first?" — the feed query. Answering it
///      from logs means an `eth_getLogs` walk back to the deploy block, which measured 273 seconds and
///      fails outright once a provider has pruned that far back, so the ordering lives in state.
///
///      The ledger's defining property is that it is append-only. Index N must mean the same record
///      forever, or a client cannot page from a stored cursor — it would silently skip or repeat
///      entries as the log shifted underneath it. Several tests below exist only to pin that.
contract PublishLedgerTest is Test {
    ProjectHook internal hook;
    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxToken internal token;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant KEY_CID = "abxfs.cid";

    bytes32 internal constant DIR_A = keccak256("dir-a");
    bytes32 internal constant DIR_B = keccak256("dir-b");
    bytes32 internal constant DIR_C = keccak256("dir-c");
    bytes32 internal constant FILE_A = keccak256("file-a");

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        token = new MockAbxToken(address(hook));

        dirStore.add(DIR_A);
        dirStore.add(DIR_B);
        dirStore.add(DIR_C);
        fileStore.add(FILE_A);

        token.setOwner(1, alice);
        token.setOwner(2, bob);
        token.setOwner(3, alice);
    }

    function _publish(uint256 tokenId, address owner, bytes32 cid) internal {
        vm.prank(owner);
        token.configure(tokenId, KEY_CID, cid);
    }

    // ─── Appending ────────────────────────────────────────────────────────────

    function test_everyPublishAppendsOneRecord() public {
        assertEq(hook.publishCount(address(token)), 0);

        _publish(1, alice, DIR_A);
        assertEq(hook.publishCount(address(token)), 1);

        _publish(2, bob, DIR_B);
        assertEq(hook.publishCount(address(token)), 2);

        // A republish of an existing project appends too — the ledger is history, not a set.
        _publish(1, alice, DIR_B);
        assertEq(hook.publishCount(address(token)), 3);
    }

    function test_recordCarriesTheFullPublishFacts() public {
        vm.warp(1_700_000_000);
        _publish(1, alice, DIR_A);

        IProjectHook.PublishRecord memory r = hook.publishAt(address(token), 0);
        assertEq(r.tokenId, 1);
        assertEq(r.cid, DIR_A);
        assertEq(r.publisher, alice);
        assertEq(r.publishedAt, uint40(1_700_000_000));
        assertEq(r.version, 1, "1-based, matching versionAt");
    }

    /// The ledger's version number must agree with the per-token history, or a client resolving a
    /// feed entry to a specific version would land on the wrong CID.
    function test_versionNumberTracksThePerTokenHistory() public {
        _publish(1, alice, DIR_A);
        _publish(1, alice, DIR_B);
        _publish(1, alice, DIR_C);

        assertEq(hook.publishAt(address(token), 0).version, 1);
        assertEq(hook.publishAt(address(token), 1).version, 2);
        assertEq(hook.publishAt(address(token), 2).version, 3);
        assertEq(hook.versionCount(address(token), 1), 3);

        // And each ledger entry's CID must equal what that version resolves to.
        for (uint256 i; i < 3; ++i) {
            IProjectHook.PublishRecord memory r = hook.publishAt(address(token), i);
            assertEq(hook.versionAt(address(token), r.tokenId, r.version).cid, r.cid);
        }
    }

    function test_ledgerIsNamespacedPerCollection() public {
        MockAbxToken other = new MockAbxToken(address(hook));
        other.setOwner(1, alice);

        _publish(1, alice, DIR_A);
        vm.prank(alice);
        other.configure(1, KEY_CID, DIR_B);

        assertEq(hook.publishCount(address(token)), 1);
        assertEq(hook.publishCount(address(other)), 1);
        assertEq(hook.publishAt(address(token), 0).cid, DIR_A);
        assertEq(hook.publishAt(address(other), 0).cid, DIR_B);
    }

    // ─── Append-only ──────────────────────────────────────────────────────────

    /// @dev The property a paging cursor depends on. If a later publish could renumber earlier
    ///      entries, a client resuming from "I have seen up to index 12" would skip or repeat rows.
    function test_existingIndexesNeverChange() public {
        _publish(1, alice, DIR_A);
        _publish(2, bob, DIR_B);

        IProjectHook.PublishRecord memory before0 = hook.publishAt(address(token), 0);
        IProjectHook.PublishRecord memory before1 = hook.publishAt(address(token), 1);

        _publish(1, alice, DIR_C);
        _publish(3, alice, FILE_A);

        IProjectHook.PublishRecord memory after0 = hook.publishAt(address(token), 0);
        IProjectHook.PublishRecord memory after1 = hook.publishAt(address(token), 1);

        assertEq(after0.cid, before0.cid);
        assertEq(after0.tokenId, before0.tokenId);
        assertEq(after0.version, before0.version);
        assertEq(after1.cid, before1.cid);
        assertEq(after1.tokenId, before1.tokenId);
    }

    /// A rejected publish must leave no trace. The hook runs before the value persists, so a veto
    /// that had already appended would record a publish that never happened.
    function test_aVetoedPublishAppendsNothing() public {
        _publish(1, alice, DIR_A);
        assertEq(hook.publishCount(address(token)), 1);

        // Same root twice is refused.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, DIR_A));
        token.configure(1, KEY_CID, DIR_A);
        assertEq(hook.publishCount(address(token)), 1, "vetoed publish must not appear");

        // Kind lock violation is refused.
        vm.prank(alice);
        vm.expectRevert();
        token.configure(1, KEY_CID, FILE_A);
        assertEq(hook.publishCount(address(token)), 1);

        // A CID in neither store is refused.
        vm.prank(alice);
        vm.expectRevert();
        token.configure(1, KEY_CID, keccak256("nowhere"));
        assertEq(hook.publishCount(address(token)), 1);
    }

    // ─── Reading the feed ─────────────────────────────────────────────────────

    function test_recentPublishesReturnsNewestFirst() public {
        _publish(1, alice, DIR_A); // index 0
        _publish(2, bob, DIR_B); // index 1
        _publish(3, alice, FILE_A); // index 2

        IProjectHook.PublishRecord[] memory recent = hook.recentPublishes(address(token), 2);
        assertEq(recent.length, 2);
        assertEq(recent[0].tokenId, 3, "newest first");
        assertEq(recent[1].tokenId, 2);
    }

    function test_recentPublishesClampsToWhatExists() public {
        _publish(1, alice, DIR_A);

        assertEq(hook.recentPublishes(address(token), 50).length, 1);
        assertEq(hook.recentPublishes(address(token), 0).length, 0);
        // An empty ledger must return empty, not revert — a fresh collection hits this on load.
        assertEq(hook.recentPublishes(address(0xDEAD), 10).length, 0);
    }

    /// @dev Paging must cover the ledger exactly once: no gaps, no repeats. A feed that repeats an
    ///      entry looks like a double publish, and one that skips looks like a lost version.
    function test_pagingBackwardCoversEveryRecordExactlyOnce() public {
        for (uint256 i; i < 7; ++i) {
            bytes32 cid = keccak256(abi.encode("root", i));
            dirStore.add(cid);
            _publish(1, alice, cid);
        }
        assertEq(hook.publishCount(address(token)), 7);

        uint256 cursor = hook.publishCount(address(token));
        uint256 seen;
        bool[7] memory hit;

        while (cursor > 0) {
            IProjectHook.PublishRecord[] memory page =
                hook.recentPublishesBefore(address(token), cursor, 3);
            if (page.length == 0) break;
            for (uint256 i; i < page.length; ++i) {
                uint256 idx = page[i].version - 1; // version is 1-based and unique per token here
                assertFalse(hit[idx], "record returned twice");
                hit[idx] = true;
                seen++;
            }
            cursor -= page.length;
        }

        assertEq(seen, 7, "every record seen");
        for (uint256 i; i < 7; ++i) assertTrue(hit[i], "gap in paging");
    }

    function test_publishRangeReadsOldestFirstAndClamps() public {
        _publish(1, alice, DIR_A);
        _publish(2, bob, DIR_B);
        _publish(3, alice, FILE_A);

        IProjectHook.PublishRecord[] memory asc = hook.publishRange(address(token), 0, 3);
        assertEq(asc.length, 3);
        assertEq(asc[0].tokenId, 1, "oldest first");
        assertEq(asc[2].tokenId, 3);

        assertEq(hook.publishRange(address(token), 1, 99).length, 2, "count clamps");
        assertEq(hook.publishRange(address(token), 9, 1).length, 0, "start past end");
        // A "give me everything" sentinel must not overflow into an empty window.
        assertEq(hook.publishRange(address(token), 0, type(uint256).max).length, 3);
    }

    /// The feed's real consumer wants distinct projects, which it gets by reading back and deduping.
    /// Cheap here because it is one `eth_call` over state — the same dedup over logs was the query
    /// that took 273 seconds.
    function test_feedCanDedupeToDistinctProjects() public {
        bytes32 dirD = keccak256("dir-d");
        dirStore.add(dirD);

        _publish(1, alice, DIR_A);
        _publish(1, alice, DIR_B); // project 1 republishes
        _publish(2, bob, DIR_C);
        // Project 1 again. Note the CID must stay directory-kind: the first publish locks the kind,
        // so a file CID here would be vetoed rather than appended.
        _publish(1, alice, dirD);

        IProjectHook.PublishRecord[] memory recent = hook.recentPublishes(address(token), 10);
        uint256 distinct;
        uint256 seenMask;
        for (uint256 i; i < recent.length; ++i) {
            uint256 bit = 1 << recent[i].tokenId;
            if (seenMask & bit == 0) {
                seenMask |= bit;
                distinct++;
            }
        }
        assertEq(distinct, 2);
        assertEq(recent[0].tokenId, 1, "most recent publish is project 1");
    }
}
