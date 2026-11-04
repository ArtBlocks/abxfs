// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProjectHook} from "../../src/interfaces/IProjectHook.sol";
import {Audit2Base, IA2Coll} from "./Audit2Base.sol";

interface IDelegateV2 {
    function delegateAll(address to, bytes32 rights, bool enable) external payable returns (bytes32);
    function delegateContract(address to, address contract_, bytes32 rights, bool enable)
        external
        payable
        returns (bytes32);
    function delegateERC721(address to, address contract_, uint256 tokenId, bytes32 rights, bool enable)
        external
        payable
        returns (bytes32);
    function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights)
        external
        view
        returns (bool);
}

/// @dev Re-audit of round-1 fix F1 (delegation disabled) on the REAL clone, plus what ERC-721 approvals
///      (single and for-all operators) can and cannot do. "ownerOf is the authorization model" for
///      params and tags; approvals are a separate, standard transfer capability.
contract Audit2Delegation is Audit2Base {
    address constant REG = 0x00000000000000447e69651d841bD8D104Bed493;
    bytes32 constant CID = "abxfs.cid";

    address org;
    IA2Coll c;
    bytes32 root1 = keccak256("audit2-root-1");
    bytes32 root2 = keccak256("audit2-root-2");

    function setUp() public {
        _fork();
        org = _newOrg(alice, "Delegation Audit");
        c = IA2Coll(org);
        _dirRoot(root1);
        _dirRoot(root2);
    }

    function _delegateEverything(address vault, address to) internal {
        vm.startPrank(vault);
        IDelegateV2(REG).delegateAll(to, bytes32(0), true);
        IDelegateV2(REG).delegateContract(to, org, bytes32(0), true);
        IDelegateV2(REG).delegateERC721(to, org, 0, bytes32(0), true);
        // rights-scoped variants too (ABX probes with rights = 0, so these must also be inert)
        IDelegateV2(REG).delegateAll(to, bytes32("abxfs"), true);
        vm.stopPrank();
    }

    function _attempts(address who, bytes32 root) internal returns (uint256 succeeded) {
        bytes[] memory calls = new bytes[](12);
        calls[0] = abi.encodeCall(IA2Coll.configureTokenParam, (0, CID, root));
        calls[1] = abi.encodeCall(IA2Coll.configureTokenParamData, (0, "abxfs.gateway", bytes("https://g.example")));
        calls[2] = abi.encodeCall(IA2Coll.configureTokenParamData, (0, "abxfs.name", bytes("n")));
        calls[3] = abi.encodeCall(IA2Coll.configureTokenParamData, (0, "abxfs.view", bytes("https://v.example")));
        calls[4] = abi.encodeCall(IA2Coll.configureTokenParamData, (0, "abxfs.meta", bytes("m")));
        calls[5] = abi.encodeCall(IA2Coll.setTokenParam, (0, CID, root));
        calls[6] = abi.encodeCall(IA2Coll.setTokenParamData, (0, "abxfs.meta", bytes("m")));
        calls[7] = abi.encodeCall(IA2Coll.clearTokenParam, (0, CID));
        calls[8] = abi.encodeCall(IA2Coll.configureTokenParam, (0, "seed", root));
        calls[9] = abi.encodeCall(IA2Coll.configureTokenParam, (0, "abxfs.nope", root));
        // wrapped in the collection's own multicall (delegatecall to self keeps msg.sender)
        bytes[] memory inner = new bytes[](1);
        inner[0] = calls[0];
        calls[10] = abi.encodeCall(IA2Coll.multicall, (inner));
        inner = new bytes[](2);
        inner[0] = calls[4];
        inner[1] = calls[3];
        calls[11] = abi.encodeCall(IA2Coll.multicall, (inner));
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(who);
            (bool ok,) = org.call(calls[i]);
            if (ok) ++succeeded;
        }
    }

    /// CONFIRMED (round-1 F1 holds): the registry would say "delegate" on every shape, yet the real
    /// clone consults no registry, so a delegate writes nothing through any ABX write path, direct or via
    /// multicall; the real owner still can.
    function test_delegateXyzDelegateWritesNothing() public {
        assertEq(c.delegateRegistry(), address(0), "clone consults no registry");
        _delegateEverything(alice, mallory);
        assertTrue(
            IDelegateV2(REG).checkDelegateForERC721(mallory, alice, org, 0, bytes32(0)),
            "precondition: delegate.xyz itself says mallory is alice's delegate"
        );
        assertEq(_attempts(mallory, root1), 0, "no write path accepts a delegate");
        (, , bool set) = c.tokenParam(0, CID);
        assertFalse(set);
        assertEq(hook.versionCount(org, 0), 0);
        assertEq(c.tokenParamData(0, "abxfs.meta").length, 0);

        // sanity on the test itself: the real owner succeeds on the same calls (the first five are legal
        // for the owner; raw setters, clear, seed, unknown key and multicall-wrapped identical calls
        // either succeed (wrapped) or revert (raw/unknown) -- count must be > 0 so the harness works)
        uint256 ok = _attempts(alice, root1);
        assertGt(ok, 0, "owner is accepted by the same harness");
    }

    /// CONFIRMED: tags use ownerOf and so delegates are refused there too (they never were allowed).
    function test_delegateCannotTag() public {
        _delegateEverything(alice, mallory);
        vm.prank(alice);
        c.configureTokenParam(0, CID, root1);
        vm.prank(mallory);
        vm.expectRevert();
        hook.setTag(org, 0, "v1", 1);
        vm.prank(alice);
        hook.setTag(org, 0, "v1", 1);
        vm.prank(mallory);
        vm.expectRevert();
        hook.removeTag(org, 0, "v1");
    }

    /// CONFIRMED: an approved operator (single or for-all) is NOT the owner for params and tags, but CAN
    /// move the token, and so can become the owner within one transaction. That is standard ERC-721; it is
    /// the one place "ownerOf is the whole authorization model" needs the footnote "plus anyone you
    /// approved to transfer".
    function test_approvedOperatorCannotWriteButCanTakeTheToken() public {
        vm.startPrank(alice);
        c.approve(mallory, 0);
        c.setApprovalForAll(bob, true);
        c.configureTokenParam(0, CID, root1);
        hook.setTag(org, 0, "v1", 1);
        vm.stopPrank();

        assertEq(_attempts(mallory, root2), 0, "single-token operator writes nothing");
        assertEq(_attempts(bob, root2), 0, "for-all operator writes nothing");
        vm.prank(mallory);
        vm.expectRevert();
        hook.setTag(org, 0, "x", 1);
        vm.prank(bob);
        vm.expectRevert();
        hook.removeTag(org, 0, "v1");

        // but a transfer is allowed, and the taker then holds every power the owner had
        vm.prank(mallory);
        c.transferFrom(alice, mallory, 0);
        assertEq(c.ownerOf(0), mallory);
        assertEq(en.trackedOwnerOf(org, 0), mallory);
        vm.prank(mallory);
        c.configureTokenParam(0, CID, root2);
        vm.prank(alice);
        vm.expectRevert();
        c.configureTokenParam(0, CID, root1);
        // the per-token approval died with the transfer; the for-all one belonged to alice, not to the token
        assertEq(c.getApproved(0), address(0));
        vm.prank(bob);
        vm.expectRevert(); // bob is alice's operator, not mallory's
        c.transferFrom(mallory, bob, 0);
    }

    /// CONFIRMED: transfer-then-publish in one block: the previous owner is out the instant the transfer
    /// lands, the new owner's publish records the NEW owner as publisher, tag authority moves too.
    function test_transferThenPublishSameBlock() public {
        vm.startPrank(alice);
        c.transferFrom(alice, bob, 0);
        vm.expectRevert();
        c.configureTokenParam(0, CID, root1);
        vm.stopPrank();
        vm.prank(bob);
        c.configureTokenParam(0, CID, root1);
        IProjectHook.Version memory v = hook.versionAt(org, 0, 1);
        assertEq(v.publisher, bob);
        assertEq(v.cid, root1);
        vm.prank(alice);
        vm.expectRevert();
        hook.setTag(org, 0, "v1", 1);
        vm.prank(bob);
        hook.setTag(org, 0, "v1", 1);
    }

    /// CONFIRMED: a buyer cannot be raced by the seller's approvals: approve(X) is cleared by the
    /// transfer, but the seller's for-all approvals do NOT follow the token. (Control for the standard.)
    function test_sellerApprovalsDoNotFollowTheToken() public {
        vm.startPrank(alice);
        c.approve(mallory, 0);
        c.setApprovalForAll(mallory, true);
        c.transferFrom(alice, bob, 0);
        vm.stopPrank();
        vm.prank(mallory);
        vm.expectRevert();
        c.transferFrom(bob, mallory, 0);
        // ...until the token returns to the seller, which re-arms the seller's standing for-all approval
        vm.prank(bob);
        c.transferFrom(bob, alice, 0);
        vm.prank(mallory);
        c.transferFrom(alice, mallory, 0);
        assertEq(c.ownerOf(0), mallory);
    }
}
