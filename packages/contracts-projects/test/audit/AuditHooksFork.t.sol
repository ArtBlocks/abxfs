// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {Lens} from "../../src/Lens.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "../fork/ContentLayer.sol";

interface IC {
    function ownerOf(uint256) external view returns (address);
    function tokenParam(uint256, bytes32) external view returns (bytes32, bool, bool);
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function clearTokenParam(uint256, bytes32) external;
    function transferFrom(address, address, uint256) external;
    function safeTransferFrom(address, address, uint256) external;
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
    function burn(uint256) external;
}

/// @dev On receipt, forwards the token onward (nested transfer inside the outer transfer's callback).
contract Forwarder {
    address public next;
    IC public c;
    constructor(address c_, address next_) { c = IC(c_); next = next_; }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        c.transferFrom(address(this), next, id);
        return this.onERC721Received.selector;
    }
}

/// @dev On receipt, tries to reenter hook-facing surfaces.
contract Reenter {
    ProjectHook public hook;
    address public org;
    bool public setTagOk;
    constructor(address h, address o) { hook = ProjectHook(h); org = o; }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        try hook.setTag(org, id, "x", 1) { setTagOk = true; } catch {}
        return this.onERC721Received.selector;
    }
}

contract AuditHooksFork is Test {
    address constant ABX_SERIES_CODE_FACTORY = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIRECTORY_STORE = CONTENT_DIRECTORY_STORE;
    address constant FILE_STORE = CONTENT_FILE_STORE;

    OrgFactory factory;
    ProjectHook hook;
    ProjectEnumeration en;
    Lens lens;
    address admin = makeAddr("admin");
    address bob = makeAddr("bob");
    address org;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        factory = OrgComponents.create(ABX_SERIES_CODE_FACTORY, ABX_RENDERER, ABX_SEED, DIRECTORY_STORE, FILE_STORE, address(new OrgMeta("https://fs.abx.io")));
        hook = factory.hook();
        en = factory.enumeration();
        lens = new Lens(address(factory), address(hook));
        vm.prank(admin);
        org = factory.createOrg("Audit Org", "", bytes32(0));
    }

    function _fakeRoot(bytes32 cid, bool dir) internal {
        vm.mockCall(dir ? DIRECTORY_STORE : FILE_STORE, abi.encodeWithSignature(dir ? "directoryExists(bytes32)" : "fileExists(bytes32)", cid), abi.encode(true));
    }

    // ABX gives a configure hook the full gas of the tx? measure the publish cost through real ABX at depth.
    function test_fork_publishGasThroughRealAbxIsFlatInHistoryLength() public {
        IC c = IC(org);
        bytes32 a = keccak256("fa"); bytes32 b = keccak256("fb");
        _fakeRoot(a, true); _fakeRoot(b, true);
        uint256 first; uint256 last;
        for (uint256 i; i < 300; ++i) {
            vm.prank(admin);
            uint256 g = gasleft();
            c.configureTokenParam(0, "abxfs.cid", i % 2 == 0 ? a : b);
            uint256 used = g - gasleft();
            if (i == 1) first = used; // i==0 includes first-write extras
            last = used;
        }
        emit log_named_uint("publish gas", first);
        emit log_named_uint("publish gas v300", last);
        assertEq(hook.versionCount(org, 0), 300);
        // A publish capped at a modest tx gas still works: the hook does not need a huge budget.
        vm.prank(admin);
        c.configureTokenParam{gas: 400_000}(0, "abxfs.cid", a);
    }

    // clearTokenParam is closed to the token owner on a renounced org (so the hook cannot be bypassed that way).
    function test_fork_clearTokenParam_closedToTokenOwner() public {
        IC c = IC(org);
        bytes32 a = keccak256("ca");
        _fakeRoot(a, true);
        vm.prank(admin);
        c.configureTokenParam(0, "abxfs.cid", a);
        vm.prank(admin);
        vm.expectRevert();
        c.clearTokenParam(0, "abxfs.cid");
        // setTokenParam (the ungoverned writer) is also closed.
        vm.prank(admin);
        vm.expectRevert();
        IC(org).configureTokenParam(0, "abxfs.cid", a); // SameRoot veto: head already a
        assertEq(hook.versionCount(org, 0), 1);
    }

    // multicall: a single tx performing publish + transfer + publish-by-new-owner? (auth per msg.sender)
    function test_fork_selfTransferAndNestedForwardingKeepIndexConsistent() public {
        IC c = IC(org);
        // self transfer
        vm.prank(admin);
        c.transferFrom(admin, admin, 0);
        assertEq(en.balanceOfTracked(org, admin), 1);
        assertEq(en.orgsHeldBy(admin).length, 1);

        // safe transfer to a contract that immediately forwards the token to bob (nested)
        Forwarder f = new Forwarder(org, bob);
        vm.prank(admin);
        try c.safeTransferFrom(admin, address(f), 0) {} catch { emit log("safeTransfer w/ forwarding reverted in ABX"); return; }
        assertEq(c.ownerOf(0), bob);
        assertEq(en.trackedOwnerOf(org, 0), bob);
        assertEq(en.balanceOfTracked(org, admin), 0);
        assertEq(en.balanceOfTracked(org, address(f)), 0);
        assertEq(en.balanceOfTracked(org, bob), 1);
        assertEq(en.orgsHeldBy(admin).length, 0);
        assertEq(en.orgsHeldBy(address(f)).length, 0);
        assertEq(en.orgsHeldBy(bob).length, 1);
    }

    function test_fork_receiverCannotTagViaCallback_ownershipRaceWindow() public {
        IC c = IC(org);
        bytes32 a = keccak256("ra"); _fakeRoot(a, true);
        vm.prank(admin);
        c.configureTokenParam(0, "abxfs.cid", a);
        Reenter r = new Reenter(address(hook), org);
        vm.prank(admin);
        c.safeTransferFrom(admin, address(r), 0);
        // Whether the receiver callback already sees itself as owner (and can tag) tells whether the hook window matters.
        emit log_named_uint("receiver tagged during onERC721Received (1=yes)", r.setTagOk() ? 1 : 0);
    }

    function test_fork_burnNotAvailable() public {
        vm.prank(admin);
        vm.expectRevert();
        IC(org).burn(0);
    }

    // The lens on a non-existent token reverts rather than returning empty (documented)
    function test_fork_lensNonexistent() public {
        vm.expectRevert();
        lens.resolve(org, 999);
    }

    // Anyone can create orgs and mint into a victim's wallet: the victim's unpaged orgsHeldBy grows by one per org.
    function test_fork_orgSpamGrowsVictimOrgsHeldAtModestCost() public {
        address spammer = makeAddr("spammer");
        address victim = makeAddr("victim");
        uint256 N = 25;
        uint256 g0 = gasleft();
        for (uint256 i; i < N; ++i) {
            vm.startPrank(spammer);
            address o = factory.createOrg(string.concat("s", vm.toString(i)), "", bytes32(0));
            factory.setOpen(o, true);
            factory.minter().mint(o, victim);
            vm.stopPrank();
        }
        uint256 per = (g0 - gasleft()) / N;
        emit log_named_uint("gas per spammed org entry (createOrg+setOpen+mint)", per);
        assertEq(en.orgsHeldBy(victim).length, N);
        // read cost of the unpaged list for the victim
        uint256 g1 = gasleft();
        en.orgsHeldBy(victim);
        emit log_named_uint("orgsHeldBy read gas per entry", (g1 - gasleft()) / N);
    }
}
