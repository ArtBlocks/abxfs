// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectLinks} from "../src/ProjectLinks.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {OrgComponents} from "../script/OrgComponents.sol";

import {GasModel} from "./GasModel.sol";
import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockAbxFactory, MockRegistry} from "./mocks/AbxMocks.sol";

/// @dev One test per gas claim of the org layer's fix round, each pinned two ways: the number of storage slots the
///      operation creates in OUR contracts (schedule-independent, and what EIP-8037 prices at 97,920 each), and a bound
///      on the gas of our own code, measured cold (`vm.cool`). The slot counts are exact; the bounds sit a little above
///      what was measured, so a regression that adds a cold slot or a copy fails here. The fork numbers through the real
///      ABX are in `test/fork/GasProfileFork.t.sol`.
contract GasClaimsTest is Test {
    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_NAME = "abxfs.name";
    bytes32 internal constant KEY_VIEW = "abxfs.view";

    address internal constant ORG = address(0x0C0C);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);

    MockStore internal dirs;
    MockStore internal files;
    MockRegistry internal registry;
    ProjectHook internal hook;
    ProjectEnumeration internal en;

    function setUp() public {
        dirs = new MockStore();
        files = new MockStore();
        registry = new MockRegistry();
        registry.set(ORG, true);
        hook = new ProjectHook(address(dirs), address(files), address(registry));
        en = new ProjectEnumeration(address(registry));
    }

    struct Measured {
        uint256 gas;
        uint256 newSlots;
    }

    /// @dev New slots written in `target` alone (the mocks' own writes are not ours).
    function _slotsIn(VmSafe.AccountAccess[] memory acc, address target) internal pure returns (uint256 n) {
        VmSafe.AccountAccess[] memory mine = new VmSafe.AccountAccess[](acc.length);
        uint256 m;
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.StorageAccess[] memory s = acc[i].storageAccesses;
            uint256 k;
            for (uint256 j; j < s.length; ++j) {
                if (s[j].account == target) ++k;
            }
            VmSafe.StorageAccess[] memory keep = new VmSafe.StorageAccess[](k);
            k = 0;
            for (uint256 j; j < s.length; ++j) {
                if (s[j].account == target) keep[k++] = s[j];
            }
            acc[i].storageAccesses = keep;
            mine[m++] = acc[i];
        }
        n = GasModel.created(mine).slots;
    }

    function _publish(address token, uint256 id, bytes32 cid) internal returns (Measured memory r) {
        vm.cool(address(hook));
        vm.cool(address(dirs));
        vm.cool(address(files));
        vm.cool(address(registry));
        vm.startStateDiffRecording();
        vm.prank(token);
        uint256 g = gasleft();
        hook.onParamConfigured(id, KEY_CID, cid, alice, 0, address(0));
        r.gas = g - gasleft();
        r.newSlots = _slotsIn(vm.stopAndReturnStateDiff(), address(hook));
    }

    function _move(uint256 id, address from, address to) internal returns (Measured memory r) {
        vm.cool(address(en));
        vm.cool(address(registry));
        vm.startStateDiffRecording();
        vm.prank(ORG);
        uint256 g = gasleft();
        en.onTokenTransfer(id, from, to, from, 1);
        r.gas = g - gasleft();
        r.newSlots = _slotsIn(vm.stopAndReturnStateDiff(), address(en));
    }

    // ─── The configure hook ──────────────────────────────────────────────────

    /// @dev H-gas G1 + G2. A publish writes the version (two slots, the kind in the second), one ledger slot and one
    ///      global-ledger slot. Before the round: the version, a three-slot ledger record, the global slot, and the
    ///      first publish of a token a `_kinds` slot too.
    function test_publishWritesTheVersionAndOneSlotPerLedger() public {
        bytes32[4] memory roots = [keccak256("r1"), keccak256("r2"), keccak256("r3"), keccak256("r4")];
        for (uint256 i; i < roots.length; ++i) dirs.add(roots[i]);

        Measured memory first = _publish(ORG, 0, roots[0]); // the org's first ever: both ledger lengths too
        Measured memory firstOfToken = _publish(ORG, 1, roots[0]); // a token's first: its history length too
        Measured memory steady = _publish(ORG, 1, roots[1]);
        Measured memory steady2 = _publish(ORG, 1, roots[2]);
        emit log_named_uint("publish, first in the org: gas", first.gas);
        emit log_named_uint("publish, first of a token: gas", firstOfToken.gas);
        emit log_named_uint("publish, steady: gas", steady.gas);

        assertEq(first.newSlots, 7, "first in the org: history length + 2 version + ledger length + entry + global length + entry");
        assertEq(firstOfToken.newSlots, 5, "a token's first: history length + 2 version + ledger entry + global entry");
        assertEq(steady.newSlots, 4, "steady: 2 version + ledger entry + global entry");
        assertEq(steady2.newSlots, 4);
        assertLt(steady.gas, 100_000, "steady publish, hook only, cold");
        assertLt(firstOfToken.gas, 125_000, "first publish of a token, hook only, cold");
    }

    /// @dev H-gas G6. A republish of a file project asks the file store only.
    function test_aFileProjectsRepublishAsksOneStore() public {
        files.add(keccak256("f1"));
        files.add(keccak256("f2"));
        files.add(keccak256("f3"));
        _publish(ORG, 0, keccak256("f1"));
        vm.expectCall(address(dirs), abi.encodeWithSignature("directoryExists(bytes32)", keccak256("f2")), 0);
        vm.expectCall(address(files), abi.encodeWithSignature("fileExists(bytes32)", keccak256("f2")), 1);
        Measured memory fileRepublish = _publish(ORG, 0, keccak256("f2"));
        dirs.add(keccak256("d1"));
        dirs.add(keccak256("d2"));
        _publish(ORG, 1, keccak256("d1"));
        Measured memory dirRepublish = _publish(ORG, 1, keccak256("d2"));
        emit log_named_uint("republish, file project: gas", fileRepublish.gas);
        emit log_named_uint("republish, directory project: gas", dirRepublish.gas);
        // The same work but for the directory store's call: a cold call and a cold slot in the mock, at least.
        assertLe(fileRepublish.gas, dirRepublish.gas + 500, "a file republish costs no more than a directory one");
        assertEq(fileRepublish.newSlots, 4);
    }

    // ─── The transfer hook ───────────────────────────────────────────────────

    /// @dev H-gas G3 + G4 + G5. A mint to a new holder writes the token's record (one slot), the holder's list (length
    ///      and entry), their org record (one slot) and their org list (length and entry). Before the round: three
    ///      per-token slots, the tracked-set entry, two per-(holder, org) slots and the same lists.
    function test_mintAndTransferSlots() public {
        // Ids from 1: an id of 0 pushed onto a list writes a zero, which creates no slot.
        Measured memory mintNew = _move(3, address(0), alice);
        Measured memory mintExisting = _move(1, address(0), alice);
        Measured memory transferNew = _move(3, alice, bob); // alice keeps token 1; bob is new
        Measured memory transferLeave = _move(1, alice, bob); // alice leaves the org; bob holds another
        Measured memory transferExisting = _move(2, address(0), carol);
        transferExisting = _move(2, carol, bob); // to a holder that already holds two
        emit log_named_uint("mint, new holder: gas", mintNew.gas);
        emit log_named_uint("mint, existing holder: gas", mintExisting.gas);
        emit log_named_uint("transfer, keeps one, recipient new: gas", transferNew.gas);
        emit log_named_uint("transfer, leaves the org, recipient existing: gas", transferLeave.gas);

        assertEq(mintNew.newSlots, 6, "record + list length + entry + org record + org list length + entry");
        assertEq(mintExisting.newSlots, 2, "record + list entry");
        assertEq(transferNew.newSlots, 5, "bob's list length + entry + org record + org list length + entry");
        assertEq(transferLeave.newSlots, 1, "bob's second list entry");
        assertEq(transferExisting.newSlots, 1);
        assertLt(mintNew.gas, 165_000, "mint to a new holder, hook only, cold");
        assertLt(mintExisting.gas, 60_000, "mint to an existing holder, hook only, cold");
        assertLt(transferLeave.gas, 45_000, "transfer, hook only, cold");
    }

    // ─── The factory ─────────────────────────────────────────────────────────

    /// @dev F-gas G1. An org is one slot in the factory (its admin-list position folded into the record), plus its
    ///      entries in the org list and in its admin's list. Before the round: one more slot per org.
    function test_createOrgWritesOneSlotForTheOrg() public {
        OrgFactory f = OrgComponents.create(
            address(new MockAbxFactory()), address(1), address(2), address(dirs), address(files), address(new OrgMeta("https://fs.abx.io"))
        );
        vm.prank(alice);
        f.createOrg("Warm", "", bytes32(0)); // the org list's and alice's list's lengths, once
        vm.startStateDiffRecording();
        vm.prank(alice);
        f.createOrg("Second", "", bytes32(0));
        uint256 slots = _slotsIn(vm.stopAndReturnStateDiff(), address(f));
        assertEq(slots, 3, "the org's record + its org-list entry + its admin-list entry");
    }

    // ─── The renderers ───────────────────────────────────────────────────────

    /// @dev R-gas2. Escaping a name is a single pass in assembly (Solady's `escapeHTML`), not a copy per character.
    function test_cardEscapesANameCheaply() public {
        ProjectCard card = new ProjectCard(address(hook));
        MockAbxToken t = new MockAbxToken(address(hook));
        t.forceParam(1, KEY_CID, keccak256("r1"), false);
        t.forceData(1, KEY_NAME, bytes("\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\"\""));
        uint256 g = gasleft();
        card.render(address(t), 1, "image");
        uint256 worst = g - gasleft();
        t.forceData(1, KEY_NAME, bytes("abcdefghijklmnopqrstuvwxyzAB"));
        g = gasleft();
        card.render(address(t), 1, "image");
        uint256 plain = g - gasleft();
        emit log_named_uint("card, 28 quotes: gas", worst);
        emit log_named_uint("card, 28 letters: gas", plain);
        // 28 escaped characters cost a few thousand gas more than 28 plain ones, not ~3.2k gas each.
        assertLt(worst, plain + 10_000, "escaping is not per-character copying");
        assertLt(worst, 140_000);
    }

    /// @dev R-gas1. A 512-byte view is checked in place: about 30 gas a byte rather than 370.
    function test_linksCheckAViewInPlace() public {
        ProjectLinks links = new ProjectLinks("https://fs.abx.io");
        MockAbxToken t = new MockAbxToken(address(hook));
        bytes memory v = new bytes(512);
        bytes memory scheme = "https://";
        for (uint256 i; i < 512; ++i) v[i] = i < 8 ? scheme[i] : bytes1("a");
        t.forceData(1, KEY_VIEW, v);
        uint256 g = gasleft();
        (, bytes memory out) = links.render(address(t), 1, "animation_url");
        uint256 used = g - gasleft();
        assertEq(out, v);
        t.forceData(1, KEY_VIEW, bytes("https://a"));
        g = gasleft();
        links.render(address(t), 1, "animation_url");
        uint256 short = g - gasleft();
        emit log_named_uint("links, 512-byte view: gas", used);
        emit log_named_uint("links, 9-byte view: gas", short);
        // The mock's SSTORE2-free read is the bulk of what scales with the length; the check itself adds ~40/byte.
        assertLt(used - short, 503 * 150, "under 150 gas per extra byte, read included");
    }
}
