// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectHook} from "../src/ProjectHook.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockRegistry, RevertingRegistry, LongReturnRegistry, NonBoolRegistry} from "./mocks/AbxMocks.sol";

/// @dev The cross-collection index and the global ledger are the only two structures not namespaced
///      by caller, so each admits registered orgs only. These tests drive the hooks directly as
///      arbitrary addresses, which is exactly what a forged caller would do.
contract OrgHeldTest is Test {
    ProjectEnumeration internal e;
    MockRegistry internal registry;

    address internal orgA = address(0xA0A0);
    address internal orgB = address(0xB0B0);
    address internal rogue = address(0xBAD);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        registry = new MockRegistry();
        e = new ProjectEnumeration(address(registry));
        registry.set(orgA, true);
        registry.set(orgB, true);
    }

    function _move(address collection, uint256 id, address from, address to) internal {
        vm.prank(collection);
        e.onTokenTransfer(id, from, to, from, 1);
    }

    function test_firstTokenAddsTheOrgAndTheLastRemovesIt() public {
        _move(orgA, 0, address(0), alice);
        assertEq(e.orgsHeldBy(alice).length, 1);
        _move(orgA, 1, address(0), alice);
        assertEq(e.orgsHeldBy(alice).length, 1, "a second token in the same org adds nothing");
        assertEq(e.balanceOfTracked(orgA, alice), 2);

        _move(orgA, 0, alice, bob);
        assertEq(e.orgsHeldBy(alice).length, 1, "still holds one");
        assertEq(e.orgsHeldBy(bob).length, 1);

        _move(orgA, 1, alice, bob);
        assertEq(e.orgsHeldBy(alice).length, 0, "holding none removes the org");
        assertEq(e.orgsHeldBy(bob).length, 1);
    }

    function test_burnReleasesTheOrg() public {
        _move(orgA, 0, address(0), alice);
        _move(orgA, 0, alice, address(0));
        assertEq(e.orgsHeldBy(alice).length, 0);
    }

    function test_swapAndPopKeepsEveryPositionRight() public {
        address orgC = address(0xC0C0);
        registry.set(orgC, true);
        _move(orgA, 0, address(0), alice);
        _move(orgB, 0, address(0), alice);
        _move(orgC, 0, address(0), alice);

        _move(orgA, 0, alice, bob); // A leaves from the front; C is swapped into its slot
        address[] memory held = e.orgsHeldBy(alice);
        assertEq(held.length, 2);
        assertEq(held[0], orgC);
        assertEq(held[1], orgB);

        _move(orgC, 0, alice, bob); // the moved entry must still be removable
        held = e.orgsHeldBy(alice);
        assertEq(held.length, 1);
        assertEq(held[0], orgB);
        assertEq(e.orgsHeldCount(alice), 1);
    }

    function test_slice() public {
        _move(orgA, 0, address(0), alice);
        _move(orgB, 0, address(0), alice);
        assertEq(e.orgsHeldSlice(alice, 1, 5).length, 1);
        assertEq(e.orgsHeldSlice(alice, 9, 1).length, 0);
        assertEq(e.orgsHeldSlice(alice, 0, type(uint256).max).length, 2);
    }

    function test_aForgedCallerCannotWriteIntoAnyonesOrgList() public {
        _move(rogue, 0, address(0), alice);
        assertEq(e.orgsHeldBy(alice).length, 0, "not registered, so not listed");
        // Its own namespace still works, as it always did.
        assertEq(e.tokensOfOwner(rogue, alice).length, 1);
    }

    function test_theIndexRepairsRatherThanReverting() public {
        // A token that arrived before its collection was registered was never counted. Releasing it
        // must be a no-op, not an underflow.
        address late = address(0x1A7E);
        _move(late, 0, address(0), alice);
        registry.set(late, true);
        _move(late, 0, alice, bob);
        assertEq(e.orgsHeldBy(alice).length, 0);
        assertEq(e.orgsHeldBy(bob).length, 1, "and it is counted from here on");
        _move(late, 0, bob, address(0));
        assertEq(e.orgsHeldBy(bob).length, 0);
    }

    // ─── A registry that misbehaves must never become a veto ─────────────────

    function _assertSurvives(address badRegistry) internal {
        ProjectEnumeration eb = new ProjectEnumeration(badRegistry);
        vm.prank(orgA);
        eb.onTokenTransfer(0, address(0), alice, alice, 1);
        vm.prank(orgA);
        eb.onTokenTransfer(0, alice, bob, alice, 1);
        assertEq(eb.orgsHeldBy(alice).length, 0);
        assertEq(eb.tokensOfOwner(orgA, bob).length, 1, "the per-collection index is unaffected");

        MockStore dirs = new MockStore();
        MockStore files = new MockStore();
        ProjectHook h = new ProjectHook(address(dirs), address(files), badRegistry);
        MockAbxToken t = new MockAbxToken(address(h));
        dirs.add(keccak256("x"));
        t.setOwner(1, alice);
        vm.prank(alice);
        t.configure(1, "abxfs.cid", keccak256("x"));
        assertEq(h.versionCount(address(t), 1), 1, "publishing still works");
        assertEq(h.globalPublishCount(), 0);
    }

    function test_aRevertingRegistryIsNotAVeto() public {
        _assertSurvives(address(new RevertingRegistry()));
    }

    function test_aLongReturnIsNotAVeto() public {
        _assertSurvives(address(new LongReturnRegistry()));
    }

    function test_aNonBoolReturnIsNotAVeto() public {
        _assertSurvives(address(new NonBoolRegistry()));
    }

    function test_aNoCodeRegistryIsNotAVeto() public {
        _assertSurvives(address(0xDEAD));
    }

    function test_noRegistryAtAllIsNotAVeto() public {
        _assertSurvives(address(0));
    }
}
