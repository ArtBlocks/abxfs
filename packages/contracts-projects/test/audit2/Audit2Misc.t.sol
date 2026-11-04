// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgMinter} from "../../src/OrgMinter.sol";
import {Lens} from "../../src/Lens.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {ProjectCard} from "../../src/ProjectCard.sol";
import {ProjectTraits} from "../../src/ProjectTraits.sol";
import {ProjectLinks} from "../../src/ProjectLinks.sol";
import {Audit2Base, IA2Coll} from "./Audit2Base.sol";

/// @dev Size / parity facts the docs claim, and the lens against fifth-generation orgs.
contract Audit2Sizes is Test {
    uint256 constant LIMIT = 49_152; // EIP-3860 MAX_INITCODE_SIZE (2 * 24576)

    function test_initcodeHeadroomNumbers() public {
        uint256 creation = type(OrgFactory).creationCode.length;
        // Six addresses, fixed size: the gateway base is OrgMeta's constructor argument, not the factory's.
        bytes memory args = abi.encode(address(1), address(2), address(3), address(4), address(5), address(6));
        emit log_named_uint("creation code bytes", creation);
        emit log_named_uint("ctor args bytes", args.length);
        emit log_named_uint("initcode", creation + args.length);
        emit log_named_uint("headroom", LIMIT - (creation + args.length));
        emit log_named_bytes32("creationCode hash (for a future Create2Parity pin)", keccak256(type(OrgFactory).creationCode));
        assertLt(creation + args.length, LIMIT, "fits");
    }
}

/// @dev Lens vs fifth-generation orgs, on the real fork.
contract Audit2Lens is Audit2Base {
    address org;
    bytes32 r1 = keccak256("lens-1");
    bytes32 r2 = keccak256("lens-2");

    function setUp() public {
        _fork();
        org = _newOrg(alice, "Lens Org");
        _dirRoot(r1);
        _dirRoot(r2);
    }

    /// CONFIRMED: resolve() agrees with direct reads in every project state, and never calls an unregistered
    /// address (a reverting impostor returns registered=false instead of reverting).
    function test_resolveStates() public {
        Lens.Resolution memory r = lens.resolve(org, 0);
        assertTrue(r.registered);
        assertEq(uint8(r.kind), 0, "unpublished: Unset");
        assertEq(r.cid, bytes32(0));
        assertEq(r.owner, alice);
        assertEq(r.gateway.length, 0);

        vm.startPrank(alice);
        IA2Coll(org).configureTokenParam(0, "abxfs.cid", r1);
        IA2Coll(org).configureTokenParamData(0, "abxfs.gateway", bytes("https://ipfs.example"));
        vm.stopPrank();
        r = lens.resolve(org, 0);
        assertEq(r.cid, r1);
        assertEq(uint8(r.kind), 1);
        assertEq(string(r.gateway), "https://ipfs.example");

        vm.prank(alice);
        IA2Coll(org).transferFrom(alice, bob, 0);
        assertEq(lens.resolve(org, 0).owner, bob);

        // nonexistent token: reverts in ownerOf (documented, gateway treats as 404)
        vm.expectRevert();
        lens.resolve(org, 5);

        // impostor: reverts on every call, never invoked
        Lens.Resolution memory z = lens.resolve(address(new Impostor()), 0);
        assertFalse(z.registered);
        // the old shared collection and a plain EOA
        assertFalse(lens.resolve(0x7015Ab36fA7d62dAf286561114E7f3c250511E31, 0).registered);
        assertFalse(lens.resolve(alice, 0).registered);
    }

    /// CONFIRMED: publishRange windows, clamping, and the cost of a crawler page.
    function test_publishRangeWindowsAndGas() public {
        vm.startPrank(alice);
        for (uint256 i; i < 20; ++i) IA2Coll(org).configureTokenParam(0, "abxfs.cid", i % 2 == 0 ? r1 : r2);
        vm.stopPrank();
        assertEq(lens.publishRange(0, 100).length, 20);
        assertEq(lens.publishRange(5, 3).length, 3);
        assertEq(lens.publishRange(20, 3).length, 0, "start == len");
        assertEq(lens.publishRange(1000, 3).length, 0, "start > len");
        assertEq(lens.publishRange(0, type(uint256).max).length, 20, "start 0 + max does not overflow");
        assertEq(lens.publishRange(type(uint256).max, 1).length, 0);
        uint256 g = gasleft();
        Lens.Published[] memory p = lens.publishRange(0, 20);
        uint256 per = (g - gasleft()) / 20;
        emit log_named_uint("publishRange gas per record", per);
        assertEq(p[19].record.version, 20);
        assertEq(p[0].org, org);
    }
}

/// @dev FINDING (info): the documented "pass type(uint256).max as a give-me-everything sentinel" guard
///      (`if (end > len || end < start) end = len;`) is dead code: `start + count` is computed with checked
///      arithmetic one line earlier, so any 0 < start < len with count = max panics instead of clamping.
contract Audit2Sentinel is Audit2Base {
    address org;

    function setUp() public {
        _fork();
        org = _newOrg(alice, "Sentinel");
        _dirRoot(keccak256("s1"));
        _dirRoot(keccak256("s2"));
        vm.startPrank(alice);
        IA2Coll(org).configureTokenParam(0, "abxfs.cid", keccak256("s1"));
        IA2Coll(org).configureTokenParam(0, "abxfs.cid", keccak256("s2"));
        f.minter().mint(org, alice); // a second token for alice
        vm.stopPrank();
        vm.prank(bob);
        f.createOrg("second", "", bytes32(0)); // a second org
    }

    function _is(address target, bytes memory cd) internal view returns (string memory) {
        (bool ok, bytes memory ret) = target.staticcall(cd);
        if (ok) return "ok";
        return ret.length == 36 && bytes4(ret) == bytes4(0x4e487b71) ? "Panic(0x11)" : "other revert";
    }

    /// `start + count` must not overflow before the clamp for any `start > 0` with the `type(uint256).max` sentinel,
    /// in every paged reader whose comment says it clamps: each compares `count` with what is left instead of adding.
    function test_sentinelCountClampsFromAnyStart() public {
        uint256 M = type(uint256).max;
        for (uint256 start; start < 2; ++start) {
            assertEq(_is(address(hook), abi.encodeWithSignature("publishRange(address,uint256,uint256)", org, start, M)), "ok");
            assertEq(_is(address(hook), abi.encodeWithSignature("globalPublishRange(uint256,uint256)", start, M)), "ok");
            assertEq(_is(address(f), abi.encodeWithSignature("orgsSlice(uint256,uint256)", start, M)), "ok");
            assertEq(_is(address(en), abi.encodeWithSignature("tokensOfOwnerSlice(address,address,uint256,uint256)", org, alice, start, M)), "ok");
            assertEq(_is(address(f), abi.encodeWithSignature("orgsAdministeredSlice(address,uint256,uint256)", alice, start, M)), "ok");
            assertEq(_is(address(en), abi.encodeWithSignature("orgsHeldSlice(address,uint256,uint256)", alice, start, M)), "ok");
        }
        // and the windows are the tails, not empty
        assertEq(hook.publishRange(org, 1, M).length, hook.publishRange(org, 0, M).length - 1);
        assertEq(f.orgsSlice(1, M).length, f.orgCount() - 1);
    }
}

contract Impostor {
    fallback() external {
        revert("called an unregistered address");
    }
}