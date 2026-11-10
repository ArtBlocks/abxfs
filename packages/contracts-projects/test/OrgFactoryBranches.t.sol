// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm, stdError} from "forge-std/Test.sol";

import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgComponents} from "../script/OrgComponents.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";
import {
    AbxInitParams,
    AbxContractField,
    AbxTokenField,
    IAbxOrgCollection,
    IAbxSeriesCodeFactory
} from "../src/interfaces/IAbxOrgDeploy.sol";

import {MockStore} from "./mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection} from "./mocks/AbxMocks.sol";
import {RawStub, CallRecorder} from "./mocks/Hostile.sol";

/// @dev An ABX factory whose "clone" is whatever the test says, so an org can be backed by a scripted contract (or by
///      one that answers nothing). `predictDeterministicAddress` echoes its salt, so a test can read what the factory
///      derived.
contract FakeAbxFactory {
    address public next;
    bytes32 public lastSalt;
    /// @dev The whole calldata of the last `deploy` / `deployDeterministic`: every parameter the org was created with.
    bytes public lastDeployCall;

    function setNext(address a) external {
        next = a;
    }

    function deploy(AbxInitParams calldata) external returns (address) {
        lastDeployCall = msg.data;
        return next;
    }

    function deployDeterministic(AbxInitParams calldata, bytes32 salt) external returns (address) {
        lastSalt = salt;
        lastDeployCall = msg.data;
        return next;
    }

    function predictDeterministicAddress(bytes32 salt) external pure returns (address) {
        return address(uint160(uint256(salt)));
    }
}

/// @dev The factory's registry, admin and mint-rule logic, one condition at a time.
contract OrgFactoryBranchesTest is Test {
    string internal constant GATEWAY = "https://fs.abx.io";
    address internal constant RENDERER = address(0xBEEF01);
    address internal constant SEED = address(0xBEEF02);
    address internal constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxFactory internal abxFactory;
    OrgMeta internal meta;
    OrgFactory internal factory;
    OrgMinter internal minter;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = address(0xDEAD);

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        abxFactory = new MockAbxFactory();
        meta = new OrgMeta(GATEWAY);
        factory = OrgComponents.create(address(abxFactory), RENDERER, SEED, address(dirStore), address(fileStore), address(meta));
        minter = factory.minter();
    }

    function _create(address who, string memory name) internal returns (address org) {
        vm.prank(who);
        org = factory.createOrg(name, "", bytes32(0));
    }

    // ─── componentsDeployed: every leg of the && chain ───────────────────────

    /// @dev The init code and CREATE2 address of component `k` (0 hook, 1 enumeration, 2 minter, 3 card, 4 traits).
    function _component(OrgFactory f, uint256 k) internal view returns (bytes memory initCode, address expected) {
        address hook = address(f.hook());
        if (k == 0) {
            return (
                abi.encodePacked(type(ProjectHook).creationCode, abi.encode(address(dirStore), address(fileStore), address(f))),
                hook
            );
        }
        if (k == 1) {
            return (abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(address(f))), address(f.enumeration()));
        }
        if (k == 2) return (abi.encodePacked(type(OrgMinter).creationCode, abi.encode(address(f))), address(f.minter()));
        if (k == 3) return (abi.encodePacked(type(ProjectCard).creationCode, abi.encode(hook)), address(f.card()));
        return (abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(hook)), address(f.traits()));
    }

    function _deployComponent(OrgFactory f, uint256 k) internal {
        (bytes memory initCode, address expected) = _component(f, k);
        (bool ok,) = DEPLOYER.call(abi.encodePacked(f.COMPONENT_SALT(), initCode));
        assertTrue(ok, "the keyless deployer deploys it");
        assertTrue(expected.code.length != 0, "and it lands where the factory said");
    }

    function test_createOrgNeedsEveryComponent_eachOneAlone() public {
        for (uint256 missing; missing < 5; ++missing) {
            OrgFactory f = new OrgFactory(address(abxFactory), RENDERER, SEED, address(dirStore), address(fileStore), address(meta), address(meta.links()));
            for (uint256 k; k < 5; ++k) {
                if (k != missing) _deployComponent(f, k);
            }
            assertFalse(f.componentsDeployed(), "four of five is not enough");
            vm.prank(alice);
            vm.expectRevert(IOrgFactory.ComponentsNotDeployed.selector);
            f.createOrg("Acme", "", bytes32(0));
            assertEq(f.orgCount(), 0, "nothing was registered");

            _deployComponent(f, missing);
            assertTrue(f.componentsDeployed());
            vm.prank(alice);
            address org = f.createOrg("Acme", "", bytes32(0));
            assertTrue(f.isOrg(org), "and the fifth makes it work");
        }
    }

    function test_noComponentsAtAll() public {
        OrgFactory f = new OrgFactory(address(abxFactory), RENDERER, SEED, address(dirStore), address(fileStore), address(meta), address(meta.links()));
        assertFalse(f.componentsDeployed());
        // Components are checked before the name: a bad name on a factory with no components says so second.
        vm.expectRevert(IOrgFactory.ComponentsNotDeployed.selector);
        f.createOrg("", "", bytes32(0));
    }

    function _freshFactory() internal returns (OrgFactory) {
        return new OrgFactory(address(abxFactory), RENDERER, SEED, address(dirStore), address(fileStore), address(meta), address(meta.links()));
    }

    /// @dev What the deploy helper does when a component cannot land where the factory said: the deployer is asked
    ///      and then the result is checked. Two ways to fail, each reported under the component's own name.
    function test_deployingAComponentThatLandsElsewhereIsRefusedByName() public {
        // The caller's idea of the stores differs from the factory's: the hook's init code (and so its address)
        // differs, the deployer succeeds, and nothing exists where the factory expects the hook.
        OrgFactory f = _freshFactory();
        vm.expectRevert(abi.encodeWithSelector(OrgComponents.ComponentDeployFailed.selector, "hook", address(f.hook())));
        this.deployWith(f, address(dirStore), address(0xBAD));
        assertEq(address(f.hook()).code.length, 0, "the revert undoes whatever the call deployed");
        assertFalse(f.componentsDeployed());

        // The expected address is occupied (a nonzero nonce is a CREATE2 collision), so the deployer itself fails.
        // The error is the same, and it is the component's own name: a later component is not blamed on an earlier one.
        string[5] memory names = ["hook", "enumeration", "minter", "card", "traits"];
        for (uint256 k; k < 5; ++k) {
            f = _freshFactory();
            (, address expected) = _component(f, k);
            vm.setNonce(expected, 1);
            vm.expectRevert(abi.encodeWithSelector(OrgComponents.ComponentDeployFailed.selector, names[k], expected));
            // A CREATE2 collision burns 63/64 of the gas it is forwarded, so the budget is bounded: with an unbounded
            // one the burn would eat the rest of the test. 20M covers every component deployed before the collision.
            this.deployWith{gas: 20_000_000}(f, address(dirStore), address(fileStore));
        }
    }

    /// @dev A component already in place is skipped, not redeployed (which would collide): deploying twice is fine,
    ///      and so is deploying after someone else deployed a part.
    function test_deployingComponentsIsIdempotentAndSkipsWhatExists() public {
        OrgFactory f = _freshFactory();
        _deployComponent(f, 2); // somebody else deployed the minter
        OrgComponents.deploy(f, address(dirStore), address(fileStore));
        assertTrue(f.componentsDeployed());
        OrgComponents.deploy(f, address(dirStore), address(fileStore));
        assertTrue(f.componentsDeployed());
    }

    /// @dev `OrgComponents.deploy` is an internal library function: this is its entry point from a test.
    function deployWith(OrgFactory f, address directoryStore, address fileStore_) external {
        OrgComponents.deploy(f, directoryStore, fileStore_);
    }

    // ─── The registry views ──────────────────────────────────────────────────

    function test_viewsOfAnAddressThatIsNotAnOrg() public view {
        assertFalse(factory.isOrg(stranger));
        assertFalse(factory.isOrg(address(0)));
        assertFalse(factory.isOrg(address(factory)));
        assertEq(factory.adminOf(stranger), address(0));
        assertEq(factory.createdBlockOf(stranger), 0);
        assertFalse(factory.isOpen(stranger));
        assertEq(factory.pendingAdminOf(stranger), address(0));
        assertEq(factory.orgCount(), 0);
        assertEq(factory.orgsAdministered(alice).length, 0);
        assertEq(factory.orgsAdministeredCount(alice), 0);
        assertEq(factory.orgsSlice(0, 10).length, 0);
    }

    function test_orgAtOutOfRangeIsAPanic() public {
        vm.expectRevert(stdError.indexOOBError);
        factory.orgAt(0);
        address org = _create(alice, "Acme");
        assertEq(factory.orgAt(0), org);
        vm.expectRevert(stdError.indexOOBError);
        factory.orgAt(1);
        vm.expectRevert(stdError.indexOOBError);
        factory.orgAt(type(uint256).max);
    }

    function test_orgsSliceAtEveryEdge() public {
        address[3] memory orgs = [_create(alice, "A"), _create(bob, "B"), _create(carol, "C")];
        uint256[2][9] memory q = [
            [uint256(0), 0],
            [uint256(0), 3],
            [uint256(0), 9],
            [uint256(1), 1],
            [uint256(1), type(uint256).max],
            [uint256(2), 5],
            [uint256(3), 1],
            [uint256(9), 1],
            [type(uint256).max, type(uint256).max]
        ];
        uint256[9] memory want = [uint256(0), 3, 3, 1, 2, 1, 0, 0, 0];
        for (uint256 i; i < q.length; ++i) {
            address[] memory w = factory.orgsSlice(q[i][0], q[i][1]);
            assertEq(w.length, want[i]);
            for (uint256 k; k < want[i]; ++k) {
                assertEq(w[k], orgs[q[i][0] + k], "registration order");
            }
        }
    }

    function test_theCreatedEventAndTheRegistryAgree() public {
        address predicted = vm.computeCreateAddress(address(abxFactory), vm.getNonce(address(abxFactory)));
        vm.roll(777);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IOrgFactory.OrgCreated(predicted, alice, 0, "First", 777);
        address first = _create(alice, "First");
        assertEq(first, predicted);
        assertEq(factory.createdBlockOf(first), 777);

        predicted = vm.computeCreateAddress(address(abxFactory), vm.getNonce(address(abxFactory)));
        vm.roll(900);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IOrgFactory.OrgCreated(predicted, bob, 1, "Second", 900);
        address second = _create(bob, "Second");
        assertEq(factory.createdBlockOf(second), 900);
        assertEq(factory.adminOf(first), alice);
        assertEq(factory.adminOf(second), bob);
        assertFalse(factory.isOpen(first), "created closed");
        assertEq(factory.pendingAdminOf(first), address(0));
    }

    // ─── Salts ───────────────────────────────────────────────────────────────

    /// @dev ABX is handed `factory-address ‖ top 96 bits of keccak256(abi.encode(salt))`, whatever the caller's salt.
    function _abxSalt(bytes32 salt) internal view returns (bytes32) {
        return bytes32(bytes20(address(factory))) | bytes32(uint256(keccak256(abi.encode(salt))) >> 160);
    }

    function test_theSaltHandedToAbxIsDerivedFromTheCallersSaltAndPrefixedWithTheFactory() public {
        bytes32[3] memory salts = [bytes32(uint256(1)), bytes32(abi.encodePacked(alice, uint96(5))), bytes32(type(uint256).max >> 160)];
        for (uint256 i; i < salts.length; ++i) {
            vm.prank(alice);
            factory.createOrg("Acme", "", salts[i]);
            assertEq(abxFactory.lastSalt(), _abxSalt(salts[i]));
            assertEq(address(bytes20(abxFactory.lastSalt())), address(factory));
        }
        // Two different salts never share an ABX salt, and the creator prefix is hashed in.
        assertTrue(_abxSalt(bytes32(uint256(1))) != _abxSalt(bytes32(abi.encodePacked(alice, uint96(1)))));
    }

    function test_theSamePrefixlessSaltTwiceIsACollision() public {
        vm.prank(alice);
        factory.createOrg("Acme", "", bytes32(uint256(9)));
        vm.prank(bob);
        vm.expectRevert(); // the same ABX salt: CREATE2 collision
        factory.createOrg("Acme", "", bytes32(uint256(9)));
        assertEq(factory.orgCount(), 1);
    }

    function test_aPrefixedSaltIsBoundToItsCreator() public {
        bytes32 aliceSalt = bytes32(abi.encodePacked(alice, uint96(1)));
        vm.prank(bob);
        vm.expectRevert(IOrgFactory.SaltSenderMismatch.selector);
        factory.createOrg("Acme", "", aliceSalt);
        assertEq(factory.orgCount(), 0);
        vm.prank(alice);
        factory.createOrg("Acme", "", aliceSalt);
        assertEq(factory.orgCount(), 1);
    }

    function test_predictOrgUsesTheDerivedSaltAndRefusesZero() public {
        FakeAbxFactory fake = new FakeAbxFactory();
        OrgFactory f = OrgComponents.create(address(fake), RENDERER, SEED, address(dirStore), address(fileStore), address(meta));
        bytes32 salt = bytes32(uint256(42));
        bytes32 abxSalt = bytes32(bytes20(address(f))) | bytes32(uint256(keccak256(abi.encode(salt))) >> 160);
        // `predictOrg` does not vet a creator prefix (it cannot know the caller): any salt but zero is answered.
        assertEq(f.predictOrg(salt), address(uint160(uint256(abxSalt))));
        assertTrue(f.predictOrg(salt) != f.predictOrg(bytes32(uint256(43))), "different salts, different predictions");
        f.predictOrg(bytes32(abi.encodePacked(bob, uint96(1))));
        vm.expectRevert(IOrgFactory.NoDeterministicAddress.selector);
        f.predictOrg(bytes32(0));
    }

    // ─── The admin and the mint rules ────────────────────────────────────────

    function test_everyAdminCallOnANonOrgSaysNotOrg() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotOrg.selector, stranger));
        factory.transferAdmin(stranger, bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotOrg.selector, stranger));
        factory.setOpen(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotOrg.selector, stranger));
        factory.acceptAdmin(stranger);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotOrg.selector, address(0)));
        factory.setOpen(address(0), false);
        vm.stopPrank();
        // The registry did not grow a record by being asked.
        assertEq(factory.adminOf(stranger), address(0));
        assertEq(factory.pendingAdminOf(stranger), address(0));
    }

    /// @dev For a real org the non-org error is not what a non-admin gets: that is `NotAdmin`, naming the caller.
    function test_aNonAdminOfARealOrgGetsNotAdminNamingTheCaller() public {
        address org = _create(alice, "Acme");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotAdmin.selector, org, bob));
        factory.transferAdmin(org, bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotAdmin.selector, org, bob));
        factory.setOpen(org, true);
        // Even the factory's own address is not an admin.
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotAdmin.selector, org, address(factory)));
        factory.setOpen(org, true);
    }

    function test_acceptAdminNeedsAnOfferToTheCaller() public {
        address org = _create(alice, "Acme");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, bob));
        factory.acceptAdmin(org); // no offer at all

        vm.prank(alice);
        factory.transferAdmin(org, carol);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, bob));
        factory.acceptAdmin(org); // an offer, to someone else
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, alice));
        factory.acceptAdmin(org); // the offerer cannot accept their own offer for another

        vm.prank(carol);
        factory.acceptAdmin(org);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, carol));
        factory.acceptAdmin(org); // an offer is used once
        assertEq(factory.adminOf(org), carol);
    }

    function test_theAdminCanOfferToThemselvesAndTheNewOfferReplacesTheOld() public {
        address org = _create(alice, "Acme");
        vm.startPrank(alice);
        factory.transferAdmin(org, bob);
        factory.transferAdmin(org, carol); // one slot: the second offer replaces the first
        vm.stopPrank();
        assertEq(factory.pendingAdminOf(org), carol);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOrgFactory.NotPendingAdmin.selector, org, bob));
        factory.acceptAdmin(org);
    }

    function test_theHandoverEventsAndTheBooks() public {
        address a = _create(alice, "A");
        address b = _create(alice, "B");
        address c = _create(alice, "C");

        vm.expectEmit(true, true, true, true, address(factory));
        emit IOrgFactory.AdminTransferStarted(c, alice, bob);
        vm.prank(alice);
        factory.transferAdmin(c, bob);

        // The LAST org in alice's list leaves: no swap needed.
        vm.expectEmit(true, true, true, true, address(factory));
        emit IOrgFactory.AdminTransferred(c, alice, bob);
        vm.prank(bob);
        factory.acceptAdmin(c);

        address[] memory aliceOrgs = factory.orgsAdministered(alice);
        assertEq(aliceOrgs.length, 2);
        assertEq(aliceOrgs[0], a);
        assertEq(aliceOrgs[1], b);
        assertEq(factory.orgsAdministered(bob)[0], c);
        assertEq(factory.orgsAdministeredCount(alice), 2);
        assertEq(factory.orgsAdministeredCount(bob), 1);
        assertEq(factory.pendingAdminOf(c), address(0), "the offer is spent");

        // The only org leaves bob's list: a one-element list.
        vm.prank(bob);
        factory.transferAdmin(c, alice);
        vm.prank(alice);
        factory.acceptAdmin(c);
        assertEq(factory.orgsAdministered(bob).length, 0);
        address[] memory back = factory.orgsAdministered(alice);
        assertEq(back.length, 3);
        assertEq(back[2], c);
        // A record's position survives: handing `a` (the first) over now moves the last (`c`) into its slot.
        vm.prank(alice);
        factory.transferAdmin(a, bob);
        vm.prank(bob);
        factory.acceptAdmin(a);
        back = factory.orgsAdministered(alice);
        assertEq(back.length, 2);
        assertEq(back[0], c);
        assertEq(back[1], b);
        // and `c`, moved, is still removable.
        vm.prank(alice);
        factory.transferAdmin(c, carol);
        vm.prank(carol);
        factory.acceptAdmin(c);
        back = factory.orgsAdministered(alice);
        assertEq(back.length, 1);
        assertEq(back[0], b);
    }

    function _countOpenSet(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("OpenSet(address,bool)")) ++n;
        }
    }

    /// @dev A handover closes an open org (and says so), and leaves a closed one alone (and says nothing).
    function test_aHandoverEmitsOpenSetOnlyWhenItClosesSomething() public {
        address org = _create(alice, "Acme");
        vm.prank(alice);
        factory.transferAdmin(org, bob);
        vm.recordLogs();
        vm.prank(bob);
        factory.acceptAdmin(org);
        assertEq(_countOpenSet(vm.getRecordedLogs()), 0, "already closed: no OpenSet");
        assertFalse(factory.isOpen(org));

        vm.prank(bob);
        factory.setOpen(org, true);
        vm.prank(bob);
        factory.transferAdmin(org, carol);
        vm.expectEmit(true, false, false, true, address(factory));
        emit IOrgFactory.OpenSet(org, false);
        vm.prank(carol);
        factory.acceptAdmin(org);
        assertFalse(factory.isOpen(org));
    }

    function test_setOpenEmitsAndTogglesBothWays() public {
        address org = _create(alice, "Acme");
        vm.startPrank(alice);
        vm.expectEmit(true, false, false, true, address(factory));
        emit IOrgFactory.OpenSet(org, true);
        factory.setOpen(org, true);
        assertTrue(factory.isOpen(org));
        factory.setOpen(org, true); // idempotent, still emits
        assertTrue(factory.isOpen(org));
        vm.expectEmit(true, false, false, true, address(factory));
        emit IOrgFactory.OpenSet(org, false);
        factory.setOpen(org, false);
        assertFalse(factory.isOpen(org));
        vm.stopPrank();
    }

    /// @dev `mayMint(org, caller)`: false for a non-org whoever asks; for an org, the factory, the admin, and anyone
    ///      only while it is open.
    function test_mayMintEveryCallerEveryState() public {
        address org = _create(alice, "Acme");
        address[5] memory callers = [address(factory), alice, bob, address(0), address(minter)];
        // Closed: the factory and the admin only.
        bool[5] memory closed = [true, true, false, false, false];
        bool[5] memory open = [true, true, true, true, true];
        for (uint256 i; i < callers.length; ++i) {
            assertEq(factory.mayMint(org, callers[i]), closed[i], "closed");
            assertFalse(factory.mayMint(stranger, callers[i]), "a non-org, closed or not");
        }
        vm.prank(alice);
        factory.setOpen(org, true);
        for (uint256 i; i < callers.length; ++i) {
            assertEq(factory.mayMint(org, callers[i]), open[i], "open");
            assertFalse(factory.mayMint(stranger, callers[i]), "a non-org stays refused while another org is open");
        }
        // After a handover the old admin has nothing, the new one has the closed-org rights.
        vm.prank(alice);
        factory.transferAdmin(org, bob);
        vm.prank(bob);
        factory.acceptAdmin(org);
        assertTrue(factory.mayMint(org, bob));
        assertFalse(factory.mayMint(org, alice));
        assertTrue(factory.mayMint(org, address(factory)));
    }

    // ─── The minter ──────────────────────────────────────────────────────────

    function test_theMinterNamesTheOrgAndTheCallerWhenRefusing() public {
        address org = _create(alice, "Acme");
        assertEq(address(minter.factory()), address(factory));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrgMinter.NotAllowed.selector, org, bob));
        minter.mint(org, bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrgMinter.NotAllowed.selector, stranger, bob));
        minter.mint(stranger, bob);
        // The admin of a different org has no say here.
        address other = _create(carol, "Other");
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(OrgMinter.NotAllowed.selector, org, carol));
        minter.mint(org, carol);
        // The factory itself mints (it is how createOrg does it): msg.sender == factory.
        vm.prank(address(factory));
        assertEq(minter.mint(org, bob), 1, "the second token of the org, owned by the recipient");
        assertEq(MockOrgCollection(org).ownerOf(1), bob);
        vm.prank(carol);
        assertEq(minter.mint(other, alice), 1);
    }

    function test_theMinterReturnsTheNextTokenId() public {
        address org = _create(alice, "Acme");
        vm.startPrank(alice);
        assertEq(minter.mint(org, alice), 1);
        assertEq(minter.mint(org, bob), 2);
        assertEq(minter.mint(org, bob), 3);
        vm.stopPrank();
        assertEq(MockOrgCollection(org).ownerOf(2), bob);
    }

    // ─── Constants ───────────────────────────────────────────────────────────

    function test_theConstantsAreWhatTheDocumentationSays() public view {
        assertEq(factory.MAX_NAME_BYTES(), 64);
        assertEq(factory.MAX_DESCRIPTION_BYTES(), 1000);
        assertEq(factory.MAX_PROJECTS(), 1_000_000);
        assertEq(factory.CREATE2_DEPLOYER(), DEPLOYER);
        assertEq(factory.COMPONENT_SALT(), keccak256("abx-fs/org-components"));
        assertEq(address(factory.abx()), address(abxFactory));
        assertEq(factory.metadataRenderer(), RENDERER);
        assertEq(factory.seedSource(), SEED);
        assertEq(factory.orgMeta(), address(meta));
        assertEq(address(factory.links()), address(meta.links()));
    }
}

/// @dev The lens, against orgs backed by scripted contracts so each field of `resolve` can be driven through every
///      state ABX can report.
contract LensBranchesTest is Test {
    bytes4 internal constant OWNER_OF = bytes4(keccak256("ownerOf(uint256)"));
    bytes4 internal constant TOKEN_PARAM = bytes4(keccak256("tokenParam(uint256,bytes32)"));
    bytes4 internal constant TOKEN_DATA = bytes4(keccak256("tokenParamData(uint256,bytes32)"));
    bytes32 internal constant CID = keccak256("some-root");
    bytes32 internal constant DIR_A = keccak256("dir-a");

    FakeAbxFactory internal fake;
    OrgFactory internal factory;
    Lens internal lens;
    MockStore internal dirStore;
    RawStub internal org;
    address internal alice = makeAddr("alice");
    address internal owner_ = makeAddr("owner");

    function setUp() public {
        fake = new FakeAbxFactory();
        dirStore = new MockStore();
        factory = OrgComponents.create(
            address(fake), address(0xBEEF01), address(0xBEEF02), address(dirStore), address(new MockStore()), address(new OrgMeta("https://fs.abx.io"))
        );
        lens = new Lens(address(factory), address(factory.hook()));
        org = new RawStub();
        org.ret(IAbxOrgCollection.mint.selector, abi.encode(uint256(0))); // the factory's first mint must decode
        fake.setNext(address(org));
        vm.prank(alice);
        factory.createOrg("Stub", "", bytes32(0));
        assertTrue(factory.isOrg(address(org)));
        dirStore.add(DIR_A);
    }

    function test_theConstructorArguments() public view {
        assertEq(address(lens.factory()), address(factory));
        assertEq(address(lens.hook()), address(factory.hook()));
    }

    function _scriptToken(address owner__, bytes32 value, uint256 isHash, uint256 isSet, bytes memory gateway) internal {
        org.ret(OWNER_OF, abi.encode(owner__));
        org.ret(TOKEN_PARAM, abi.encode(value, isHash, isSet));
        org.ret(TOKEN_DATA, abi.encode(gateway));
    }

    /// @dev `cid` is the param's value only when it is set and is not a keccak commitment: each leg of the `&&`.
    function test_resolveReadsTheCidOnlyForASetNonHashValue() public {
        _scriptToken(owner_, CID, 0, 1, "");
        Lens.Resolution memory r = lens.resolve(address(org), 3);
        assertEq(r.cid, CID, "set and not a hash");
        assertEq(r.owner, owner_);

        _scriptToken(owner_, CID, 1, 1, "");
        assertEq(lens.resolve(address(org), 3).cid, bytes32(0), "a hash is a commitment, not a cid");

        _scriptToken(owner_, CID, 0, 0, "");
        assertEq(lens.resolve(address(org), 3).cid, bytes32(0), "not set");

        _scriptToken(owner_, CID, 1, 0, "");
        assertEq(lens.resolve(address(org), 3).cid, bytes32(0), "neither");
    }

    function test_resolveCarriesEveryFieldForARegisteredOrg() public {
        _scriptToken(owner_, CID, 0, 1, "https://gw.example");
        Lens.Resolution memory r = lens.resolve(address(org), 3);
        assertTrue(r.registered);
        assertEq(uint8(r.kind), uint8(IProjectHook.ContentKind.Unset), "the hook has no publish for it");
        assertEq(r.cid, CID);
        assertEq(r.owner, owner_);
        assertEq(string(r.gateway), "https://gw.example");
    }

    /// @dev An unregistered address is never called: it is not trusted to answer.
    function test_resolveNeverCallsAnUnregisteredAddress() public {
        RawStub rogue = new RawStub();
        rogue.ret(OWNER_OF, abi.encode(owner_));
        vm.expectCall(address(rogue), abi.encodeWithSelector(OWNER_OF, uint256(1)), 0);
        vm.expectCall(address(rogue), abi.encodeWithSelector(TOKEN_PARAM, uint256(1), bytes32("abxfs.cid")), 0);
        Lens.Resolution memory r = lens.resolve(address(rogue), 1);
        assertFalse(r.registered);
        assertEq(uint8(r.kind), 0);
        assertEq(r.cid, bytes32(0));
        assertEq(r.owner, address(0));
        assertEq(r.gateway.length, 0);
        // A no-code address, and zero, answer the same way.
        assertFalse(lens.resolve(address(0xDEAD), 1).registered);
        assertFalse(lens.resolve(address(0), 1).registered);
    }

    function test_resolveRevertsForATokenTheOrgSaysDoesNotExist() public {
        org.boom(OWNER_OF);
        vm.expectRevert(bytes("RawStub"));
        lens.resolve(address(org), 9);
    }

    function test_resolveReadsTheKindFromTheHook() public {
        // Publish through the org so the hook records a real kind: the stub org calls the hook as its token.
        ProjectHook hook = factory.hook(); // read first: a getter call would consume the prank
        vm.prank(address(org));
        hook.onParamConfigured(3, "abxfs.cid", DIR_A, alice, 0, address(0));
        _scriptToken(owner_, DIR_A, 0, 1, "");
        Lens.Resolution memory r = lens.resolve(address(org), 3);
        assertEq(uint8(r.kind), uint8(IProjectHook.ContentKind.Directory));
        assertEq(r.cid, DIR_A);
    }

    function test_publishRangeOfAnEmptyLedgerAndAtTheEdges() public {
        assertEq(lens.publishRange(0, 10).length, 0);
        assertEq(lens.publishRange(5, 1).length, 0);
        ProjectHook hook = factory.hook(); // read first: a getter call would consume the prank
        for (uint256 i; i < 3; ++i) {
            bytes32 cid = keccak256(abi.encode("root", i));
            dirStore.add(cid);
            vm.prank(address(org));
            hook.onParamConfigured(i, "abxfs.cid", cid, alice, 0, address(0));
        }
        Lens.Published[] memory all = lens.publishRange(0, type(uint256).max);
        assertEq(all.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(all[i].org, address(org));
            assertEq(all[i].record.cid, keccak256(abi.encode("root", i)));
            assertEq(all[i].record.tokenId, i);
            assertEq(all[i].record.version, 1);
            assertEq(all[i].record.publisher, alice);
        }
        assertEq(lens.publishRange(1, 1).length, 1);
        assertEq(lens.publishRange(1, 1)[0].record.tokenId, 1);
        assertEq(lens.publishRange(2, 9).length, 1, "count clamps");
        assertEq(lens.publishRange(3, 1).length, 0, "start at the end");
        assertEq(lens.publishRange(0, 0).length, 0, "count zero");
    }
}

/// @dev What `createOrg` asks of ABX, and in what order: the parameters the collection is created with (every one of
///      which is frozen for the life of the org), then each call the factory makes to it while it still owns it. The
///      expectations are written out here, independently of the factory's code, so a changed parameter, a missing lock
///      or a swapped order fails with a named difference.
contract OrgFactoryCallsTest is Test {
    string internal constant GATEWAY = "https://fs.abx.io";
    address internal constant RENDERER = address(0xBEEF01);
    address internal constant SEED = address(0xBEEF02);

    FakeAbxFactory internal fake;
    CallRecorder internal org;
    OrgFactory internal factory;
    OrgMeta internal meta;
    address internal alice = makeAddr("alice");

    function setUp() public {
        fake = new FakeAbxFactory();
        org = new CallRecorder();
        fake.setNext(address(org));
        meta = new OrgMeta(GATEWAY);
        factory = OrgComponents.create(address(fake), RENDERER, SEED, address(new MockStore()), address(new MockStore()), address(meta));
    }

    function _expectedFields(string memory description) internal view returns (AbxContractField[] memory cf) {
        cf = new AbxContractField[](bytes(description).length == 0 ? 5 : 6);
        cf[0] = AbxContractField("image", "renderer", abi.encode(address(factory.card())));
        cf[1] = AbxContractField("attributes", "renderer", abi.encode(address(factory.traits())));
        cf[2] = AbxContractField("animation_url", "renderer", abi.encode(address(factory.links())));
        cf[3] = AbxContractField("external_url", "renderer", abi.encode(address(factory.links())));
        cf[4] = AbxContractField("name", "renderer", abi.encode(address(meta)));
        if (bytes(description).length != 0) cf[5] = AbxContractField("description", "inline", bytes(description));
    }

    function _expectedParams(string memory name, string memory description) internal view returns (AbxInitParams memory p) {
        p.owner = address(factory);
        p.name = name;
        p.symbol = "ABXFS";
        p.tokenURIBase = "";
        p.tokenURIRenderer = RENDERER;
        p.contractURIBase = "";
        p.contractURIRenderer = address(meta);
        p.royaltyReceiver = address(factory);
        p.royaltyBps = 0;
        p.maxRoyaltyBps = 0;
        p.burnable = false;
        p.transferValidator = address(0);
        p.maxInvocations = 1_000_000;
        p.primaryPayee = address(factory);
        p.minter = address(factory.minter());
        p.paused = false;
        p.seedSource = SEED;
        p.disableTokenOwnerDelegation = true;
        p.mintTo = address(0);
        p.mintCount = 0;
        p.tokenFields = new AbxTokenField[](0);
        p.contractFields = _expectedFields(description);
    }

    /// @dev Every parameter, exactly, with and without a description (which adds the sixth field).
    function test_theOrgIsCreatedWithExactlyTheseParameters() public {
        vm.prank(alice);
        factory.createOrg("Acme", "", bytes32(0));
        assertEq(
            fake.lastDeployCall(),
            abi.encodeCall(IAbxSeriesCodeFactory.deploy, (_expectedParams("Acme", ""))),
            "no description: five fields"
        );

        vm.prank(alice);
        factory.createOrg("Acme Studio", "Line one.\nLine two.", bytes32(0));
        assertEq(
            fake.lastDeployCall(),
            abi.encodeCall(IAbxSeriesCodeFactory.deploy, (_expectedParams("Acme Studio", "Line one.\nLine two."))),
            "with a description: six fields"
        );
    }

    function test_aSaltedOrgIsCreatedWithTheSameParametersAndTheDerivedSalt() public {
        bytes32 salt = bytes32(uint256(77));
        bytes32 abxSalt = bytes32(bytes20(address(factory))) | bytes32(uint256(keccak256(abi.encode(salt))) >> 160);
        vm.prank(alice);
        factory.createOrg("Acme", "About.", salt);
        assertEq(
            fake.lastDeployCall(),
            abi.encodeCall(IAbxSeriesCodeFactory.deployDeterministic, (_expectedParams("Acme", "About."), abxSalt))
        );
    }

    function _schema(bytes32 key, uint8 paramType) internal pure returns (bytes memory) {
        return abi.encodeCall(
            IAbxOrgCollection.setParamSchema,
            (key, paramType, 1, address(0), 0, bytes32(0), bytes32(0), new string[](0))
        );
    }

    function _expectedCalls(string memory description) internal view returns (bytes[] memory calls) {
        bool described = bytes(description).length != 0;
        calls = new bytes[](described ? 19 : 18);
        uint256 k;
        // The five keys: the CID is a `Uint256Range` scalar (2), the rest are `String`s (7); every one is `TokenOwner` (1).
        calls[k++] = _schema("abxfs.cid", 2);
        calls[k++] = _schema("abxfs.gateway", 7);
        calls[k++] = _schema("abxfs.name", 7);
        calls[k++] = _schema("abxfs.view", 7);
        calls[k++] = _schema("abxfs.meta", 7);
        // The hooks, with no augment hook in the middle, then every lock, then every field.
        calls[k++] = abi.encodeCall(IAbxOrgCollection.setParamHooks, (address(factory.hook()), address(0), address(factory.enumeration())));
        calls[k++] = abi.encodeCall(IAbxOrgCollection.lockParamHooks, ());
        calls[k++] = abi.encodeCall(IAbxOrgCollection.lockTokenURI, ());
        calls[k++] = abi.encodeCall(IAbxOrgCollection.lockContractURI, ());
        calls[k++] = abi.encodeCall(IAbxOrgCollection.lockScript, ());
        calls[k++] = abi.encodeCall(IAbxOrgCollection.lockDependencies, ());
        AbxContractField[] memory cf = _expectedFields(description);
        for (uint256 i; i < cf.length; ++i) {
            calls[k++] = abi.encodeCall(IAbxOrgCollection.lockContractField, (cf[i].field));
        }
        calls[k++] = abi.encodeCall(IAbxOrgCollection.renounceOwnership, ());
        // Last, and by the minter: the first project, to the caller.
        calls[k++] = abi.encodeCall(IAbxOrgCollection.mint, (alice));
    }

    function _check(string memory description) internal {
        vm.prank(alice);
        factory.createOrg("Acme", description, bytes32(0));
        bytes[] memory want = _expectedCalls(description);
        assertEq(org.count(), want.length, "the number of calls");
        for (uint256 i; i < want.length; ++i) {
            assertEq(org.callAt(i), want[i], string.concat("call ", vm.toString(i)));
            // The factory makes every call but the last while it owns the collection; the minter makes the mint.
            assertEq(
                org.callerAt(i), i + 1 == want.length ? address(factory.minter()) : address(factory), string.concat("caller of call ", vm.toString(i))
            );
        }
    }

    function test_theFactoryCallsTheCollectionInExactlyThisOrder_withoutADescription() public {
        _check("");
    }

    function test_theFactoryCallsTheCollectionInExactlyThisOrder_withADescription() public {
        _check("About Acme.");
    }
}
