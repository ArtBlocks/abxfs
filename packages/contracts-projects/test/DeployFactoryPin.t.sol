// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {OrgComponents} from "../script/OrgComponents.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./fork/ContentLayer.sol";

/// @dev Pins the org layer's creation code, and checks the deploy script's predicted addresses against its own
///      `pinned()` (`OrgMeta`, the factory, its five components and the lens), which is what `runWith` refuses to
///      broadcast without on a listed chain.
///
///      RE-PIN AT CODE FREEZE, BEFORE THE AUDIT. These values move with every source change until then (and with
///      any content-layer change, through the store addresses). After the freeze, a failure here means an edit moved
///      a deployed address: revert it, or treat it as a new factory whose pins move with the registry.
///
///      - The builds keep solc's metadata hash, so every source change moves these hashes, comments and NatSpec
///        included.
///      - The factory's initcode holds the creation code of its five components (hook, enumeration hook, minter,
///        card, traits) to compute their addresses, so a code change in any of them moves the factory's hash and
///        address.
///      - `OrgMeta` is deployed separately (CREATE2, its own salt) and deploys the links renderer in ITS
///        constructor; its address is a factory constructor argument, so a change in either moves the factory too.
///      - The lens is CREATE2 as well, from the factory and its hook, so it moves with the factory.
///
///      Every listed chain binds the same ABX set, the same store pair (same CREATE2 addresses) and the same
///      gateway base, so they all predict ONE set of addresses.
///
///      Tests whose name contains "Pinned" hold only for the optimized build, so `forge coverage` (which compiles
///      without the optimizer) leaves them out; the rest hold for any build.
contract DeployFactoryPinTest is Test {
    bytes32 constant FACTORY_CREATION_CODE_HASH = 0x83803a951a08cfa01f2a542c687823bf87c4d3eef819b316d75423d90626e1fc;
    bytes32 constant ORG_META_CREATION_CODE_HASH = 0xfee2f62262d2c2838020d3980d01fbf8df96415269f2e1062c69815172b03e9c;
    bytes32 constant LENS_CREATION_CODE_HASH = 0x917e1fef34f305a8a4c4bc9662daf14898a32decfef3f919508a8f707ae23dc9;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = keccak256("abx-fs/org-factory");
    bytes32 constant SALT_ORG_META = keccak256("abx-fs/org-meta");
    bytes32 constant SALT_LENS = keccak256("abx-fs/lens");
    bytes32 constant COMPONENT_SALT = keccak256("abx-fs/org-components");
    string constant GATEWAY = "https://fs.abx.io";

    DeployProjects internal d;

    function setUp() public {
        d = new DeployProjects();
    }

    function test_factoryCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(OrgFactory).creationCode), FACTORY_CREATION_CODE_HASH, "factory creation code moved");
    }

    function test_orgMetaCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(OrgMeta).creationCode), ORG_META_CREATION_CODE_HASH, "OrgMeta creation code moved");
    }

    function test_lensCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(Lens).creationCode), LENS_CREATION_CODE_HASH, "Lens creation code moved");
    }

    /// @dev The build under test lands exactly where the script's pins say, for the table every listed chain binds: so
    ///      `runWith` will broadcast it there, and nothing else.
    function test_everyPredictedAddressIsPinned() public view {
        DeployProjects.Addresses memory got = d.predict(d.expected());
        DeployProjects.Addresses memory pin = d.pinned();
        assertEq(got.orgMeta, pin.orgMeta, "OrgMeta");
        assertEq(got.factory, pin.factory, "factory");
        assertEq(got.hook, pin.hook, "hook");
        assertEq(got.enumeration, pin.enumeration, "enumeration");
        assertEq(got.minter, pin.minter, "minter");
        assertEq(got.card, pin.card, "card");
        assertEq(got.traits, pin.traits, "traits");
        assertEq(got.lens, pin.lens, "lens");
        d.requirePinned(got);
    }

    /// @dev The pins are eight distinct nonzero addresses (holds for any build: it does not compare them with one).
    function test_thePinsAreEightDistinctAddresses() public view {
        DeployProjects.Addresses memory p = d.pinned();
        address[8] memory all = [p.orgMeta, p.factory, p.hook, p.enumeration, p.minter, p.card, p.traits, p.lens];
        for (uint256 i; i < 8; ++i) {
            assertTrue(all[i] != address(0), "nonzero");
            for (uint256 j; j < i; ++j) {
                assertTrue(all[i] != all[j], "distinct");
            }
        }
    }

    function _create2(bytes32 salt, bytes memory init) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(init))))));
    }

    /// @dev The script's `predict` is the keyless deployer's CREATE2, recomputed here by hand from the table: the
    ///      content layer's store pair, ABX's set and the gateway base. Holds for any build.
    function test_theScriptPredictsTheKeylessDeployersAddresses() public view {
        DeployProjects.Inputs memory e = d.expected();
        assertEq(e.directoryStore, CONTENT_DIRECTORY_STORE, "the table binds the content layer's directory store");
        assertEq(e.fileStore, CONTENT_FILE_STORE, "and its file store");
        assertEq(e.gatewayBase, GATEWAY);
        DeployProjects.Addresses memory a = d.predict(e);
        assertEq(a.orgMeta, _create2(SALT_ORG_META, abi.encodePacked(type(OrgMeta).creationCode, abi.encode(GATEWAY))));
        assertEq(
            a.factory,
            _create2(
                SALT,
                abi.encodePacked(
                    type(OrgFactory).creationCode,
                    abi.encode(e.abx, e.renderer, e.seed, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE, a.orgMeta)
                )
            )
        );
        assertEq(a.hook, _hookOf(a.factory, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE));
        assertEq(
            a.enumeration,
            _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(a.factory)))
        );
        assertEq(a.minter, _create2(COMPONENT_SALT, abi.encodePacked(type(OrgMinter).creationCode, abi.encode(a.factory))));
        assertEq(a.card, _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectCard).creationCode, abi.encode(a.hook))));
        assertEq(a.traits, _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(a.hook))));
        assertEq(a.lens, _create2(SALT_LENS, abi.encodePacked(type(Lens).creationCode, abi.encode(a.factory, a.hook))));
    }

    /// The factory's hook: a component, deployed through the keyless deployer under `COMPONENT_SALT`.
    function _hookOf(address factory, address dir, address files) internal pure returns (address) {
        return _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectHook).creationCode, abi.encode(dir, files, factory)));
    }

    /// Every component is where the factory says: the keyless deployer, `COMPONENT_SALT`, its creation code and the
    /// constructor arguments naming this factory (or its hook). The lens prediction above depends on the hook's.
    function test_componentsAreWhereTheFactorySays() public {
        OrgMeta meta = new OrgMeta(GATEWAY);
        OrgFactory f = new OrgFactory(address(1), address(2), address(3), address(4), address(5), address(meta));
        assertEq(f.COMPONENT_SALT(), COMPONENT_SALT);
        assertEq(f.CREATE2_DEPLOYER(), CREATE2_DEPLOYER);
        address hook = _hookOf(address(f), address(4), address(5));
        assertEq(address(f.hook()), hook, "hook");
        assertEq(
            address(f.enumeration()),
            _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(address(f)))),
            "enumeration"
        );
        assertEq(
            address(f.minter()),
            _create2(COMPONENT_SALT, abi.encodePacked(type(OrgMinter).creationCode, abi.encode(address(f)))),
            "minter"
        );
        assertEq(
            address(f.card()), _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectCard).creationCode, abi.encode(hook))), "card"
        );
        assertEq(
            address(f.traits()),
            _create2(COMPONENT_SALT, abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(hook))),
            "traits"
        );

        // Nothing is deployed by the factory itself, and no org can be made until every component exists.
        assertFalse(f.componentsDeployed());
        vm.expectRevert(IOrgFactory.ComponentsNotDeployed.selector);
        f.createOrg("x", "", bytes32(0));

        // Anyone can deploy them, and they land exactly there.
        vm.prank(makeAddr("anyone"));
        OrgComponents.deploy(f, address(4), address(5));
        assertTrue(f.componentsDeployed());
        assertEq(address(f.hook().factory()), address(f));
        assertEq(address(f.card().hook()), hook);
    }

    /// A component deployed with other arguments (another factory, other stores) lands somewhere else, so it can never
    /// satisfy this factory.
    function test_aComponentWithOtherArgumentsIsNotThisFactorys() public {
        OrgMeta meta = new OrgMeta(GATEWAY);
        OrgFactory f = new OrgFactory(address(1), address(2), address(3), address(4), address(5), address(meta));
        (bool ok,) = CREATE2_DEPLOYER.call(
            abi.encodePacked(
                f.COMPONENT_SALT(), type(ProjectHook).creationCode, abi.encode(address(4), address(6), address(f))
            )
        );
        assertTrue(ok);
        assertEq(address(f.hook()).code.length, 0);
        assertFalse(f.componentsDeployed());
    }
}
