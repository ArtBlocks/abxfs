// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {ProjectLinks} from "../src/ProjectLinks.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";
import {IAbxParams} from "../src/interfaces/IAbxParams.sol";
import {OrgComponents} from "../script/OrgComponents.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection, MockRegistry} from "./mocks/AbxMocks.sol";
import {RawStub, ReturnBomb} from "./mocks/Hostile.sol";

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The configure hook: one-slot ledger entries, the kind in the version slot, the store order, the event
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract HookFixRoundTest is Test {
    bytes32 internal constant KEY_CID = "abxfs.cid";
    address internal constant ORG = address(0x0C0C);
    address internal constant NOT_ORG = address(0x0B0B);
    address internal publisher = address(0xA11CE);

    MockStore internal dirs;
    MockStore internal files;
    MockRegistry internal registry;
    ProjectHook internal hook;

    bytes32 internal r1 = keccak256("r1");
    bytes32 internal r2 = keccak256("r2");
    bytes32 internal r3 = keccak256("r3");
    bytes32 internal f1 = keccak256("f1");
    bytes32 internal f2 = keccak256("f2");

    function setUp() public {
        dirs = new MockStore();
        files = new MockStore();
        registry = new MockRegistry();
        registry.set(ORG, true);
        hook = new ProjectHook(address(dirs), address(files), address(registry));
        dirs.add(r1);
        dirs.add(r2);
        dirs.add(r3);
        files.add(f1);
        files.add(f2);
    }

    function _pub(address token, uint256 id, bytes32 cid) internal {
        vm.prank(token);
        hook.onParamConfigured(id, KEY_CID, cid, publisher, 0, address(0));
    }

    // Storage layout (`forge inspect ProjectHook storage-layout`): `_versions` at 0, `_publishLog` at 1.
    function _history(address token, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, keccak256(abi.encode(token, uint256(0)))));
    }

    function _versionWord(address token, uint256 id, uint256 i, uint256 word) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(_history(token, id)))) + 2 * i + word);
    }

    function _entry(address token, uint256 i) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(keccak256(abi.encode(token, uint256(1)))))) + i);
    }

    function _assertRecord(IProjectHook.PublishRecord memory r, bytes32 cid, uint256 at, uint256 version, uint256 id)
        internal
        view
    {
        assertEq(r.cid, cid, "cid");
        assertEq(r.publisher, publisher, "publisher");
        assertEq(r.publishedAt, at, "publishedAt");
        assertEq(r.version, version, "version");
        assertEq(r.tokenId, id, "tokenId");
    }

    /// @dev H-gas G1: an entry is `tokenId << 32 | version`, and every reader rebuilds the record from the history.
    function test_aLedgerEntryIsTheTokenAndTheVersion_andEveryReaderRebuildsTheRecord() public {
        vm.warp(1000);
        _pub(ORG, 5, r1);
        vm.warp(2000);
        _pub(ORG, 7, r2);
        vm.warp(3000);
        _pub(ORG, 5, r3);

        assertEq(uint256(vm.load(address(hook), _entry(ORG, 0))), (uint256(5) << 32) | 1);
        assertEq(uint256(vm.load(address(hook), _entry(ORG, 1))), (uint256(7) << 32) | 1);
        assertEq(uint256(vm.load(address(hook), _entry(ORG, 2))), (uint256(5) << 32) | 2);

        _assertRecord(hook.publishAt(ORG, 0), r1, 1000, 1, 5);
        _assertRecord(hook.publishAt(ORG, 1), r2, 2000, 1, 7);
        _assertRecord(hook.publishAt(ORG, 2), r3, 3000, 2, 5);

        IProjectHook.PublishRecord[] memory w = hook.publishRange(ORG, 1, 5);
        assertEq(w.length, 2);
        _assertRecord(w[0], r2, 2000, 1, 7);
        _assertRecord(w[1], r3, 3000, 2, 5);
        w = hook.recentPublishes(ORG, 2);
        _assertRecord(w[0], r3, 3000, 2, 5);
        _assertRecord(w[1], r2, 2000, 1, 7);
        w = hook.recentPublishesBefore(ORG, 1, 9);
        assertEq(w.length, 1);
        _assertRecord(w[0], r1, 1000, 1, 5);

        (address[] memory orgs, uint256[] memory idx) = hook.globalPublishRange(0, 9);
        assertEq(orgs.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(orgs[i], ORG);
            assertEq(idx[i], i);
        }

        // The version itself is unchanged by the packing: a read of the history agrees with the ledger.
        IProjectHook.Version memory v = hook.versionAt(ORG, 5, 2);
        assertEq(v.cid, r3);
        assertEq(v.publishedAt, 3000);
        assertEq(v.publisher, publisher);
        IProjectHook.Version[] memory all = hook.versionsRange(ORG, 5, 0, 2);
        assertEq(all[0].cid, r1);
        assertEq(all[1].cid, r3);
    }

    /// @dev The largest id an entry holds is 2^224 - 1, and it round-trips.
    function test_theLargestPackableTokenIdIsLedgered() public {
        uint256 id = type(uint224).max;
        vm.warp(77);
        _pub(ORG, id, r1);
        assertEq(hook.publishCount(ORG), 1);
        _assertRecord(hook.publishAt(ORG, 0), r1, 77, 1, id);
        assertEq(hook.globalPublishCount(), 1);
    }

    /// @dev An id past 2^224 - 1 (only a caller that is not an org has one: an org's ids are below its supply cap) is
    ///      kept in the token's history and left out of both ledgers. The publish itself never reverts.
    function test_aTokenIdPastThePackingKeepsItsHistoryButNoLedgerEntry() public {
        uint256[3] memory ids = [uint256(type(uint224).max) + 1, type(uint256).max - 1, uint256(1) << 255];
        for (uint256 k; k < ids.length; ++k) {
            _pub(ORG, ids[k], r1);
            assertEq(hook.versionCount(ORG, ids[k]), 1, "the history has it");
            assertEq(uint8(hook.kindOf(ORG, ids[k])), uint8(IProjectHook.ContentKind.Directory));
            (uint256 v, bytes32 head) = hook.latestVersion(ORG, ids[k]);
            assertEq(v, 1);
            assertEq(head, r1);
        }
        assertEq(hook.publishCount(ORG), 0, "no ledger entry");
        assertEq(hook.globalPublishCount(), 0, "and none in the shared feed");
        // The ledgers still work for everything that fits.
        _pub(ORG, 3, r2);
        assertEq(hook.publishCount(ORG), 1);
        _assertRecord(hook.publishAt(ORG, 0), r2, block.timestamp, 1, 3);
        assertEq(hook.globalPublishCount(), 1);
    }

    /// @dev A version past 2^32 - 1 is left out the same way (it takes 4.29 billion publishes of one token, so the
    ///      history's length is forged here).
    function test_aVersionPastThePackingKeepsItsHistoryButNoLedgerEntry() public {
        _pub(ORG, 3, r1);
        assertEq(uint256(vm.load(address(hook), _history(ORG, 3))), 1, "the history's length slot");
        vm.store(address(hook), _history(ORG, 3), bytes32(uint256(type(uint32).max)));

        _pub(ORG, 3, r2); // version 2^32
        assertEq(hook.versionCount(ORG, 3), uint256(type(uint32).max) + 1);
        assertEq(hook.versionAt(ORG, 3, uint256(type(uint32).max) + 1).cid, r2);
        (uint256 v, bytes32 head) = hook.latestVersion(ORG, 3);
        assertEq(v, uint256(type(uint32).max) + 1);
        assertEq(head, r2);
        assertEq(hook.publishCount(ORG), 1, "only the first publish is in the ledger");
        assertEq(hook.globalPublishCount(), 1);
        _assertRecord(hook.publishAt(ORG, 0), r1, block.timestamp, 1, 3);
        // The kind lock still holds past it.
        vm.prank(ORG);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.Directory, IProjectHook.ContentKind.File
            )
        );
        hook.onParamConfigured(3, KEY_CID, f1, publisher, 0, address(0));
    }

    /// @dev The largest version an entry holds is 2^32 - 1, and it round-trips; 2^32 is the first left out.
    function test_theLargestPackableVersionIsLedgered() public {
        _pub(ORG, 3, r1);
        vm.store(address(hook), _history(ORG, 3), bytes32(uint256(type(uint32).max) - 1));
        vm.warp(555);
        _pub(ORG, 3, r2); // version 2^32 - 1
        assertEq(hook.publishCount(ORG), 2);
        _assertRecord(hook.publishAt(ORG, 1), r2, 555, type(uint32).max, 3);
        assertEq(uint256(vm.load(address(hook), _entry(ORG, 1))), (uint256(3) << 32) | type(uint32).max);
        _pub(ORG, 3, r3); // version 2^32
        assertEq(hook.publishCount(ORG), 2, "2^32 is the first version left out");
        assertEq(hook.versionCount(ORG, 3), uint256(type(uint32).max) + 1);
    }

    /// @dev Neither limit needs an org: a caller that is not one gets the same history and per-collection ledger, and no
    ///      global entry.
    function test_aCallerThatIsNotAnOrgIsLedgeredButNotShared() public {
        _pub(NOT_ORG, 1, r1);
        assertEq(hook.publishCount(NOT_ORG), 1);
        assertEq(hook.globalPublishCount(), 0);
    }

    /// @dev H-gas G2: the kind rides in the version's second slot (`publishedAt | publisher << 40 | kind << 200`), set
    ///      by the first publish and repeated in every later version; `kindOf` reads the first.
    function test_theKindRidesInTheVersionSlot() public {
        assertEq(uint8(hook.kindOf(ORG, 1)), uint8(IProjectHook.ContentKind.Unset));
        vm.warp(1234);
        _pub(ORG, 1, f1);
        _pub(ORG, 1, f2);
        assertEq(uint8(hook.kindOf(ORG, 1)), uint8(IProjectHook.ContentKind.File));
        uint256 want = 1234 | (uint256(uint160(publisher)) << 40) | (uint256(2) << 200);
        assertEq(uint256(vm.load(address(hook), _versionWord(ORG, 1, 0, 1))), want, "version 1");
        assertEq(uint256(vm.load(address(hook), _versionWord(ORG, 1, 1, 1))), want, "version 2");
        assertEq(vm.load(address(hook), _versionWord(ORG, 1, 1, 0)), f2);

        _pub(ORG, 2, r1);
        assertEq(uint8(hook.kindOf(ORG, 2)), uint8(IProjectHook.ContentKind.Directory));
        assertEq(uint256(vm.load(address(hook), _versionWord(ORG, 2, 0, 1))) >> 200, 1);
    }

    /// @dev H-gas G6: a project locked to File asks the file store first; anything else asks the directory store
    ///      first. The answer and the precedence of the three refusals are the same either way.
    function test_theStoreOrderFollowsTheKindLock() public {
        // A first publish: directory store first, then the file store.
        vm.expectCall(address(dirs), abi.encodeWithSignature("directoryExists(bytes32)", f1), 1);
        vm.expectCall(address(files), abi.encodeWithSignature("fileExists(bytes32)", f1), 1);
        _pub(ORG, 1, f1);

        // Locked to File: a file root is found without asking the directory store.
        vm.expectCall(address(dirs), abi.encodeWithSignature("directoryExists(bytes32)", f2), 0);
        _pub(ORG, 1, f2);
        // A directory root: the file store says no, the directory store yes, and the lock refuses it.
        vm.expectCall(address(files), abi.encodeWithSignature("fileExists(bytes32)", r1), 1);
        vm.expectCall(address(dirs), abi.encodeWithSignature("directoryExists(bytes32)", r1), 1);
        vm.prank(ORG);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.File, IProjectHook.ContentKind.Directory
            )
        );
        hook.onParamConfigured(1, KEY_CID, r1, publisher, 0, address(0));
        // A root in neither store: both are asked and it is not found.
        bytes32 none = keccak256("none");
        vm.prank(ORG);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, none));
        hook.onParamConfigured(1, KEY_CID, none, publisher, 0, address(0));
        // The head again: found, kind fine, and refused as the same root.
        vm.prank(ORG);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, f2));
        hook.onParamConfigured(1, KEY_CID, f2, publisher, 0, address(0));

        // Locked to Directory: the directory store first, and a file root refused after both are asked. (r3 here, not
        // r1: an expected call count holds to the end of the test.)
        _pub(ORG, 2, r3);
        vm.expectCall(address(files), abi.encodeWithSignature("fileExists(bytes32)", r2), 0);
        _pub(ORG, 2, r2);
        bytes32 f3 = keccak256("f3");
        files.add(f3);
        vm.expectCall(address(dirs), abi.encodeWithSignature("directoryExists(bytes32)", f3), 1);
        vm.expectCall(address(files), abi.encodeWithSignature("fileExists(bytes32)", f3), 1);
        vm.prank(ORG);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.Directory, IProjectHook.ContentKind.File
            )
        );
        hook.onParamConfigured(2, KEY_CID, f3, publisher, 0, address(0));
    }

    /// @dev A3: the event indexes `cid`, so the log has four topics and its data is (version, kind, publisher).
    function test_theEventIndexesTheCid() public {
        vm.recordLogs();
        _pub(ORG, 9, f1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], IProjectHook.ProjectVersionPublished.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(ORG))));
        assertEq(logs[0].topics[2], bytes32(uint256(9)));
        assertEq(logs[0].topics[3], f1);
        (uint256 version, uint8 kind, address who) = abi.decode(logs[0].data, (uint256, uint8, address));
        assertEq(version, 1);
        assertEq(kind, uint8(IProjectHook.ContentKind.File));
        assertEq(who, publisher);
        // The signature, and so topic 0, is unchanged by `indexed`.
        assertEq(
            IProjectHook.ProjectVersionPublished.selector,
            keccak256("ProjectVersionPublished(address,uint256,uint256,bytes32,uint8,address)")
        );
    }

    /// @dev H-I1: a registry that answers with a huge returndata is "not an org", and the hook copies none of it: the
    ///      publish costs the callee's own memory and no more. Copying 64 KiB into the hook's memory would add about
    ///      20k gas on top of the callee's ~14k.
    function test_aReturndataBombRegistryIsNotAnOrgAndIsNotCopied() public {
        ReturnBomb word = new ReturnBomb(32);
        ReturnBomb bomb = new ReturnBomb(65_536);
        ProjectHook small = new ProjectHook(address(dirs), address(files), address(word));
        ProjectHook big = new ProjectHook(address(dirs), address(files), address(bomb));

        vm.prank(ORG);
        uint256 g = gasleft();
        small.onParamConfigured(1, KEY_CID, r1, publisher, 0, address(0));
        uint256 withWord = g - gasleft();
        vm.prank(ORG);
        g = gasleft();
        big.onParamConfigured(1, KEY_CID, r1, publisher, 0, address(0));
        uint256 withBomb = g - gasleft();

        assertEq(small.globalPublishCount(), 0, "a zero word is not an org");
        assertEq(big.globalPublishCount(), 0, "nor is a returndata bomb");
        assertEq(big.versionCount(ORG, 1), 1, "and the publish lands");
        emit log_named_uint("extra gas for a 64 KiB answer", withBomb - withWord);
        assertLt(withBomb - withWord, 20_000, "the callee's memory only: nothing is copied back");

        // The enumeration hook, the same.
        ProjectEnumeration e1 = new ProjectEnumeration(address(word));
        ProjectEnumeration e2 = new ProjectEnumeration(address(bomb));
        vm.prank(ORG);
        g = gasleft();
        e1.onTokenTransfer(1, address(0), publisher, publisher, 1);
        withWord = g - gasleft();
        vm.prank(ORG);
        g = gasleft();
        e2.onTokenTransfer(1, address(0), publisher, publisher, 1);
        withBomb = g - gasleft();
        assertEq(e2.orgsHeldCount(publisher), 0);
        assertEq(e2.balanceOfTracked(ORG, publisher), 1);
        assertLt(withBomb - withWord, 20_000);
    }

    /// @dev A word of 1 followed by anything is still not exactly one word, and a word of 1 alone is.
    function test_onlyExactlyOneTrueWordIsAnOrg() public {
        RawStub stub = new RawStub();
        ProjectHook h = new ProjectHook(address(dirs), address(files), address(stub));
        stub.ret(IOrgFactory.isOrg.selector, abi.encodePacked(uint256(1), uint8(0)));
        _pubTo(h, 1);
        assertEq(h.globalPublishCount(), 0, "33 bytes");
        stub.ret(IOrgFactory.isOrg.selector, abi.encode(uint256(1)));
        _pubTo(h, 2);
        assertEq(h.globalPublishCount(), 1, "one word of 1");
    }

    function _pubTo(ProjectHook h, uint256 id) internal {
        vm.prank(ORG);
        h.onParamConfigured(id, KEY_CID, r1, publisher, 0, address(0));
    }

    /// @dev The packed ledger against an independent model: any sequence of publishes across tokens, read back through
    ///      every reader, matches what was published, in order.
    function testFuzz_theLedgerMatchesAModel(uint8[40] calldata script) public {
        bytes32[3] memory roots = [r1, r2, r3];
        uint256[] memory ids = new uint256[](40);
        bytes32[] memory cids = new bytes32[](40);
        uint256[] memory versions = new uint256[](40);
        uint256[5] memory count;
        bytes32[5] memory head;
        uint256 n;
        for (uint256 s; s < script.length; ++s) {
            uint256 id = script[s] % 5;
            bytes32 cid = roots[(script[s] / 5) % 3];
            if (head[id] == cid) continue; // SameRoot, covered elsewhere
            vm.warp(1000 + s);
            _pub(ORG, id, cid);
            head[id] = cid;
            ++count[id];
            ids[n] = id;
            cids[n] = cid;
            versions[n] = count[id];
            ++n;
        }
        assertEq(hook.publishCount(ORG), n);
        IProjectHook.PublishRecord[] memory all = hook.publishRange(ORG, 0, type(uint256).max);
        IProjectHook.PublishRecord[] memory recent = hook.recentPublishes(ORG, type(uint256).max);
        assertEq(all.length, n);
        for (uint256 i; i < n; ++i) {
            assertEq(all[i].tokenId, ids[i]);
            assertEq(all[i].cid, cids[i]);
            assertEq(all[i].version, versions[i]);
            assertEq(all[i].publisher, publisher);
            assertEq(recent[n - 1 - i].cid, cids[i]);
            assertEq(hook.versionAt(ORG, ids[i], versions[i]).cid, cids[i]);
        }
        assertEq(hook.globalPublishCount(), n);
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The factory: one slot per org, acceptAdmin with nothing pending, the administered slice
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract FactoryFixRoundTest is Test {
    OrgFactory internal factory;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    MockStore internal dirs;

    function setUp() public {
        dirs = new MockStore();
        factory = OrgComponents.create(
            address(new MockAbxFactory()),
            address(0xBEEF01),
            address(0xBEEF02),
            address(dirs),
            address(new MockStore()),
            address(new OrgMeta("https://fs.abx.io"))
        );
    }

    function _create(address who, string memory name) internal returns (address org) {
        vm.prank(who);
        org = factory.createOrg(name, "", bytes32(0));
    }

    /// @dev Storage layout: `_orgs` at slot 0.
    function _orgSlot(address org) internal pure returns (bytes32) {
        return keccak256(abi.encode(org, uint256(0)));
    }

    function _record(address admin, uint256 createdBlock, bool open, uint256 indexPlusOne) internal pure returns (uint256) {
        return uint256(uint160(admin)) | (createdBlock << 160) | ((open ? uint256(1) : 0) << 200) | (indexPlusOne << 208);
    }

    /// @dev F-gas G1: an org is one slot — admin, created block (40 bits), open, and its position in its admin's list.
    function test_anOrgIsOneSlot() public {
        vm.roll(12_345);
        address a = _create(alice, "A");
        address b = _create(alice, "B");
        assertEq(uint256(vm.load(address(factory), _orgSlot(a))), _record(alice, 12_345, false, 1));
        assertEq(uint256(vm.load(address(factory), _orgSlot(b))), _record(alice, 12_345, false, 2));
        vm.prank(alice);
        factory.setOpen(b, true);
        assertEq(uint256(vm.load(address(factory), _orgSlot(b))), _record(alice, 12_345, true, 2));

        // A handover moves the org between lists and rewrites its slot once: new admin, closed, its new position. The
        // org that was last in alice's list takes the leaver's position.
        vm.prank(alice);
        factory.transferAdmin(a, bob);
        vm.prank(bob);
        factory.acceptAdmin(a);
        assertEq(uint256(vm.load(address(factory), _orgSlot(a))), _record(bob, 12_345, false, 1));
        assertEq(uint256(vm.load(address(factory), _orgSlot(b))), _record(alice, 12_345, true, 1), "b moved to 1");
        assertEq(factory.orgsAdministered(alice)[0], b);
        assertEq(factory.createdBlockOf(a), 12_345, "the block survives the handover");
    }

    /// @dev Forty bits hold any block number a chain will reach; the largest is stored and read back whole.
    function test_theCreatedBlockFitsFortyBits() public {
        vm.roll(type(uint40).max);
        address org = _create(alice, "Late");
        assertEq(factory.createdBlockOf(org), type(uint40).max);
        assertTrue(factory.isOrg(org));
    }

    /// @dev With no offer pending, `pendingAdminOf` is zero: refused outright, even for a zero caller (which cannot occur
    ///      on chain, but would otherwise have matched). A withdrawn offer is the same.
    function test_acceptAdminRefusesWhenNothingIsPending() public {
        address org = _create(alice, "Acme");
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, address(0)));
        factory.acceptAdmin(org);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, bob));
        factory.acceptAdmin(org);

        vm.prank(alice);
        factory.transferAdmin(org, bob);
        vm.prank(alice);
        factory.transferAdmin(org, address(0)); // withdrawn
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, address(0)));
        factory.acceptAdmin(org);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, bob));
        factory.acceptAdmin(org);
        assertEq(factory.adminOf(org), alice);
        assertTrue(factory.isOrg(org));

        // Not an org at all is still `NotOrg`, whoever asks.
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotOrg.selector, address(0xD00D)));
        factory.acceptAdmin(address(0xD00D));
    }

    /// @dev A zero admin would read as "no org", so a zero caller (which cannot occur on chain) cannot create one: the
    ///      final mint asks `mayMint`, which says no, and the whole creation reverts.
    function test_aZeroCallerCannotCreateAnOrg() public {
        vm.prank(address(0));
        vm.expectPartialRevert(OrgMinter.NotAllowed.selector);
        factory.createOrg("Nobody", "", bytes32(0));
        assertEq(factory.orgCount(), 0);
    }

    /// @dev A10 / F-I4: `orgsAdministeredSlice` clamps like `orgsSlice`, and pages the same list `orgsAdministered`
    ///      returns.
    function test_orgsAdministeredSliceClampsAtEveryEdge() public {
        address[5] memory orgs;
        for (uint256 i; i < 5; ++i) orgs[i] = _create(alice, string.concat("Org ", vm.toString(i)));
        uint256[2][11] memory q = [
            [uint256(0), 0],
            [uint256(0), 5],
            [uint256(0), 6],
            [uint256(2), 3],
            [uint256(2), 2],
            [uint256(4), 1],
            [uint256(4), 9],
            [uint256(5), 1],
            [uint256(6), 1],
            [uint256(1), type(uint256).max],
            [type(uint256).max, type(uint256).max]
        ];
        uint256[11] memory want = [uint256(0), 5, 5, 3, 2, 1, 1, 0, 0, 4, 0];
        for (uint256 i; i < q.length; ++i) {
            address[] memory w = factory.orgsAdministeredSlice(alice, q[i][0], q[i][1]);
            address[] memory s = factory.orgsSlice(q[i][0], q[i][1]);
            assertEq(w.length, want[i], "orgsAdministeredSlice");
            assertEq(s.length, want[i], "orgsSlice, the same rule");
            for (uint256 k; k < w.length; ++k) {
                assertEq(w[k], orgs[q[i][0] + k], "the window, in order");
                assertEq(s[k], orgs[q[i][0] + k]);
            }
        }
        assertEq(factory.orgsAdministeredSlice(bob, 0, 10).length, 0, "an admin of nothing");
        // After a handover the list is reordered (swap-and-pop), and the slice follows it.
        vm.prank(alice);
        factory.transferAdmin(orgs[1], bob);
        vm.prank(bob);
        factory.acceptAdmin(orgs[1]);
        address[] memory after_ = factory.orgsAdministeredSlice(alice, 0, 10);
        address[] memory full = factory.orgsAdministered(alice);
        assertEq(after_.length, 4);
        for (uint256 k; k < 4; ++k) assertEq(after_[k], full[k]);
        assertEq(after_[1], orgs[4], "the last moved into the leaver's place");
        assertEq(factory.orgsAdministeredSlice(bob, 0, 1)[0], orgs[1]);
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The renderers: the card's id and escaping, the trait and card name rule, the links rule in place
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract RendererFixRoundTest is Test {
    using LibString for string;

    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_NAME = "abxfs.name";
    bytes32 internal constant KEY_VIEW = "abxfs.view";
    string internal constant BASE = "https://fs.abx.io";

    MockOrgCollection internal org;
    OrgFactory internal factory;
    MockStore internal dirs;
    address internal alice = makeAddr("alice");

    function setUp() public {
        dirs = new MockStore();
        factory = OrgComponents.create(
            address(new MockAbxFactory()),
            address(0xBEEF01),
            address(0xBEEF02),
            address(dirs),
            address(new MockStore()),
            address(new OrgMeta(BASE))
        );
        vm.prank(alice);
        org = MockOrgCollection(factory.createOrg("Acme", "", bytes32(0)));
        vm.startPrank(alice);
        for (uint256 i; i < 3; ++i) factory.minter().mint(address(org), alice);
        vm.stopPrank();
    }

    function _card(uint256 id) internal view returns (string memory) {
        (, bytes memory d) = factory.card().render(address(org), id, "image");
        return string(d);
    }

    function _between(string memory s, string memory open) internal pure returns (string memory) {
        uint256 at = s.indexOf(open);
        assertTrue(at != LibString.NOT_FOUND, "marker");
        uint256 from = at + bytes(open).length;
        return s.slice(from, s.indexOf("</text>", from));
    }

    /// @dev R-L3: the card shows `#<id>`, so a project named after a sibling's default name ("Acme #0" on token 3) does
    ///      not pass as that sibling. The collection surface has no id.
    function test_theCardShowsTheTokensId() public {
        vm.prank(alice);
        org.configureTokenParamData(3, KEY_NAME, bytes("Acme #0"));
        string memory svg = _card(3);
        assertEq(_between(svg, 'font-size="19">'), "Acme #0", "the name it chose");
        assertEq(_between(svg, 'font-size="13" letter-spacing="2">'), "#3", "and the id it is");
        assertEq(_between(_card(0), 'font-size="13" letter-spacing="2">'), "#0");
        (, bytes memory c) = factory.card().render(address(org), type(uint256).max, "image");
        assertFalse(string(c).contains('letter-spacing="2"'), "no id at the collection surface");
        assertFalse(string(c).contains(">#"));
        // The token's own name renderer agrees that "Acme #0" is a usable name for token 3: only the card tells.
        (, bytes memory n) = OrgMeta(factory.orgMeta()).render(address(org), 3, "name");
        assertEq(string(n), "Acme #0");
    }

    /// @dev R-L2: a name `OrgMeta` refuses is refused by the card ("untitled") and the Named trait ("No"), and one it
    ///      shows is shown by both.
    function test_cardTraitAndTokenNameAgreeOnWhetherThereIsAName() public {
        bytes[7] memory names =
            [bytes("-"), bytes("   "), bytes(unicode"café"), bytes(hex"610962"), bytes("ok"), bytes(" ok "), bytes("--")];
        bool[7] memory shown = [false, false, false, false, true, true, true];
        for (uint256 i; i < names.length; ++i) {
            vm.prank(alice);
            org.configureTokenParamData(1, KEY_NAME, names[i]);
            string memory card = _between(_card(1), 'font-size="19">');
            (, bytes memory t) = factory.traits().render(address(org), 1, "attributes");
            (, bytes memory n) = OrgMeta(factory.orgMeta()).render(address(org), 1, "name");
            assertEq(string(t).contains('"Named","value":"Yes"'), shown[i], "trait");
            assertEq(keccak256(bytes(card)) != keccak256("untitled"), shown[i], "card");
            assertEq(keccak256(n) == keccak256(names[i]), shown[i], "token name");
        }
    }

    /// @dev R-L1: a gateway of `-` (the SDK's cleared marker) is "None".
    function test_aClearedGatewayIsNone() public {
        vm.startPrank(alice);
        org.configureTokenParamData(1, "abxfs.gateway", bytes("https://gw.example"));
        (, bytes memory t) = factory.traits().render(address(org), 1, "attributes");
        assertTrue(string(t).contains('"Preferred IPFS Gateway","value":"Set"'));
        org.configureTokenParamData(1, "abxfs.gateway", bytes("-"));
        (, t) = factory.traits().render(address(org), 1, "attributes");
        assertTrue(string(t).contains('"Preferred IPFS Gateway","value":"None"'));
        vm.stopPrank();
    }

    /// @dev Unescape the five entities `escapeHTML` emits; anything else after `&` fails the test.
    function _unescape(bytes memory s) internal pure returns (bytes memory out) {
        out = new bytes(s.length);
        uint256 n;
        for (uint256 i; i < s.length;) {
            if (s[i] != "&") {
                out[n++] = s[i++];
                continue;
            }
            bytes memory rest = new bytes(s.length - i < 6 ? s.length - i : 6);
            for (uint256 k; k < rest.length; ++k) rest[k] = s[i + k];
            string memory r = string(rest);
            if (r.startsWith("&amp;")) (out[n++], i) = (bytes1("&"), i + 5);
            else if (r.startsWith("&lt;")) (out[n++], i) = (bytes1("<"), i + 4);
            else if (r.startsWith("&gt;")) (out[n++], i) = (bytes1(">"), i + 4);
            else if (r.startsWith("&quot;")) (out[n++], i) = (bytes1('"'), i + 6);
            else if (r.startsWith("&#39;")) (out[n++], i) = (bytes1("'"), i + 5);
            else revert("a bare ampersand");
        }
        assembly {
            mstore(out, n)
        }
    }

    /// @dev R-gas2: the card's names go through Solady's `escapeHTML`. Its output is safe in every context the card
    ///      could put it in, SVG text and SVG attributes alike: it holds no `<` (no markup can open), no `"` or `'` (no
    ///      quoted attribute can close), every `&` begins one of the five entities XML defines or a numeric reference,
    ///      and every byte is printable ASCII (none that XML forbids). Unescaped, it is the name exactly. The card has no
    ///      other tags than its template's, whatever the name.
    function testFuzz_escapedNamesAreSafeInSvgTextAndAttributes(bytes calldata raw, uint8 len) public {
        uint256 n = 1 + (uint256(len) % 60);
        bytes memory name = new bytes(n);
        for (uint256 i; i < n; ++i) {
            // Printable ASCII, weighted towards the five metacharacters.
            uint8 b = i < raw.length ? uint8(raw[i]) : uint8(i * 7);
            bytes1 c = b % 4 == 0 ? bytes("&<>\"'")[b % 5] : bytes1(0x20 + (b % 95));
            name[i] = c;
        }
        name[0] = "x"; // never only spaces, never a lone "-"
        vm.prank(alice);
        org.configureTokenParamData(1, KEY_NAME, name);
        string memory svg = _card(1);
        bytes memory shown = bytes(_between(svg, 'font-size="19">'));

        for (uint256 i; i < shown.length; ++i) {
            bytes1 c = shown[i];
            assertTrue(c != "<" && c != ">" && c != '"' && c != "'", "no metacharacter survives raw");
        }
        bool cut = n > 28;
        uint256 keep = cut ? 28 : n;
        bytes memory body = shown;
        if (cut) {
            // The ellipsis is the last three bytes (U+2026).
            assertEq(uint8(shown[shown.length - 3]), 0xe2);
            body = new bytes(shown.length - 3);
            for (uint256 i; i < body.length; ++i) body[i] = shown[i];
        }
        for (uint256 i; i < body.length; ++i) {
            assertTrue(uint8(body[i]) >= 0x20 && uint8(body[i]) <= 0x7e, "printable ASCII only");
        }
        bytes memory prefix = new bytes(keep);
        for (uint256 i; i < keep; ++i) prefix[i] = name[i];
        assertEq(_unescape(body), prefix, "unescaped, it is the name exactly");

        // The same escaped text dropped into a double- or single-quoted attribute stays inside it.
        string memory attr = string.concat('<text data-n="', string(body), "\" data-m='", string(body), "'>");
        assertEq(_count(attr, 0x22), 2);
        assertEq(_count(attr, 0x27), 2);
        // And the card holds exactly its template's tags.
        assertEq(_count(svg, 0x3c), _count(_card(2), 0x3c));
    }

    function _count(string memory s, bytes1 c) internal pure returns (uint256 n) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == c) ++n;
        }
    }

    /// @dev The org header is escaped the same way (an org name may hold HTML characters: `A & B` is a name).
    function test_theOrgHeaderIsEscaped() public {
        vm.prank(alice);
        MockOrgCollection o2 = MockOrgCollection(factory.createOrg("<b> & 'q' \"z\"", "", bytes32(0)));
        (, bytes memory d) = factory.card().render(address(o2), 0, "image");
        assertEq(_between(string(d), 'font-size="13" letter-spacing="3">'), "&lt;b&gt; &amp; &#39;q&#39; &quot;z&quot;");
    }

    // ─── The scratch branch cases (audit-renderers/Branches.t.sol) ───────────

    /// @dev A `bytes` answer whose declared length runs past the buffer reads as unset for the name and the header; a
    ///      reverting hook leaves "Unknown" and zero versions.
    function test_anOverDeclaredLengthIsUnset() public {
        BranchesRaw tok = new BranchesRaw();
        tok.set(abi.encodePacked(uint256(0x20), uint256(1000), bytes32("abc")));
        BranchesRevert hostile = new BranchesRevert();
        ProjectCard card = new ProjectCard(address(hostile));
        ProjectTraits traits = new ProjectTraits(address(hostile));
        (, bytes memory svg) = card.render(address(tok), 1, "image");
        assertTrue(string(svg).contains(">untitled</text>"), "name: over-declared reads as unset");
        assertTrue(string(svg).contains('letter-spacing="3">ABX FS</text>'), "org: over-declared reads as unset");
        (, bytes memory j) = traits.render(address(tok), 1, "attributes");
        assertTrue(string(j).contains('"Named","value":"No"'));
        assertTrue(string(j).contains('"Root Kind","value":"Unknown"'), "reverting hook");
        assertTrue(string(j).contains('"Versions","display_type":"number","value":0'));
    }

    /// @dev The hook reverts while the token reports a published CID: the card is published, at "v0".
    function test_aRevertingHookLeavesAPublishedCardAtV0() public {
        BranchesRaw tok = new BranchesRaw();
        tok.set(abi.encode(bytes32(uint256(0xabcdef) << 232), false, true));
        ProjectCard card = new ProjectCard(address(new BranchesRevert()));
        (, bytes memory svg) = card.render(address(tok), 1, "image");
        assertTrue(string(svg).contains(">v0  0xabcdef"), "published card with v0 when the hook cannot answer");
    }

    // ─── The links rule, checked in place ────────────────────────────────────

    /// @dev The rule as the contract notes state it, written plainly: `https://` + 1..504 visible ASCII bytes with none
    ///      of the refused characters, at most 512 in all.
    function _usable(bytes memory b) internal pure returns (bool) {
        if (b.length < 9 || b.length > 512) return false;
        bytes memory scheme = "https://";
        for (uint256 i; i < 8; ++i) {
            if (b[i] != scheme[i]) return false;
        }
        bytes memory refused = "\"&'()<>[\\]^`{|}";
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x21 || c > 0x7e) return false;
            for (uint256 k; k < refused.length; ++k) {
                if (b[i] == refused[k]) return false;
            }
        }
        return true;
    }

    /// @dev R-gas1: the in-place check agrees with the plain rule on arbitrary values, and a usable value is returned
    ///      byte for byte.
    function testFuzz_theInPlaceCheckIsThePlainRule(bytes calldata tail, uint8 pick) public {
        bytes memory v = pick % 3 == 0 ? tail : bytes.concat("https://", tail);
        if (pick % 7 == 0 && v.length > 9) v[9] = bytes1(uint8(pick)); // a byte anywhere, often a refused one
        if (v.length > 600) return;
        MockAbxToken t = new MockAbxToken(address(0));
        t.forceData(1, KEY_VIEW, v);
        ProjectLinks links = factory.links();
        (, bytes memory got) = links.render(address(t), 1, "animation_url");
        if (_usable(v)) {
            assertEq(got, v);
        } else {
            assertTrue(string(got).startsWith(string.concat(BASE, "/g/p/")), "the default");
        }
    }

    /// @dev R-I1: the collection surface is the site root for both link fields.
    function test_theCollectionSurfaceLinksToTheSite() public view {
        (, bytes memory a) = factory.links().render(address(org), type(uint256).max, "animation_url");
        (, bytes memory e) = factory.links().render(address(org), type(uint256).max, "external_url");
        assertEq(string(a), BASE);
        assertEq(string(e), BASE);
    }
}

/// @dev Answers every call with fixed raw bytes.
contract BranchesRaw {
    bytes public r;

    function set(bytes calldata b) external {
        r = b;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return r;
    }
}

contract BranchesRevert {
    fallback() external {
        revert("no");
    }
}
