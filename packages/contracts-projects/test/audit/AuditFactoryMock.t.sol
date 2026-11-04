// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {OrgMinter} from "../../src/OrgMinter.sol";
import {MockStore} from "../mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection} from "../mocks/AbxMocks.sol";

/// @dev Registry / authorization / salt PoCs against the mock ABX.
contract AuditFactoryMockTest is Test {
    MockAbxFactory abx;
    OrgFactory f;
    address[4] actors;
    address[] orgs;

    function setUp() public {
        abx = new MockAbxFactory();
        f = OrgComponents.create(address(abx), address(0xBEEF01), address(0xBEEF02), address(new MockStore()), address(new MockStore()), address(new OrgMeta("https://x")));
        for (uint256 i; i < 4; ++i) actors[i] = address(uint160(0xA000 + i));
    }

    // ---- registry swap-and-pop fuzz -------------------------------------------------
    function _check() internal view {
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            address[] memory l = f.orgsAdministered(actors[i]);
            assertEq(l.length, f.orgsAdministeredCount(actors[i]));
            total += l.length;
            for (uint256 j; j < l.length; ++j) {
                assertEq(f.adminOf(l[j]), actors[i], "listed under wrong admin");
                for (uint256 k = j + 1; k < l.length; ++k) assertTrue(l[j] != l[k], "dup");
            }
        }
        assertEq(total, f.orgCount(), "every org listed exactly once");
    }

    function testFuzz_adminIndexIntegrity(uint256[40] memory ops) public {
        for (uint256 n; n < 40; ++n) {
            uint256 op = ops[n];
            address who = actors[op % 4];
            uint256 kind = (op >> 8) % 4;
            if (kind == 0 || orgs.length == 0) {
                vm.prank(who);
                orgs.push(f.createOrg("o", "", bytes32(0)));
            } else {
                address org = orgs[(op >> 16) % orgs.length];
                address other = actors[(op >> 32) % 4];
                vm.prank(who);
                if (kind == 1) { try f.transferAdmin(org, other) {} catch {} }
                else if (kind == 2) { try f.acceptAdmin(org) {} catch {} }
                else { try f.setOpen(org, (op >> 40) % 2 == 1) {} catch {} }
            }
            _check();
        }
    }

    // ---- authorization ---------------------------------------------------------------
    function test_noOneButAdminCanOfferOrOpen_andOfferCannotBeGriefed() public {
        vm.prank(actors[0]);
        address org = f.createOrg("o", "", bytes32(0));
        vm.prank(actors[0]);
        f.transferAdmin(org, actors[1]);
        // stranger can't overwrite / cancel / accept
        vm.prank(actors[2]);
        vm.expectRevert();
        f.transferAdmin(org, actors[2]);
        vm.prank(actors[2]);
        vm.expectRevert();
        f.acceptAdmin(org);
        vm.prank(actors[2]);
        vm.expectRevert();
        f.setOpen(org, true);
        // nonexistent org
        vm.prank(actors[2]);
        vm.expectRevert();
        f.acceptAdmin(address(0xdead));
        // address(0) cannot accept (msg.sender never 0); offer to 0 is withdraw
        vm.prank(actors[0]);
        f.transferAdmin(org, address(0));
        vm.prank(actors[1]);
        vm.expectRevert();
        f.acceptAdmin(org);
        // minter: stranger refused, non-org refused
        OrgMinter m = f.minter();
        vm.prank(actors[2]);
        vm.expectRevert();
        m.mint(org, actors[2]);
        vm.expectRevert();
        m.mint(address(0xdead), actors[2]);
    }

    function test_acceptClosesOpenOrg_andOldAdminLosesAllPower() public {
        vm.startPrank(actors[0]);
        address org = f.createOrg("o", "", bytes32(0));
        f.setOpen(org, true);
        f.transferAdmin(org, actors[1]);
        vm.stopPrank();
        vm.prank(actors[1]);
        f.acceptAdmin(org);
        assertFalse(f.isOpen(org));
        assertFalse(f.mayMint(org, actors[0]));
        vm.prank(actors[0]);
        vm.expectRevert();
        f.setOpen(org, true);
        // replay: old pending is cleared
        vm.prank(actors[1]);
        vm.expectRevert();
        f.acceptAdmin(org);
    }

    // A stale offer made BEFORE an admin change cannot be replayed: offer cleared on accept. But an offer
    // to X survives if admin A offers X and then A offers Y: only the last counts (single slot).
    function test_singleSlotOfferOverwrite() public {
        vm.startPrank(actors[0]);
        address org = f.createOrg("o", "", bytes32(0));
        f.transferAdmin(org, actors[1]);
        f.transferAdmin(org, actors[2]);
        vm.stopPrank();
        vm.prank(actors[1]);
        vm.expectRevert();
        f.acceptAdmin(org);
    }

    // offer to a contract / to admin itself / the org itself: all benign, but self-accept closes an open org
    function test_selfOfferAcceptClosesOrg() public {
        vm.startPrank(actors[0]);
        address org = f.createOrg("o", "", bytes32(0));
        f.setOpen(org, true);
        f.transferAdmin(org, actors[0]);
        f.acceptAdmin(org);
        vm.stopPrank();
        assertFalse(f.isOpen(org));
        assertEq(f.adminOf(org), actors[0]);
        _check();
    }
    // test_longNameBoundaries was converted: see test_nameRefuses* in test/Orgs.t.sol.
}
