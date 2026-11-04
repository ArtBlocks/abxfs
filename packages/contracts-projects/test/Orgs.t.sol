// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgComponents} from "../script/OrgComponents.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";
import {AbxContractField, AbxInitParams} from "../src/interfaces/IAbxOrgDeploy.sol";

import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection, MockRegistry} from "./mocks/AbxMocks.sol";

/// @dev The factory against a stand-in for ABX. What it proves is the factory's own logic and its
///      ordering: that wiring, locks and renounce happen, that the org is registered before its first
///      mint, and that nothing the admin can do reaches a project. That the real ABX behaves the way
///      the mock does is the fork test's job.
contract OrgsTest is Test {
    using LibString for string;

    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxFactory internal abxFactory;
    OrgFactory internal factory;
    ProjectHook internal hook;
    ProjectEnumeration internal enumeration;
    OrgMinter internal minter;
    Lens internal lens;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    string internal constant GATEWAY = "https://fs.abx.io";
    address internal constant RENDERER = address(0xBEEF01);
    address internal constant SEED = address(0xBEEF02);
    bytes32 internal constant DIR_A = keccak256("dir-a");
    bytes32 internal constant DIR_B = keccak256("dir-b");
    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_META = "abxfs.meta";

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        abxFactory = new MockAbxFactory();
        factory = OrgComponents.create(address(abxFactory), RENDERER, SEED, address(dirStore), address(fileStore), address(new OrgMeta(GATEWAY)));
        hook = factory.hook();
        enumeration = factory.enumeration();
        minter = factory.minter();
        lens = new Lens(address(factory), address(hook));
        dirStore.add(DIR_A);
        dirStore.add(DIR_B);
    }

    function _create(address who, string memory name) internal returns (MockOrgCollection org) {
        vm.prank(who);
        org = MockOrgCollection(factory.createOrg(name, "", bytes32(0)));
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────

    function test_createOrg_leavesNothingMutable() public {
        MockOrgCollection org = _create(alice, "Acme");

        assertEq(org.owner(), address(0), "renounced");
        assertEq(org.name(), "Acme");
        assertEq(org.symbol(), "ABXFS");
        assertEq(org.minter(), address(minter));
        assertEq(org.maxInvocations(), 1_000_000);
        assertFalse(org.paused());
        assertEq(org.royaltyBps(), 0);
        assertEq(org.maxRoyaltyBps(), 0, "cap of zero: the rate can never rise");
        assertEq(org.transferValidator(), address(0));
        assertEq(org.seedSource(), SEED);

        assertEq(org.configureHook(), address(hook));
        assertEq(org.transferHook(), address(enumeration));
        assertTrue(org.paramHooksLocked());
        assertTrue(org.tokenURILocked());
        assertTrue(org.contractURILocked());
        assertTrue(org.scriptLocked());
        assertTrue(org.dependenciesLocked());
    }

    function test_createOrg_declaresTheFiveKeys() public {
        MockOrgCollection org = _create(alice, "Acme");
        assertEq(org.schemaLength(), 5);
        bytes32[5] memory keys =
            [bytes32("abxfs.cid"), "abxfs.gateway", "abxfs.name", "abxfs.view", "abxfs.meta"];
        for (uint256 i; i < 5; ++i) {
            assertEq(org.schemaAt(i).key, keys[i]);
            assertEq(org.schemaAt(i).auth, 1, "TokenOwner");
        }
        assertEq(org.schemaAt(0).paramType, 2, "cid is a Uint256Range scalar, not a blob");
        assertEq(org.schemaAt(1).paramType, 7);
        assertEq(org.schemaAt(3).paramType, 7);
        assertEq(org.schemaAt(4).paramType, 7);
    }

    function test_createOrg_wiresTheRenderers() public {
        MockOrgCollection org = _create(alice, "Acme");
        // Four here, then `name` (OrgMeta), then `description` only when one was given.
        assertEq(org.contractFieldCount(), 5);
        AbxContractField memory image = org.contractFieldAt(0);
        AbxContractField memory attrs = org.contractFieldAt(1);
        AbxContractField memory anim = org.contractFieldAt(2);
        AbxContractField memory ext = org.contractFieldAt(3);
        assertEq(anim.field, bytes32("animation_url"));
        assertEq(ext.field, bytes32("external_url"));
        assertEq(abi.decode(anim.value, (address)), address(factory.links()));
        assertEq(abi.decode(ext.value, (address)), address(factory.links()));
        assertEq(image.field, bytes32("image"));
        assertEq(image.representation, bytes32("renderer"));
        assertEq(abi.decode(image.value, (address)), address(factory.card()));
        assertEq(attrs.field, bytes32("attributes"));
        assertEq(abi.decode(attrs.value, (address)), address(factory.traits()));
    }

    function test_orderingMattersTheFirstMintIsIndexed() public {
        MockOrgCollection org = _create(alice, "Acme");
        // The mint happened after the hooks were wired, so the enumeration hook saw it.
        assertEq(org.ownerOf(0), alice);
        assertEq(enumeration.trackedOwnerOf(address(org), 0), alice);
        assertEq(enumeration.tokensOfOwner(address(org), alice).length, 1);
        assertEq(enumeration.orgsHeldBy(alice).length, 1, "and the org-held index too");
        assertEq(enumeration.orgsHeldBy(alice)[0], address(org));
    }

    // ─── Registry ────────────────────────────────────────────────────────────

    function test_registry() public {
        vm.expectEmit(false, true, true, false, address(factory));
        emit IOrgFactory.OrgCreated(address(0), alice, 0, "Acme", 0);
        MockOrgCollection a = _create(alice, "Acme");
        MockOrgCollection b = _create(bob, "Bobco");

        assertTrue(factory.isOrg(address(a)));
        assertTrue(factory.isOrg(address(b)));
        assertFalse(factory.isOrg(address(0xdead)));
        assertEq(factory.orgCount(), 2);
        assertEq(factory.orgAt(0), address(a));
        assertEq(factory.orgAt(1), address(b));
        assertEq(factory.createdBlockOf(address(a)), uint64(block.number));
        assertEq(factory.adminOf(address(a)), alice);

        address[] memory page = factory.orgsSlice(1, 10);
        assertEq(page.length, 1);
        assertEq(page[0], address(b));
        assertEq(factory.orgsSlice(5, 1).length, 0, "overrun clamps");

        assertEq(factory.orgsAdministered(alice).length, 1);
        assertEq(factory.orgsAdministeredCount(bob), 1);
    }

    function test_nameBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        factory.createOrg("", "", bytes32(0));
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        factory.createOrg(_ascii(65, "a"), "", bytes32(0));
        factory.createOrg(_ascii(64, "a"), "", bytes32(0));
        vm.stopPrank();
    }

    function _ascii(uint256 n, bytes1 c) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = c;
        return string(b);
    }

    function _refuse(bytes memory name_) internal {
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        factory.createOrg(string(name_), "", bytes32(0));
    }

    /// @dev Printable ASCII only. Every other class is refused, wherever it sits in the name.
    function test_nameRefusesEveryNonPrintableClass() public {
        _refuse(hex"00"); // NUL
        _refuse(hex"6100"); // trailing NUL
        _refuse(hex"610062"); // embedded NUL
        for (uint256 c; c < 0x20; ++c) _refuse(abi.encodePacked("a", bytes1(uint8(c)), "b")); // controls, \n \t \r included
        _refuse(hex"617f62"); // DEL
        _refuse(hex"7f");
        _refuse(unicode"é"); // UTF-8
        _refuse(unicode"aБb");
        _refuse(unicode"BAM\u200bFS"); // zero-width space
        _refuse(hex"e280ae42414d4653"); // bidi override
        _refuse(hex"41ff42"); // invalid UTF-8
        _refuse(hex"80"); // lone continuation byte
        _refuse(hex"c0af"); // overlong
        _refuse(hex"eda080"); // UTF-16 surrogate encoded in UTF-8
    }

    function test_nameRefusesBlankAndOutOfRange() public {
        _refuse(""); // 0 bytes
        _refuse(" "); // all spaces
        _refuse(bytes(_ascii(64, " "))); // 64 spaces
        _refuse(bytes(_ascii(65, "a"))); // 65 bytes
        _refuse(bytes(_ascii(200, "a")));
    }

    function test_nameAcceptsTheWholePrintableRange() public {
        // 64 valid bytes, every printable ASCII value present across a few orgs.
        vm.startPrank(alice);
        for (uint256 start; start < 95; start += 31) {
            bytes memory b = new bytes(64);
            for (uint256 i; i < 64; ++i) b[i] = bytes1(uint8(0x20 + ((start + i) % 95)));
            b[0] = "x"; // never blank
            address org = address(factory.createOrg(string(b), "", bytes32(0)));
            assertEq(MockOrgCollection(org).name(), string(b));
        }
        // Surrounding spaces are fine as long as something is visible.
        factory.createOrg(" a ", "", bytes32(0));
        factory.createOrg("<script>\"\\'&", "", bytes32(0));
        factory.createOrg(_ascii(64, "~"), "", bytes32(0));
        vm.stopPrank();
    }

    function testFuzz_nameAcceptedIffPrintableAsciiWithAVisibleByte(bytes calldata name_) public {
        bool ok = name_.length >= 1 && name_.length <= 64;
        bool visible;
        for (uint256 i; ok && i < name_.length; ++i) {
            uint8 c = uint8(name_[i]);
            if (c < 0x20 || c > 0x7e) ok = false;
            if (c != 0x20) visible = true;
        }
        ok = ok && visible;
        vm.prank(alice);
        if (!ok) vm.expectRevert(IOrgFactory.InvalidName.selector);
        factory.createOrg(string(name_), "", bytes32(0));
    }

    /// @dev Owner decision: delegate.xyz delegates are never the token owner. Proven on the real ABX in
    ///      `fork/OrgPolicyFork.t.sol`; here, that the factory asks for it.
    function test_orgsAreCreatedWithTokenOwnerDelegationDisabled() public {
        MockOrgCollection org = _create(alice, "Acme");
        assertTrue(org.delegationDisabled());
    }

    function test_predictOrgOfZeroRevertsAndOtherSaltsDoNot() public {
        vm.expectRevert(IOrgFactory.NoDeterministicAddress.selector);
        factory.predictOrg(bytes32(0));
        factory.predictOrg(bytes32(uint256(1)));
        factory.predictOrg(bytes32(abi.encodePacked(alice, uint96(1))));
    }

    function test_salt_rules() public {
        // First 20 bytes name somebody else: refused.
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.SaltSenderMismatch.selector);
        factory.createOrg("x", "", bytes32(abi.encodePacked(bob, uint96(1))));

        // Zero prefix: anyone may use it. Own prefix: allowed.
        vm.prank(alice);
        factory.createOrg("x", "", bytes32(uint256(7)));
        vm.prank(alice);
        factory.createOrg("y", "", bytes32(abi.encodePacked(alice, uint96(7))));

        // ABX only accepts a salt whose prefix is the factory, so that is what it was handed.
        assertEq(address(bytes20(abxFactory.lastSalt())), address(factory));
    }

    // ─── Mint rules ──────────────────────────────────────────────────────────

    function test_adminOnlyByDefault() public {
        MockOrgCollection org = _create(alice, "Acme");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrgMinter.NotAllowed.selector, address(org), bob));
        minter.mint(address(org), bob);

        // Nobody can bypass the minter: the collection has no owner left and bob is not the minter.
        vm.prank(bob);
        vm.expectRevert(MockOrgCollection.NotMinterOrOwner.selector);
        org.mint(bob);
        vm.prank(alice);
        vm.expectRevert(MockOrgCollection.NotMinterOrOwner.selector);
        org.mint(alice);

        vm.prank(alice);
        uint256 id = minter.mint(address(org), bob);
        assertEq(org.ownerOf(id), bob, "the recipient owns what the admin minted");
    }

    function test_mintRulesAreAdminOnly() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotAdmin.selector, address(org), bob));
        factory.setOpen(address(org), true);
    }

    function test_onlyTheAdminMintsUntilOpened() public {
        MockOrgCollection org = _create(alice, "Acme");

        vm.prank(bob);
        vm.expectRevert();
        minter.mint(address(org), bob);

        vm.prank(alice);
        factory.setOpen(address(org), true);
        assertTrue(factory.isOpen(address(org)));
        vm.prank(carol);
        minter.mint(address(org), carol);

        vm.prank(alice);
        factory.setOpen(address(org), false);
        vm.prank(carol);
        vm.expectRevert();
        minter.mint(address(org), carol);
    }

    function test_cannotMintIntoAnUnregisteredCollection() public {
        MockOrgCollection stranger = new MockOrgCollection(
            // minimal params; the minter is wired to the factory, which has never heard of this one
            _bareParams()
        );
        vm.prank(alice);
        vm.expectRevert();
        minter.mint(address(stranger), alice);
    }

    function _bareParams() internal view returns (AbxInitParams memory p) {
        p.owner = alice;
        p.minter = address(minter);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function test_adminTransferIsTwoStep() public {
        MockOrgCollection org = _create(alice, "Acme");

        vm.prank(alice);
        factory.transferAdmin(address(org), bob);
        assertEq(factory.adminOf(address(org)), alice, "nothing changes until accepted");
        assertEq(factory.pendingAdminOf(address(org)), bob);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, address(org), carol));
        factory.acceptAdmin(address(org));

        vm.prank(bob);
        factory.acceptAdmin(address(org));
        assertEq(factory.adminOf(address(org)), bob);
        assertEq(factory.pendingAdminOf(address(org)), address(0));
        assertEq(factory.orgsAdministered(alice).length, 0);
        assertEq(factory.orgsAdministered(bob)[0], address(org));

        // The old admin has lost every power, including over mint rules.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotAdmin.selector, address(org), alice));
        factory.setOpen(address(org), true);
        vm.prank(alice);
        vm.expectRevert();
        minter.mint(address(org), alice);
    }

    // ─── A handover is how an org recovers from a compromised admin ──────────

    /// @dev An org the old admin opened must not stay open after the role moves, or migrating to a
    ///      clean wallet would leave the door the compromised key opened.
    function test_handoverClosesTheOrg() public {
        MockOrgCollection org = _create(alice, "Acme");

        vm.startPrank(alice);
        factory.setOpen(address(org), true);
        factory.transferAdmin(address(org), carol);
        vm.stopPrank();

        // Nothing changes until the offer is accepted.
        assertTrue(factory.isOpen(address(org)));

        vm.prank(carol);
        factory.acceptAdmin(address(org));

        assertFalse(factory.isOpen(address(org)), "closed");
        // The old admin and a bystander can no longer mint; the new admin can.
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            assertFalse(factory.mayMint(address(org), who));
            vm.prank(who);
            vm.expectRevert();
            minter.mint(address(org), who);
        }
        vm.prank(carol);
        minter.mint(address(org), carol);
    }

    function test_handoverEmitsWhatChanged() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.startPrank(alice);
        factory.setOpen(address(org), true);
        factory.transferAdmin(address(org), bob);
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(bob);
        factory.acceptAdmin(address(org));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 openSet = keccak256("OpenSet(address,bool)");
        bytes32 transferred = keccak256("AdminTransferred(address,address,address)");
        bool sawOpen;
        bool sawTransfer;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == openSet) sawOpen = true;
            if (logs[i].topics[0] == transferred) sawTransfer = true;
        }
        assertTrue(sawOpen && sawTransfer, "indexers see the close, not only a role change");
    }

    /// @dev An offer that is never accepted changes nothing: the rules are untouched until it is.
    function test_anUnacceptedOfferLeavesTheRulesAlone() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.startPrank(alice);
        factory.setOpen(address(org), true);
        factory.transferAdmin(address(org), carol);
        factory.transferAdmin(address(org), address(0)); // withdrawn
        vm.stopPrank();
        assertTrue(factory.isOpen(address(org)));
        assertEq(factory.adminOf(address(org)), alice);
    }

    function test_adminOfferCanBeWithdrawn() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.startPrank(alice);
        factory.transferAdmin(address(org), bob);
        factory.transferAdmin(address(org), address(0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert();
        factory.acceptAdmin(address(org));
    }

    function test_adminListSwapAndPop() public {
        MockOrgCollection a = _create(alice, "A");
        MockOrgCollection b = _create(alice, "B");
        MockOrgCollection c = _create(alice, "C");
        vm.prank(alice);
        factory.transferAdmin(address(a), bob);
        vm.prank(bob);
        factory.acceptAdmin(address(a));

        address[] memory left = factory.orgsAdministered(alice);
        assertEq(left.length, 2);
        assertEq(left[0], address(c), "last moved into the gap");
        assertEq(left[1], address(b));

        // And the moved entry's position is still right: move it out again.
        vm.prank(alice);
        factory.transferAdmin(address(c), carol);
        vm.prank(carol);
        factory.acceptAdmin(address(c));
        assertEq(factory.orgsAdministered(alice).length, 1);
        assertEq(factory.orgsAdministered(alice)[0], address(b));
    }

    function test_adminHasNoPowerOverAProject() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.prank(alice);
        uint256 id = minter.mint(address(org), bob); // alice administers; bob owns the project
        dirStore.add(DIR_A);

        // The admin cannot publish to it. Authority is ownerOf, and nothing else.
        vm.prank(alice);
        vm.expectRevert(bytes("NotParamAuthorized"));
        org.configureTokenParam(id, KEY_CID, DIR_A);

        vm.prank(bob);
        org.configureTokenParam(id, KEY_CID, DIR_A);
        assertEq(hook.versionCount(address(org), id), 1);
    }

    // ─── The global ledger, and the lens ─────────────────────────────────────

    function test_publishEntersTheGlobalLedger() public {
        MockOrgCollection a = _create(alice, "A");
        MockOrgCollection b = _create(bob, "B");

        vm.prank(alice);
        a.configureTokenParam(0, KEY_CID, DIR_A);
        vm.prank(bob);
        b.configureTokenParam(0, KEY_CID, DIR_A);
        vm.prank(alice);
        a.configureTokenParam(0, KEY_CID, DIR_B);

        assertEq(hook.globalPublishCount(), 3);
        (address org0, uint256 idx0) = hook.globalPublishAt(0);
        (address org1,) = hook.globalPublishAt(1);
        (address org2, uint256 idx2) = hook.globalPublishAt(2);
        assertEq(org0, address(a));
        assertEq(idx0, 0);
        assertEq(org1, address(b));
        assertEq(org2, address(a));
        assertEq(idx2, 1, "the second publish of org A");

        Lens.Published[] memory page = lens.publishRange(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].org, address(b));
        assertEq(page[0].record.cid, DIR_A);
        assertEq(page[1].org, address(a));
        assertEq(page[1].record.cid, DIR_B);
        assertEq(page[1].record.version, 2);
        assertEq(lens.publishRange(9, 1).length, 0, "overrun clamps");

        vm.expectRevert();
        hook.globalPublishAt(3);
    }

    function test_anUnregisteredCollectionNeverEntersTheGlobalLedger() public {
        MockAbxToken forged = new MockAbxToken(address(hook));
        forged.setOwner(1, alice);
        vm.prank(alice);
        forged.configure(1, KEY_CID, DIR_A);

        assertEq(hook.versionCount(address(forged), 1), 1, "its own namespace works");
        assertEq(hook.publishCount(address(forged)), 1);
        assertEq(hook.globalPublishCount(), 0, "but it cannot write into the shared feed");
    }

    function test_lensResolve() public {
        MockOrgCollection org = _create(alice, "Acme");
        vm.prank(alice);
        org.configureTokenParam(0, KEY_CID, DIR_A);

        Lens.Resolution memory r = lens.resolve(address(org), 0);
        assertTrue(r.registered);
        assertEq(uint8(r.kind), uint8(IProjectHook.ContentKind.Directory));
        assertEq(r.cid, DIR_A);
        assertEq(r.owner, alice);
        assertEq(r.gateway.length, 0);
    }

    function test_lensNeverCallsAnUnregisteredAddress() public {
        // An address that reverts on every call: an unregistered org must not be asked anything.
        Lens.Resolution memory r = lens.resolve(address(this), 0);
        assertFalse(r.registered);
        assertEq(r.cid, bytes32(0));
    }

    /// @dev Measured, not estimated. Same token code, same hook code, same starting state — restored
    ///      with a snapshot so one run does not inherit the other's warm storage — differing only in
    ///      whether the registry knows the collection. The first publish into an empty ledger pays to
    ///      initialise the array; the second is the steady state every later publish pays.
    function _publishGas(bool registered) internal returns (uint256 first, uint256 second) {
        MockRegistry reg = new MockRegistry();
        ProjectHook h = new ProjectHook(address(dirStore), address(fileStore), address(reg));
        MockAbxToken t = new MockAbxToken(address(h));
        t.setOwner(1, alice);
        t.setOwner(2, alice);
        reg.set(address(t), registered);

        vm.startPrank(alice);
        uint256 g = gasleft();
        t.configure(1, KEY_CID, DIR_A);
        first = g - gasleft();
        g = gasleft();
        t.configure(2, KEY_CID, DIR_A);
        second = g - gasleft();
        vm.stopPrank();
        assertEq(h.globalPublishCount(), registered ? 2 : 0);
    }

    function test_globalLedgerGasOverhead() public {
        uint256 snap = vm.snapshotState();
        (uint256 first0, uint256 second0) = _publishGas(false);
        vm.revertToState(snap);
        (uint256 first1, uint256 second1) = _publishGas(true);

        console2.log("first publish into an empty ledger adds :", first1 - first0);
        console2.log("every later publish adds                :", second1 - second0);
        console2.log("a later publish costs, in total         :", second1);
        assertLt(first1 - first0, 50_000);
        assertLt(second1 - second0, 32_000);
    }

    // ─── The link fields ─────────────────────────────────────────────────────

    function test_linksAreAPureFunctionOfChainOrgAndId() public {
        MockOrgCollection org = _create(alice, "Acme");
        string memory addr = LibString.toHexString(address(org));
        (string memory ct, bytes memory anim) = factory.links().render(address(org), 7, "animation_url");
        assertEq(ct, "text/uri-list");
        assertEq(
            string(anim),
            string.concat("https://fs.abx.io/g/p/", vm.toString(block.chainid), "/", addr, "/7/latest/")
        );
        (, bytes memory ext) = factory.links().render(address(org), 7, "external_url");
        assertEq(
            string(ext),
            string.concat("https://fs.abx.io/projects/", vm.toString(block.chainid), "/", addr, "/7")
        );
    }

    /// @dev The URL must be one the gateway accepts: lowercase address, no trailing surprises.
    function test_theLinkAddressIsLowercaseSoItMatchesTheGatewayFilter() public {
        MockOrgCollection org = _create(alice, "Acme");
        (, bytes memory anim) = factory.links().render(address(org), 1, "animation_url");
        string memory s = string(anim);
        assertEq(s, LibString.lower(s));
        assertTrue(s.contains("0x"));
    }

    /// @dev Never reverts: the collection surface, an unknown field, a no-code token, the largest id.
    function test_linksNeverRevert() public view {
        factory.links().render(address(0xdead), type(uint256).max, "animation_url");
        factory.links().render(address(0xdead), type(uint256).max - 1, "external_url");
        factory.links().render(address(0), 0, "image");
        (, bytes memory none) = factory.links().render(address(0xdead), 3, "nothing");
        assertEq(none.length, 0, "an unknown field is an empty URL, not an error");
    }

    /// @dev The collection surface has no project: both links are the site itself, never the org's own page, which is
    ///      reached by direct link only (the site links it from nowhere).
    function test_theCollectionSurfacePointsAtTheSiteNotTheOrgPage() public {
        MockOrgCollection org = _create(alice, "Acme");
        (, bytes memory page) = factory.links().render(address(org), type(uint256).max, "animation_url");
        assertEq(string(page), "https://fs.abx.io");
        (, page) = factory.links().render(address(org), type(uint256).max, "external_url");
        assertEq(string(page), "https://fs.abx.io");
        assertFalse(string(page).contains("/orgs/"));
    }

    /// @dev Forge does not enforce EIP-3860's 49,152-byte initcode limit, so a factory that outgrew it
    ///      would pass every test here and fail to deploy. The constructor arguments are 192 bytes.
    function test_factoryInitcodeFitsTheDeployLimit() public pure {
        // Constructor args: six addresses. The gateway base is OrgMeta's argument now, not this one's.
        bytes memory args = abi.encode(address(1), address(2), address(3), address(4), address(5), address(6));
        uint256 total = type(OrgFactory).creationCode.length + args.length;
        assertLe(total, 49_152, "over the EIP-3860 initcode limit");
        // Fail while there is still room to decide what to do, not on the byte it overflows.
        assertGe(49_152 - total, 400, "factory initcode headroom is below 400 bytes: stop adding to it");
    }

    // ─── The owner's own view URL (abxfs.view) ───────────────────────────────

    /// @dev Set `abxfs.view` on token 0 of a fresh org (owned by alice) and read both link fields.
    function _links(string memory url) internal returns (string memory anim, string memory ext) {
        MockOrgCollection org = _create(alice, "Acme");
        vm.prank(alice);
        org.configureTokenParamData(0, "abxfs.view", bytes(url));
        (, bytes memory a) = factory.links().render(address(org), 0, "animation_url");
        (, bytes memory e) = factory.links().render(address(org), 0, "external_url");
        return (string(a), string(e));
    }

    function _defaults() internal returns (string memory anim, string memory ext) {
        MockOrgCollection org = _create(alice, "Acme");
        (, bytes memory a) = factory.links().render(address(org), 0, "animation_url");
        (, bytes memory e) = factory.links().render(address(org), 0, "external_url");
        return (string(a), string(e));
    }

    /// @dev Both fields are exactly the owner's URL: nothing is appended, so no path shape is assumed.
    function test_viewOverridesBothFieldsVerbatim() public {
        string memory url = "https://my-site.example/app?x=1#top";
        (string memory anim, string memory ext) = _links(url);
        assertEq(anim, url);
        assertEq(ext, url);
    }

    function test_unsetViewFallsBackToTheDefault() public {
        (string memory anim, string memory ext) = _defaults();
        assertTrue(anim.contains("/g/p/"));
        assertTrue(ext.contains("/projects/"));
    }

    /// @dev The owner writes this, and it flows into a URL a marketplace dereferences or embeds. Each of
    ///      these must read as unset, never be emitted, and never revert.
    function test_unusableViewValuesFallBackToTheDefault() public {
        string[14] memory bad = [
            "https://a.example/x'onerror='y", // closes a single-quoted HTML attribute
            "https://a.example/?a=1&b=2", // starts an entity / second parameter
            "http://insecure.example", // not https
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "HTTPS://upper.example", // scheme compared case-sensitively
            "https://", // nothing after the scheme
            'https://a.example/"onload="x', // would end a JSON string
            "https://a.example/\\x",
            "https://a.example/<script>",
            "https://a.example/ space",
            "https://a.example/`x",
            "ftp://a.example",
            ""
        ];
        for (uint256 i; i < bad.length; ++i) {
            (string memory anim, string memory ext) = _links(bad[i]);
            assertTrue(anim.startsWith("https://fs.abx.io/g/p/"), bad[i]);
            assertTrue(ext.startsWith("https://fs.abx.io/projects/"), bad[i]);
        }
    }

    /// @dev `'` (0x27) and `&` (0x26) are refused on their own, anywhere in the value, and the
    ///      neighbouring bytes either side of them are not caught by the same mask.
    function test_quoteAndAmpersandAreRefusedAndTheirNeighboursAreNot() public {
        (string memory a1,) = _links("https://a.example/'");
        (string memory a2,) = _links("https://a.example/&");
        assertTrue(a1.startsWith("https://fs.abx.io/g/p/"));
        assertTrue(a2.startsWith("https://fs.abx.io/g/p/"));
        // 0x25 `%`, 0x3d `=`, `?`, `#`, `;`, `,`, `@`, `!`, `$`, `*`, `+`, `~` stay legal; a parenthesis is written
        // percent-encoded.
        string memory ok = "https://a.example/@p%20q%281%29?x=1;y=2,z!$*+~#f";
        (string memory b,) = _links(ok);
        assertEq(b, ok);
        // The raw parenthesis is refused, like every character that can end a Markdown link or a CSS `url()`.
        (string memory c,) = _links("https://a.example/p(1)");
        assertTrue(c.startsWith("https://fs.abx.io/g/p/"));
    }

    function test_nonAsciiViewFallsBackWholeRatherThanBeingPartlyEmitted() public {
        (string memory anim,) = _links(unicode"https://exämple.test/");
        assertTrue(anim.startsWith("https://fs.abx.io/g/p/"));
    }

    function test_viewAtTheCapIsUsedAndOneOverIsNot() public {
        bytes memory atCap = new bytes(512);
        bytes memory prefix = bytes("https://a.example/");
        for (uint256 i; i < 512; ++i) atCap[i] = i < prefix.length ? prefix[i] : bytes1("a");
        (string memory anim,) = _links(string(atCap));
        assertEq(bytes(anim).length, 512);

        // The hook refuses a value over the cap before it is ever stored, so this is reached by a
        // collection whose hook is not ours; the renderer must refuse it too.
        MockOrgCollection org = _create(alice, "Acme");
        HostileView h = new HostileView(513);
        (, bytes memory over) = factory.links().render(address(h), 1, "animation_url");
        assertTrue(string(over).contains("/g/p/"), "over the cap reads as unset");
        org; // silence
    }

    /// @dev A token that answers with garbage, reverts, or has no code must not brick tokenURI.
    function test_viewReadNeverReverts() public {
        factory.links().render(address(0xdead), 1, "animation_url"); // no code
        factory.links().render(address(new HostileView(0)), 1, "animation_url");
        factory.links().render(address(new HostileView(1)), 1, "external_url");
        factory.links().render(address(new HostileView(2)), 1, "animation_url");
        factory.links().render(address(new HostileView(3)), 1, "animation_url");
    }

    function test_hookPolicesTheSizeOfView() public {
        MockAbxToken t = new MockAbxToken(address(hook));
        t.setOwner(1, alice);
        vm.startPrank(alice);
        t.configureData(1, "abxfs.view", new bytes(512));
        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, bytes32("abxfs.view"), 513, 512)
        );
        t.configureData(1, "abxfs.view", new bytes(513));
        vm.stopPrank();
    }

    // ─── The reserved meta key ───────────────────────────────────────────────

    function test_metaKeyIsSizePolicedAndNothingElse() public {
        MockAbxToken t = new MockAbxToken(address(hook));
        t.setOwner(1, alice);
        vm.startPrank(alice);
        t.configureData(1, KEY_META, new bytes(4096));
        vm.expectRevert(
            abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, KEY_META, 4097, 4096)
        );
        t.configureData(1, KEY_META, new bytes(4097));
        // A key nobody has heard of is still ignored, never rejected.
        t.configureData(1, "abxfs.future", new bytes(100_000));
        vm.stopPrank();
    }

    // ─── The card carries the org's name ─────────────────────────────────────

    function test_cardHeaderIsTheOrgName() public {
        MockOrgCollection org = _create(alice, "Acme Studio");
        (, bytes memory svg) = factory.card().render(address(org), 0, "image");
        assertTrue(string(svg).contains("Acme Studio"));
    }

    function test_cardSanitizesAHostileOrgName() public {
        MockOrgCollection org = _create(alice, '<script>alert(1)</script>"&');
        (, bytes memory svg) = factory.card().render(address(org), 0, "image");
        assertFalse(string(svg).contains("<script>"));
    }

    function test_cardFallsBackWhenTheTokenHasNoName() public {
        MockAbxToken plain = new MockAbxToken(address(hook));
        (, bytes memory svg) = factory.card().render(address(plain), 1, "image");
        assertTrue(string(svg).contains(">ABX FS<"));
        // A no-code address, which a staticcall to succeeds against with empty returndata.
        factory.card().render(address(0xdead), 1, "image");
        factory.card().render(address(0xdead), type(uint256).max, "image");
    }
}

/// @dev A token whose `tokenParamData` misbehaves in each way a hostile or broken collection could.
contract HostileView {
    uint256 internal immutable _mode;

    constructor(uint256 mode) {
        _mode = mode;
    }

    fallback() external {
        if (_mode == 0) revert("boom");
        if (_mode == 1) return; // empty returndata
        if (_mode == 2) {
            // An offset that is not 0x20, with a length that runs past the buffer.
            assembly {
                mstore(0x00, 0x40)
                mstore(0x20, 0xffffffff)
                return(0x00, 0x40)
            }
        }
        if (_mode == 3) {
            // A valid-looking head with a huge declared length.
            assembly {
                mstore(0x00, 0x20)
                mstore(0x20, 513)
                return(0x00, 0x40)
            }
        }
    }
}
