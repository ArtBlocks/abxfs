// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";

/// @notice The enumeration hook is a VETO on every transfer and every mint. Its revert paths are
///         therefore as load-bearing as its accounting: a panic on a malformed or out-of-order
///         lifecycle would not corrupt an index, it would freeze the collection. So these tests are
///         split in two — the accounting must be right, and nothing must ever revert.
contract ProjectEnumerationTest is Test {
    ProjectEnumeration internal hook;

    address internal constant COLLECTION = address(0xC0113C7104);
    address internal constant OTHER_COLLECTION = address(0xB0B);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B0B);
    address internal constant ZERO = address(0);

    function setUp() public {
        hook = new ProjectEnumeration(address(0));
    }

    // Every call is made AS the collection, which is how ABX invokes it.
    function _fire(address collection, uint256 tokenId, address from, address to) internal {
        vm.prank(collection);
        hook.onTokenTransfer(tokenId, from, to, from == ZERO ? collection : from, 1);
    }

    function _mint(uint256 tokenId, address to) internal {
        _fire(COLLECTION, tokenId, ZERO, to);
    }

    // ── Accounting ────────────────────────────────────────────────────────────

    function test_mint_indexesTheToken() public {
        _mint(0, ALICE);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 1);
        assertEq(hook.tokenOfOwnerByIndex(COLLECTION, ALICE, 0), 0);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ALICE);
    }

    function test_transfer_movesBetweenOwners() public {
        _mint(0, ALICE);
        _fire(COLLECTION, 0, ALICE, BOB);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0);
        assertEq(hook.balanceOfTracked(COLLECTION, BOB), 1);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), BOB);
        assertEq(hook.tokenOfOwnerByIndex(COLLECTION, BOB, 0), 0);
    }

    function test_burn_removesFromBothIndexes() public {
        _mint(0, ALICE);
        _fire(COLLECTION, 0, ALICE, ZERO);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ZERO);
    }

    /// The swap-and-pop case: removing a non-final element must relocate the last one and fix its
    /// index, or that token silently disappears from the owner's list.
    function test_removingMiddleTokenKeepsTheRestAddressable() public {
        _mint(0, ALICE);
        _mint(1, ALICE);
        _mint(2, ALICE);

        _fire(COLLECTION, 1, ALICE, BOB);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 2);
        uint256[] memory owned = hook.tokensOfOwner(COLLECTION, ALICE);
        bool has0;
        bool has2;
        for (uint256 i; i < owned.length; ++i) {
            if (owned[i] == 0) has0 = true;
            if (owned[i] == 2) has2 = true;
        }
        assertTrue(has0 && has2, "surviving tokens must still be listed");

        // And the moved token's own index must still resolve.
        assertEq(hook.tokenOfOwnerByIndex(COLLECTION, BOB, 0), 1);
    }

    /// @dev ERC-721 delivers self-transfers — `SeriesCode._notifyTransferHook` has no `from == to`
    ///      guard, only the 1155 path filters them. Handling it wrong is how a token ends up listed
    ///      twice or not at all, so this is pinned explicitly rather than assumed unreachable.
    function test_selfTransferIsANoOp() public {
        _mint(0, ALICE);
        _fire(COLLECTION, 0, ALICE, ALICE);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 1, "no duplicate, no loss");
        assertEq(hook.tokensOfOwner(COLLECTION, ALICE).length, 1);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ALICE);
    }

    /// @dev The property that lets one deployment serve every collection, and the reason this hook
    ///      needs no access control: a forged call writes only under its own `msg.sender`.
    function test_stateIsNamespacedByCallingCollection() public {
        _mint(0, ALICE);
        _fire(OTHER_COLLECTION, 0, ZERO, ALICE);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 1);
        assertEq(hook.balanceOfTracked(OTHER_COLLECTION, ALICE), 1);

        _fire(OTHER_COLLECTION, 0, ALICE, ZERO); // burn on the impostor only

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 1, "real collection untouched");
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ALICE);
        assertEq(hook.balanceOfTracked(OTHER_COLLECTION, ALICE), 0);
        assertEq(hook.trackedOwnerOf(OTHER_COLLECTION, 0), ZERO);
    }

    // ── Never revert ──────────────────────────────────────────────────────────
    //
    // ABX calls this from `_afterTokenTransfer` with no try/catch. Anything that reverts here fails
    // the transfer, and a mint is a transfer from address(0), so it fails minting too.

    function test_transferOfUntrackedTokenDoesNotRevert() public {
        // Armed after the collection already had moves: the hook has never seen this token.
        _fire(COLLECTION, 42, ALICE, BOB);
        assertEq(hook.balanceOfTracked(COLLECTION, BOB), 1, "adopts it rather than failing");
        assertEq(hook.trackedOwnerOf(COLLECTION, 42), BOB);
    }

    function test_burnOfUntrackedTokenDoesNotRevert() public {
        _fire(COLLECTION, 42, ALICE, ZERO);
        assertEq(hook.trackedOwnerOf(COLLECTION, 42), ZERO);
        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0);
    }

    /// A `from` that disagrees with what the index recorded must not strand the collection. The
    /// recorded owner wins for removal and the index converges.
    function test_wrongFromRepairsInsteadOfReverting() public {
        address carol = address(0xCAFE);
        _mint(0, ALICE);

        // Claims BOB was the previous owner; the index recorded ALICE. `from` must not be trusted
        // for removal, or the token would stay listed under ALICE forever while also appearing
        // under CAROL — present in two owners' lists at once.
        _fire(COLLECTION, 0, BOB, carol);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0, "removed from where it actually was");
        assertEq(hook.balanceOfTracked(COLLECTION, BOB), 0, "never held it, gains nothing");
        assertEq(hook.balanceOfTracked(COLLECTION, carol), 1);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), carol);
    }

    function test_doubleMintDoesNotDuplicate() public {
        _mint(0, ALICE);
        _mint(0, ALICE);

        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 1);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ALICE);

        // A second mint of a recorded token to someone else moves it: never listed under two owners.
        _mint(0, BOB);
        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0);
        assertEq(hook.balanceOfTracked(COLLECTION, BOB), 1);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), BOB);
    }

    function test_mintToZeroDoesNotRevert() public {
        _fire(COLLECTION, 0, ZERO, ZERO);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), ZERO);
    }

    function test_burnThenRemintIsClean() public {
        _mint(0, ALICE);
        _fire(COLLECTION, 0, ALICE, ZERO);
        _mint(0, BOB);

        assertEq(hook.balanceOfTracked(COLLECTION, BOB), 1);
        assertEq(hook.balanceOfTracked(COLLECTION, ALICE), 0);
        assertEq(hook.trackedOwnerOf(COLLECTION, 0), BOB);
    }

    // ── Paging ────────────────────────────────────────────────────────────────

    function test_sliceClampsPastTheEndInsteadOfReverting() public {
        _mint(0, ALICE);
        _mint(1, ALICE);

        assertEq(hook.tokensOfOwnerSlice(COLLECTION, ALICE, 0, 5).length, 2, "count clamps");
        assertEq(hook.tokensOfOwnerSlice(COLLECTION, ALICE, 2, 1).length, 0, "start past end");
        assertEq(hook.tokensOfOwnerSlice(COLLECTION, ALICE, 1, 1).length, 1);
        assertEq(hook.tokensOfOwnerSlice(COLLECTION, ALICE, 0, type(uint256).max).length, 2);
    }

    // ── Invariant under random lifecycles ─────────────────────────────────────

    /// @notice The accounting must survive an arbitrary sequence of moves without reverting and
    ///         without the two indexes disagreeing. Ownership is modeled independently here so the
    ///         test does not simply restate the implementation.
    function testFuzz_indexesStayConsistent(uint8[24] calldata script) public {
        address[3] memory actors = [ALICE, BOB, address(0xCAFE)];
        // Mirror of truth: tokenId => owner, address(0) meaning "does not exist".
        address[8] memory truth;

        for (uint256 step; step < script.length; ++step) {
            uint256 tokenId = script[step] % 8;
            address from = truth[tokenId];
            address to = actors[(script[step] / 8) % 3];

            // Burn every so often so the supply index is exercised in both directions.
            if (script[step] % 7 == 0) to = ZERO;
            if (from == ZERO && to == ZERO) continue;

            _fire(COLLECTION, tokenId, from, to);
            truth[tokenId] = to;
        }

        uint256 expectedSupply;
        for (uint256 id; id < 8; ++id) {
            address owner = truth[id];
            assertEq(hook.trackedOwnerOf(COLLECTION, id), owner, "owner disagrees with truth");
            if (owner != ZERO) expectedSupply++;
        }

        // Per-owner lists must partition the tracked set exactly.
        uint256 counted;
        for (uint256 a; a < actors.length; ++a) {
            uint256[] memory owned = hook.tokensOfOwner(COLLECTION, actors[a]);
            counted += owned.length;
            for (uint256 i; i < owned.length; ++i) {
                assertEq(truth[owned[i]], actors[a], "token listed under the wrong owner");
            }
        }
        assertEq(counted, expectedSupply, "owner lists must cover every tracked token");
    }
}
