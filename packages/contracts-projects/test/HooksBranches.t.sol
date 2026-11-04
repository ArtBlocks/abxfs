// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm, stdError} from "forge-std/Test.sol";

import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockRegistry} from "./mocks/AbxMocks.sol";
import {RawStub, GasBurner} from "./mocks/Hostile.sol";

/// @dev Both hooks are vetoes (ABX calls them with no try/catch), and both consult the factory's `isOrg` through a raw
///      `staticcall` with a hand-decoded answer. Every shape the registry can answer with is driven here against both
///      hooks, each asserting the exact outcome: anything other than one canonical `true` word is "not an org", the
///      transfer or publish itself always succeeds, and the cross-org structures change only for a real org.
contract HooksRegistryShapesTest is Test {
    bytes4 internal constant IS_ORG = IOrgFactory.isOrg.selector;
    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant DIR_A = keccak256("dir-a");

    address internal constant COLLECTION = address(0xC011EC7);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    RawStub internal registry;

    function setUp() public {
        registry = new RawStub();
    }

    /// @dev Whether the answer makes the hooks list COLLECTION.
    function _isListed(bytes memory answer) internal pure returns (bool) {
        return answer.length == 32 && uint256(bytes32(answer)) == 1;
    }

    /// @dev One mint, one transfer, one burn against an enumeration hook whose registry gives `answer`.
    function _enumerationSurvives(address factory, bool expectListed) internal {
        ProjectEnumeration e = new ProjectEnumeration(factory);
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, address(0), alice, alice, 1);
        assertEq(e.tokensOfOwner(COLLECTION, alice).length, 1, "the per-collection index never depends on the registry");
        assertEq(e.orgsHeldBy(alice).length, expectListed ? 1 : 0, "org-held after the mint");
        if (expectListed) assertEq(e.orgsHeldBy(alice)[0], COLLECTION);

        vm.prank(COLLECTION);
        e.onTokenTransfer(0, alice, bob, alice, 1);
        assertEq(e.balanceOfTracked(COLLECTION, bob), 1);
        assertEq(e.orgsHeldBy(alice).length, 0, "the sender no longer holds anything");
        assertEq(e.orgsHeldBy(bob).length, expectListed ? 1 : 0, "org-held after the transfer");

        vm.prank(COLLECTION);
        e.onTokenTransfer(0, bob, address(0), bob, 1);
        assertEq(e.orgsHeldBy(bob).length, 0, "after the burn");
        assertEq(e.trackedOwnerOf(COLLECTION, 0), address(0));
    }

    /// @dev One publish against a configure hook whose registry gives `answer`.
    function _hookSurvives(address factory, bool expectListed) internal {
        MockStore dirs = new MockStore();
        MockStore files = new MockStore();
        dirs.add(DIR_A);
        ProjectHook h = new ProjectHook(address(dirs), address(files), factory);
        MockAbxToken t = new MockAbxToken(address(h));
        t.setOwner(1, alice);
        vm.prank(alice);
        t.configure(1, KEY_CID, DIR_A);
        assertEq(h.versionCount(address(t), 1), 1, "the publish always lands");
        assertEq(h.publishCount(address(t)), 1, "and the per-org ledger too");
        assertEq(h.globalPublishCount(), expectListed ? 1 : 0, "the global ledger only for a real org");
        if (expectListed) {
            (address org, uint256 idx) = h.globalPublishAt(0);
            assertEq(org, address(t));
            assertEq(idx, 0);
        }
    }

    function _check(bytes memory answer) internal {
        registry.ret(IS_ORG, answer);
        _enumerationSurvives(address(registry), _isListed(answer));
        // The hook's collection must be the one the registry is asked about, so the registry here says yes for any
        // address: the same stub serves both hooks.
        _hookSurvives(address(registry), _isListed(answer));
    }

    function test_oneCanonicalTrueWordIsAnOrg() public {
        _check(abi.encode(uint256(1)));
        _check(abi.encode(true));
    }

    function test_everyOtherWordIsNotAnOrg() public {
        _check(abi.encode(uint256(0)));
        _check(abi.encode(uint256(2)));
        _check(abi.encode(type(uint256).max));
        _check(abi.encode(uint256(1) << 255));
        _check(abi.encode(uint256(0x0100)));
        _check(abi.encode(uint256(1) << 160)); // would be "1" if truncated to an address
    }

    function test_theAnswerMustBeExactlyOneWordLong() public {
        _check(""); // empty success: what a no-code registry looks like
        _check(hex"01"); // one byte
        _check(new bytes(31)); // one short of a word
        _check(abi.encodePacked(new bytes(31), hex"01")); // 32 bytes, value 1: listed, as the control
        _check(abi.encodePacked(abi.encode(uint256(1)), hex"00")); // 33 bytes
        _check(abi.encode(uint256(1), uint256(1))); // 64 bytes, both ones
        _check(abi.encode(uint256(1), uint256(0)));
    }

    function test_aRevertingRegistryIsNotAnOrg() public {
        registry.boom(IS_ORG);
        _enumerationSurvives(address(registry), false);
        _hookSurvives(address(registry), false);
    }

    function test_noCodeAndZeroRegistriesAreNotAnOrg() public {
        _enumerationSurvives(address(0xDEAD), false);
        _hookSurvives(address(0xDEAD), false);
        _enumerationSurvives(address(0), false);
        _hookSurvives(address(0), false);
        // An EOA with a nonzero balance, which also has no code.
        vm.deal(address(0xFEED), 1 ether);
        _enumerationSurvives(address(0xFEED), false);
        _hookSurvives(address(0xFEED), false);
    }

    /// @dev The registry is consulted for exactly the collection that called, and by `isOrg(address)`.
    function test_theRegistryIsAskedAboutTheCallingCollection() public {
        registry.ret(IS_ORG, abi.encode(uint256(1)));
        ProjectEnumeration e = new ProjectEnumeration(address(registry));
        vm.expectCall(address(registry), abi.encodeWithSelector(IS_ORG, COLLECTION), 1);
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, address(0), alice, alice, 1);

        MockStore dirs = new MockStore();
        dirs.add(DIR_A);
        ProjectHook h = new ProjectHook(address(dirs), address(new MockStore()), address(registry));
        MockAbxToken t = new MockAbxToken(address(h));
        t.setOwner(1, alice);
        vm.expectCall(address(registry), abi.encodeWithSelector(IS_ORG, address(t)), 1);
        vm.prank(alice);
        t.configure(1, KEY_CID, DIR_A);
    }

    /// @dev "Runs only when the recipient holds no other counted token in the collection, so a transfer to an existing
    ///      holder pays nothing for it": the second token costs no registry call, and the count (not a re-check) is what
    ///      keeps the org listed.
    function test_theRegistryIsNotAskedAgainWhileTheOwnerStillHoldsATokenThere() public {
        registry.ret(IS_ORG, abi.encode(uint256(1)));
        ProjectEnumeration e = new ProjectEnumeration(address(registry));
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, address(0), alice, alice, 1);

        // The registry now misbehaves; a second token for the same holder must not notice.
        registry.boom(IS_ORG);
        vm.expectCall(address(registry), abi.encodeWithSelector(IS_ORG, COLLECTION), 0);
        vm.prank(COLLECTION);
        e.onTokenTransfer(1, address(0), alice, alice, 1);
        assertEq(e.orgsHeldBy(alice).length, 1);

        // Releasing one keeps the org listed, releasing both removes it.
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, alice, address(0), alice, 1);
        assertEq(e.orgsHeldBy(alice).length, 1, "still holds token 1");
        vm.prank(COLLECTION);
        e.onTokenTransfer(1, alice, address(0), alice, 1);
        assertEq(e.orgsHeldBy(alice).length, 0, "holds nothing in it any more");
    }

    /// @dev A registry that burns all the gas it is given reads as "not an org", and the hook still finishes: the registry
    ///      is asked with all the gas the hook has, but a call keeps back 1/64 of it, and what the hook has left to do
    ///      after the check is nothing (the enumeration hook) or one event (the configure hook). The per-collection index
    ///      and the per-org ledger are unaffected, the cross-org structures are skipped, and the transaction does not fail.
    ///      This holds for any budget where 1/64 of what remains at the check covers the rest, which is a small number.
    function test_aGasBurningRegistryReadsAsNotAnOrgAndTheHooksStillFinish() public {
        GasBurner burner = new GasBurner();

        ProjectEnumeration e = new ProjectEnumeration(address(burner));
        vm.prank(COLLECTION);
        e.onTokenTransfer{gas: 3_000_000}(0, address(0), alice, alice, 1);
        assertEq(e.tokensOfOwner(COLLECTION, alice).length, 1);
        assertEq(e.balanceOfTracked(COLLECTION, alice), 1);
        assertEq(e.orgsHeldBy(alice).length, 0, "not an org: not listed");
        vm.prank(COLLECTION);
        e.onTokenTransfer{gas: 3_000_000}(0, alice, bob, alice, 1);
        assertEq(e.balanceOfTracked(COLLECTION, bob), 1);

        MockStore dirs = new MockStore();
        dirs.add(DIR_A);
        ProjectHook h = new ProjectHook(address(dirs), address(new MockStore()), address(burner));
        MockAbxToken t = new MockAbxToken(address(h));
        t.setOwner(1, alice);
        vm.prank(alice);
        t.configure{gas: 3_000_000}(1, KEY_CID, DIR_A);
        assertEq(h.versionCount(address(t), 1), 1, "the publish lands");
        assertEq(h.publishCount(address(t)), 1, "in its own org's ledger");
        assertEq(h.globalPublishCount(), 0, "and not in the shared feed");
    }

    /// @dev A collection that was not an org when a token arrived is never counted, even if it is registered later:
    ///      releasing that token must not underflow the count.
    function test_aTokenThatWasNeverCountedReleasesToNothing() public {
        registry.ret(IS_ORG, abi.encode(uint256(0)));
        ProjectEnumeration e = new ProjectEnumeration(address(registry));
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, address(0), alice, alice, 1);
        registry.ret(IS_ORG, abi.encode(uint256(1)));
        vm.prank(COLLECTION);
        e.onTokenTransfer(0, alice, address(0), alice, 1); // releasing: count is 0, so nothing to undo
        assertEq(e.orgsHeldBy(alice).length, 0);
        assertEq(e.orgsHeldCount(alice), 0);
        assertEq(e.trackedOwnerOf(COLLECTION, 0), address(0));
    }
}

/// @dev `ProjectEnumeration` repairs a disagreement between its books instead of asserting against it, because a revert
///      there fails every mint and transfer of the collection and `lockParamHooks` makes that permanent. Through the
///      hook's own entry point those disagreements cannot arise (each transaction leaves the books consistent), so
///      the repair branches are driven by corrupting storage directly, which is the only way to reach them. Each test
///      first reads the slot it is about to corrupt and checks it holds what the layout says it should, so a layout
///      change fails loudly instead of corrupting nothing.
///
///      The rule each repair follows: a token leaves the owner the index RECORDS, so that owner's count in the org
///      always drops; a list entry is popped only from the position the record names, and only if the list really
///      holds that token (or that org) there. A position that is zero, past the end, or names something else cannot be
///      corrected without a scan, so the stale entry is left rather than the wrong one removed.
contract EnumerationRepairTest is Test {
    ProjectEnumeration internal e;
    MockRegistry internal registry;

    address internal constant ORG = address(0x0C0C);
    address internal constant ORG2 = address(0x0C0D);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // Storage layout (`forge inspect ProjectEnumeration storage-layout`).
    uint256 internal constant SLOT_ORG_HOLDING = 1; // owner => org => (uint128 count, uint128 indexPlusOne)
    uint256 internal constant SLOT_OWNED = 2; // collection => owner => uint256[]
    uint256 internal constant SLOT_HOLDING = 3; // collection => tokenId => (address owner, uint96 indexPlusOne)

    function setUp() public {
        registry = new MockRegistry();
        registry.set(ORG, true);
        registry.set(ORG2, true);
        e = new ProjectEnumeration(address(registry));
    }

    function _move(uint256 id, address from, address to) internal {
        _moveIn(ORG, id, from, to);
    }

    function _moveIn(address col, uint256 id, address from, address to) internal {
        vm.prank(col);
        e.onTokenTransfer(id, from, to, from, 1);
    }

    function _slotHolding(uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, keccak256(abi.encode(ORG, SLOT_HOLDING))));
    }

    function _holding(address owner, uint256 indexPlusOne) internal pure returns (uint256) {
        return uint256(uint160(owner)) | (indexPlusOne << 160);
    }

    function _slotOwnedLength(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, keccak256(abi.encode(ORG, SLOT_OWNED))));
    }

    function _slotOrgHolding(address owner, address org) internal pure returns (bytes32) {
        return keccak256(abi.encode(org, keccak256(abi.encode(owner, SLOT_ORG_HOLDING))));
    }

    function _orgHolding(uint256 count, uint256 indexPlusOne) internal pure returns (uint256) {
        return count | (indexPlusOne << 128);
    }

    function _corrupt(bytes32 slot, uint256 expectedBefore, uint256 value) internal {
        assertEq(uint256(vm.load(address(e), slot)), expectedBefore, "the slot holds what the layout says");
        vm.store(address(e), slot, bytes32(value));
    }

    function _lists(address owner, uint256 id) internal view returns (bool) {
        uint256[] memory l = e.tokensOfOwner(ORG, owner);
        for (uint256 i; i < l.length; ++i) {
            if (l[i] == id) return true;
        }
        return false;
    }

    /// @dev The layout the corruptions below rely on: one slot per token, one per (owner, org).
    function test_theLayoutIsOneSlotPerTokenAndOnePerOwnerAndOrg() public {
        _move(0, address(0), alice);
        _move(1, address(0), alice);
        assertEq(uint256(vm.load(address(e), _slotHolding(0))), _holding(alice, 1));
        assertEq(uint256(vm.load(address(e), _slotHolding(1))), _holding(alice, 2));
        assertEq(uint256(vm.load(address(e), _slotOwnedLength(alice))), 2);
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), _orgHolding(2, 1));
        _move(0, alice, bob);
        assertEq(uint256(vm.load(address(e), _slotHolding(0))), _holding(bob, 1), "overwritten by a transfer");
        assertEq(uint256(vm.load(address(e), _slotHolding(1))), _holding(alice, 1), "the moved token's new position");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), _orgHolding(1, 1));
        _move(0, bob, address(0));
        assertEq(uint256(vm.load(address(e), _slotHolding(0))), 0, "cleared by a burn");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(bob, ORG))), 0, "and the count with its position");
    }

    /// @dev A recorded owner with no position: nothing is popped (there is no position to pop), the token follows the
    ///      transfer, and the recorded owner's count still drops, so a holder whose list kept a stale entry is not kept
    ///      in the org list once they hold nothing there.
    function test_aRecordedOwnerWithNoPositionLeavesAStaleEntryButTheCountDrops() public {
        _move(0, address(0), alice);
        _move(1, address(0), alice);
        _corrupt(_slotHolding(0), _holding(alice, 1), _holding(alice, 0));

        _move(0, alice, bob);

        assertEq(e.trackedOwnerOf(ORG, 0), bob, "the token follows the transfer");
        assertEq(e.tokensOfOwner(ORG, bob).length, 1);
        assertEq(e.tokenOfOwnerByIndex(ORG, bob, 0), 0);
        assertEq(e.balanceOfTracked(ORG, alice), 2, "the stale entry is not touched: it cannot be located");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), _orgHolding(1, 1), "but alice's count drops");

        // The other token, whose books are intact, is still removable, and then alice holds nothing in the org.
        _move(1, alice, bob);
        assertEq(e.trackedOwnerOf(ORG, 1), bob);
        assertEq(e.balanceOfTracked(ORG, bob), 2);
        assertEq(e.balanceOfTracked(ORG, alice), 1, "only the stale entry is left behind");
        assertEq(e.orgsHeldBy(alice).length, 0, "alice holds nothing in the org, whatever her stale list says");
        assertEq(e.orgsHeldBy(bob).length, 1);
    }

    /// @dev The same with a burn: the record is cleared and the transfer does not revert.
    function test_aRecordedOwnerWithNoPositionCanStillBeBurned() public {
        _move(0, address(0), alice);
        _corrupt(_slotHolding(0), _holding(alice, 1), _holding(alice, 0));
        _move(0, alice, address(0));
        assertEq(e.trackedOwnerOf(ORG, 0), address(0));
        assertEq(uint256(vm.load(address(e), _slotHolding(0))), 0, "no garbage left for a later mint to trip over");
        assertEq(e.orgsHeldBy(alice).length, 0);
    }

    /// @dev A position into an owner whose list is empty.
    function test_aPositionIntoAnEmptyListIsNotIndexed() public {
        _move(0, address(0), alice);
        _corrupt(_slotOwnedLength(alice), 1, 0);

        _move(0, alice, bob);

        assertEq(e.trackedOwnerOf(ORG, 0), bob);
        assertEq(e.tokensOfOwner(ORG, bob).length, 1);
        assertEq(e.balanceOfTracked(ORG, alice), 0, "alice's list is as corrupted: empty");
        assertEq(e.orgsHeldBy(alice).length, 0, "and her count dropped with the token");
        // And it is a whole, working token again: it moves on from bob normally.
        _move(0, bob, alice);
        assertEq(e.trackedOwnerOf(ORG, 0), alice);
        assertEq(e.balanceOfTracked(ORG, bob), 0);
        assertEq(e.balanceOfTracked(ORG, alice), 1);
    }

    /// @dev A position past the end of a non-empty list.
    function test_aPositionPastTheEndOfTheListIsNotIndexed() public {
        _move(0, address(0), alice);
        _move(1, address(0), alice);
        _corrupt(_slotHolding(1), _holding(alice, 2), _holding(alice, 9));

        _move(1, alice, bob); // would be `list[8]` of a two-entry list

        assertEq(e.trackedOwnerOf(ORG, 1), bob);
        assertEq(e.tokensOfOwner(ORG, bob).length, 1);
        assertEq(e.balanceOfTracked(ORG, alice), 2, "the entry that could not be located is left alone");
        assertEq(uint256(vm.load(address(e), _slotHolding(1))), _holding(bob, 1), "bob's list position");
    }

    /// @dev A position that names ANOTHER token in the list: popping it would remove the wrong token from alice's list
    ///      and leave a third token's record pointing at a stale position. Nothing is popped.
    function test_aPositionThatNamesAnotherTokenIsNotPopped() public {
        _move(0, address(0), alice);
        _move(1, address(0), alice);
        _move(2, address(0), alice);
        _corrupt(_slotHolding(2), _holding(alice, 3), _holding(alice, 1)); // token 0's position

        _move(2, alice, bob);

        assertEq(e.trackedOwnerOf(ORG, 2), bob);
        assertTrue(_lists(alice, 0), "token 0 is still where its record says");
        assertEq(e.tokenOfOwnerByIndex(ORG, alice, 0), 0);
        assertEq(uint256(vm.load(address(e), _slotHolding(0))), _holding(alice, 1), "and its record is untouched");
        assertTrue(_lists(alice, 1));
        assertEq(e.balanceOfTracked(ORG, alice), 3, "the stale entry for token 2 stays");

        // Tokens 0 and 1 still move normally.
        _move(0, alice, bob);
        _move(1, alice, bob);
        assertFalse(_lists(alice, 0));
        assertFalse(_lists(alice, 1));
        assertEq(e.balanceOfTracked(ORG, bob), 3);
    }

    /// @dev The boundary of the position check: the last position is valid, one past it is not.
    function test_aPositionAtTheEndOfTheListIsValid() public {
        _move(0, address(0), alice);
        _move(1, address(0), alice);
        _move(1, alice, bob);
        assertEq(e.balanceOfTracked(ORG, alice), 1, "position 2 of 2 was removed normally");
        assertEq(e.tokenOfOwnerByIndex(ORG, alice, 0), 0);
    }

    /// @dev The org is counted but its position in the holder's org list is lost: released without touching the list.
    function test_anOrgWithoutAPositionIsReleasedWithoutTouchingTheList() public {
        _move(0, address(0), alice);
        assertEq(e.orgsHeldBy(alice).length, 1);
        _corrupt(_slotOrgHolding(alice, ORG), _orgHolding(1, 1), _orgHolding(1, 0));

        _move(0, alice, bob);

        assertEq(e.trackedOwnerOf(ORG, 0), bob);
        assertEq(e.orgsHeldBy(bob).length, 1, "the recipient is listed normally");
        assertEq(e.orgsHeldBy(bob)[0], ORG);
        assertEq(e.orgsHeldBy(alice).length, 1, "the unlocatable entry is left, not popped from the wrong place");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), 0, "count and garbage position cleared");
    }

    function test_anOrgPositionPastTheEndOfTheListIsReleasedWithoutPopping() public {
        _move(0, address(0), alice);
        _corrupt(_slotOrgHolding(alice, ORG), _orgHolding(1, 1), _orgHolding(1, 5));

        _move(0, alice, address(0)); // a burn: same release path

        assertEq(e.trackedOwnerOf(ORG, 0), address(0));
        assertEq(e.orgsHeldBy(alice).length, 1, "list untouched");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), 0, "the garbage position is cleared");
    }

    /// @dev An org position that names ANOTHER org in the holder's list: that org stays listed.
    function test_anOrgPositionThatNamesAnotherOrgIsNotPopped() public {
        _moveIn(ORG, 0, address(0), alice);
        _moveIn(ORG2, 0, address(0), alice);
        _corrupt(_slotOrgHolding(alice, ORG2), _orgHolding(1, 2), _orgHolding(1, 1)); // ORG's position

        _moveIn(ORG2, 0, alice, bob);

        address[] memory held = e.orgsHeldBy(alice);
        assertEq(held.length, 2, "nothing popped");
        assertEq(held[0], ORG, "ORG is still listed for alice, where its record says");
        assertEq(uint256(vm.load(address(e), _slotOrgHolding(alice, ORG))), _orgHolding(1, 1), "and its record is untouched");
        // ORG itself still releases normally.
        _moveIn(ORG, 0, alice, bob);
        assertEq(e.orgsHeldBy(alice).length, 1, "only the stale ORG2 entry is left");
        assertEq(e.orgsHeldBy(alice)[0], ORG2);
    }
}

/// @dev Everything else in `ProjectEnumeration`: the re-mint path, the views and the slices.
contract EnumerationBranchesTest is Test {
    ProjectEnumeration internal e;
    MockRegistry internal registry;

    address internal constant ORG = address(0x0C0C);
    address internal constant ORG2 = address(0x0C0D);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);

    function setUp() public {
        registry = new MockRegistry();
        registry.set(ORG, true);
        registry.set(ORG2, true);
        e = new ProjectEnumeration(address(registry));
    }

    function _move(address col, uint256 id, address from, address to) internal {
        vm.prank(col);
        e.onTokenTransfer(id, from, to, from, 1);
    }

    function test_theFactoryIsTheConstructorArgument() public view {
        assertEq(e.factory(), address(registry));
    }

    /// @dev A mint of a token that is already held (a burn the hook missed would produce it) moves it, rather than
    ///      listing it under two owners.
    function test_aReMintToAnotherOwnerMovesTheTokenInsteadOfDuplicating() public {
        _move(ORG, 0, address(0), alice);
        _move(ORG, 0, address(0), bob);

        assertEq(e.balanceOfTracked(ORG, alice), 0);
        assertEq(e.balanceOfTracked(ORG, bob), 1);
        assertEq(e.trackedOwnerOf(ORG, 0), bob);
        assertEq(e.orgsHeldBy(alice).length, 0, "alice no longer holds in the org");
        assertEq(e.orgsHeldBy(bob).length, 1);
    }

    /// @dev Both ends of a self-transfer, and the two ways `from == to` can be zero or not.
    function test_selfTransfersChangeNothing() public {
        _move(ORG, 0, alice, alice); // an untracked token moved to itself: nothing is adopted
        assertEq(e.trackedOwnerOf(ORG, 0), address(0));
        _move(ORG, 0, address(0), address(0));
        assertEq(e.trackedOwnerOf(ORG, 0), address(0));
        _move(ORG, 0, address(0), alice);
        _move(ORG, 0, alice, alice);
        assertEq(e.balanceOfTracked(ORG, alice), 1);
        assertEq(e.orgsHeldBy(alice).length, 1);
    }

    function test_burnOfAnUnknownTokenIsANoOp() public {
        _move(ORG, 77, bob, address(0));
        assertEq(e.orgsHeldBy(bob).length, 0);
        assertEq(e.trackedOwnerOf(ORG, 77), address(0));
    }

    function test_theViewsOfAnEmptyCollection() public view {
        assertEq(e.balanceOfTracked(ORG, alice), 0);
        assertEq(e.tokensOfOwner(ORG, alice).length, 0);
        assertEq(e.orgsHeldBy(alice).length, 0);
        assertEq(e.orgsHeldCount(alice), 0);
        assertEq(e.trackedOwnerOf(ORG, 0), address(0));
        assertEq(e.tokensOfOwnerSlice(ORG, alice, 0, 10).length, 0);
        assertEq(e.orgsHeldSlice(alice, 0, 10).length, 0);
    }

    function test_indexedReadsOutOfRangeRevertWithAPanicNotGarbage() public {
        _move(ORG, 0, address(0), alice);
        assertEq(e.tokenOfOwnerByIndex(ORG, alice, 0), 0);
        vm.expectRevert(stdError.indexOOBError);
        e.tokenOfOwnerByIndex(ORG, alice, 1);
        vm.expectRevert(stdError.indexOOBError);
        e.tokenOfOwnerByIndex(ORG, bob, 0);
    }

    /// @dev Five tokens (ids 10..14) held by alice, in two orgs for the org list (ORG: all five; ORG2: one).
    function _fill() internal {
        for (uint256 i; i < 5; ++i) {
            _move(ORG, 10 + i, address(0), alice);
        }
        _move(ORG2, 0, address(0), alice);
    }

    /// @dev One table for the owner slice: `[start, count] -> expected ids` (5 items; the org list has 2).
    function test_slicesClampAtEveryEdge() public {
        _fill();
        uint256[2][12] memory q = [
            [uint256(0), 0],
            [uint256(0), 5],
            [uint256(0), 6],
            [uint256(0), 99],
            [uint256(2), 3],
            [uint256(2), 2],
            [uint256(4), 1],
            [uint256(4), 2],
            [uint256(5), 1],
            [uint256(6), 1],
            [uint256(1), type(uint256).max],
            [type(uint256).max, type(uint256).max]
        ];
        // How many of the five each query returns.
        uint256[12] memory want = [uint256(0), 5, 5, 5, 3, 2, 1, 1, 0, 0, 4, 0];
        for (uint256 i; i < q.length; ++i) {
            uint256[] memory a = e.tokensOfOwnerSlice(ORG, alice, q[i][0], q[i][1]);
            assertEq(a.length, want[i], "tokensOfOwnerSlice");
            for (uint256 k; k < want[i]; ++k) {
                assertEq(a[k], 10 + q[i][0] + k, "contents are the window, in order");
            }
        }
    }

    function test_orgsHeldSliceClampsAtEveryEdge() public {
        _fill();
        address[] memory all = e.orgsHeldBy(alice);
        assertEq(all.length, 2);
        assertEq(all[0], ORG);
        assertEq(all[1], ORG2);

        assertEq(e.orgsHeldSlice(alice, 0, 0).length, 0, "count zero");
        assertEq(e.orgsHeldSlice(alice, 0, 2).length, 2);
        assertEq(e.orgsHeldSlice(alice, 0, 3).length, 2, "count past the end clamps");
        assertEq(e.orgsHeldSlice(alice, 1, 1)[0], ORG2);
        assertEq(e.orgsHeldSlice(alice, 1, type(uint256).max).length, 1, "a 'give me everything' count cannot overflow");
        assertEq(e.orgsHeldSlice(alice, 2, 1).length, 0, "start at the end");
        assertEq(e.orgsHeldSlice(alice, 3, 1).length, 0, "start past the end");
        assertEq(e.orgsHeldSlice(alice, type(uint256).max, type(uint256).max).length, 0);
        assertEq(e.orgsHeldSlice(bob, 0, 5).length, 0, "an owner with nothing");
    }

    // ─── A fuzzed lifecycle: the books stay consistent whatever `from` claims ───

    /// @dev Arbitrary moves, with `from` often a lie, against a registered and an unregistered collection. Nothing
    ///      reverts, and afterwards every tracked token is in exactly its tracked owner's list and no other, every
    ///      untracked token is in nobody's, and a registered org is listed for an owner exactly when they hold a token in it.
    function testFuzz_booksStayConsistentWhateverFromSays(uint8[48] calldata script) public {
        address[4] memory who = [address(0), alice, bob, carol];
        address unregistered = address(0xBAD);
        for (uint256 i; i + 2 < script.length; i += 3) {
            address col = script[i] % 2 == 0 ? ORG : unregistered;
            uint256 id = script[i] % 5;
            _move(col, id, who[script[i + 1] % 4], who[script[i + 2] % 4]);
        }
        address[3] memory owners = [alice, bob, carol];
        address[2] memory cols = [ORG, unregistered];
        for (uint256 c; c < cols.length; ++c) {
            uint256 supply;
            for (uint256 id; id < 5; ++id) {
                address tracked = e.trackedOwnerOf(cols[c], id);
                if (tracked != address(0)) ++supply;
                uint256 appearances;
                for (uint256 o; o < owners.length; ++o) {
                    uint256[] memory list = e.tokensOfOwner(cols[c], owners[o]);
                    for (uint256 k; k < list.length; ++k) {
                        if (list[k] == id) {
                            ++appearances;
                            assertEq(owners[o], tracked, "listed only under its tracked owner");
                        }
                    }
                }
                assertEq(appearances, tracked == address(0) ? 0 : 1, "exactly once, or not at all");
            }
            uint256 held;
            for (uint256 o; o < owners.length; ++o) {
                held += e.balanceOfTracked(cols[c], owners[o]);
            }
            assertEq(held, supply, "the owners' lists add up to the tokens with a recorded owner");
        }
        for (uint256 o; o < owners.length; ++o) {
            address[] memory orgs = e.orgsHeldBy(owners[o]);
            assertEq(orgs.length, e.balanceOfTracked(ORG, owners[o]) > 0 ? 1 : 0, "listed iff it holds there");
            assertEq(e.orgsHeldCount(owners[o]), orgs.length);
        }
    }
}
