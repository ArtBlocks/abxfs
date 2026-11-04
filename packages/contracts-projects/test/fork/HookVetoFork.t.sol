// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {OrgMinter} from "../../src/OrgMinter.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {Lens} from "../../src/Lens.sol";
import {IProjectHook} from "../../src/interfaces/IProjectHook.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IVetoOrg {
    function ownerOf(uint256) external view returns (address);
    function tokenParam(uint256, bytes32) external view returns (bytes32, bool, bool);
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function transferFrom(address, address, uint256) external;
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
    function nextTokenId() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burnable() external view returns (bool);
    function burn(uint256) external;
}

/// @dev The hook's veto surface and the token ids it keys history by, exercised through the REAL ABX on Base Sepolia
///      (skipped without `ABXFS_RPC_URL_84532`). The mock stands in for ABX everywhere else; only the real contract
///      can say what `dataLength` ABX passes, what it refuses before the hook is reached, and how it numbers tokens.
contract HookVetoForkTest is Test {
    address constant ABX = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;

    OrgFactory factory;
    ProjectHook hook;
    ProjectEnumeration en;
    Lens lens;
    address admin = makeAddr("admin");
    address org;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        factory = OrgComponents.create(
            ABX, RENDERER, SEED, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE, address(new OrgMeta("https://fs.abx.io"))
        );
        hook = factory.hook();
        en = factory.enumeration();
        lens = new Lens(address(factory), address(hook));
        vm.prank(admin);
        org = factory.createOrg("Veto Org", "", bytes32(0));
    }

    function _emptyDir() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x32), bytes32(0)));
    }

    function _bytes(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = "a";
    }

    /// The caps count BYTES as ABX reports them (`dataLength` is the payload length), and bite at exactly cap + 1.
    function test_stringCapsBiteAtExactlyCapPlusOne() public {
        IVetoOrg c = IVetoOrg(org);
        bytes32[4] memory keys = [bytes32("abxfs.name"), "abxfs.gateway", "abxfs.view", "abxfs.meta"];
        uint256[4] memory caps = [uint256(128), 512, 512, 4096];
        for (uint256 i; i < 4; ++i) {
            vm.prank(admin);
            c.configureTokenParamData(0, keys[i], _bytes(caps[i]));
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, keys[i], caps[i] + 1, caps[i]));
            c.configureTokenParamData(0, keys[i], _bytes(caps[i] + 1));
        }
        // Multi-byte UTF-8: 64 two-byte characters are 128 bytes, at the cap; one more byte is over it.
        bytes memory name;
        for (uint256 i; i < 64; ++i) name = bytes.concat(name, bytes(unicode"é"));
        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.name", name);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.BlobTooLarge.selector, bytes32("abxfs.name"), 129, 128));
        c.configureTokenParamData(0, "abxfs.name", bytes.concat(name, "a"));
    }

    /// Every root rule, through the real param path: absent roots (zero included), the kind lock, the same root, two
    /// publishes in one multicall, and a buyer who inherits history and lock.
    function test_rootRules() public {
        IVetoOrg c = IVetoOrg(org);
        bytes32 f1 = ContentLayer.realFile("veto-1");
        bytes32 f2 = ContentLayer.realFile("veto-2");
        bytes32 d = _emptyDir();

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, bytes32(uint256(1))));
        c.configureTokenParam(0, "abxfs.cid", bytes32(uint256(1)));
        // Zero is not a root: no file or directory CID is zero, the empty ones included.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, bytes32(0)));
        c.configureTokenParam(0, "abxfs.cid", bytes32(0));

        vm.prank(admin);
        c.configureTokenParam(0, "abxfs.cid", f1);
        assertEq(uint8(hook.kindOf(org, 0)), uint8(IProjectHook.ContentKind.File));
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.File, IProjectHook.ContentKind.Directory
            )
        );
        c.configureTokenParam(0, "abxfs.cid", d);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.SameRoot.selector, f1));
        c.configureTokenParam(0, "abxfs.cid", f1);
        // A root in neither store is still RootNotFound once the kind is locked to File (the file store is asked first).
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootNotFound.selector, bytes32(uint256(2))));
        c.configureTokenParam(0, "abxfs.cid", bytes32(uint256(2)));

        // Two publishes in one multicall: both land, in order, as two versions.
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IVetoOrg.configureTokenParam, (0, "abxfs.cid", f2));
        calls[1] = abi.encodeCall(IVetoOrg.configureTokenParam, (0, "abxfs.cid", f1));
        vm.prank(admin);
        c.multicall(calls);
        assertEq(hook.versionCount(org, 0), 3);
        (, bytes32 head) = hook.latestVersion(org, 0);
        (bytes32 v,, bool set) = c.tokenParam(0, "abxfs.cid");
        assertEq(head, v);
        assertTrue(set);
        assertEq(hook.publishCount(org), 3);
        IProjectHook.PublishRecord memory r2 = hook.publishAt(org, 1);
        assertEq(r2.cid, f2);
        assertEq(r2.version, 2);
        assertEq(r2.tokenId, 0);
        assertEq(r2.publisher, admin);
        Lens.Resolution memory r = lens.resolve(org, 0);
        assertEq(r.cid, f1);
        assertEq(uint8(r.kind), uint8(IProjectHook.ContentKind.File));

        // A transfer resets neither kind nor history; the buyer publishes under the same lock.
        address bob = makeAddr("bob");
        vm.prank(admin);
        c.transferFrom(admin, bob, 0);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.File, IProjectHook.ContentKind.Directory
            )
        );
        c.configureTokenParam(0, "abxfs.cid", d);
        vm.prank(bob);
        c.configureTokenParam(0, "abxfs.cid", f2);
        assertEq(hook.versionAt(org, 0, 4).publisher, bob);
        assertEq(hook.globalPublishCount(), 4);
        (address o, uint256 idx) = hook.globalPublishAt(3);
        assertEq(o, org);
        assertEq(hook.publishAt(org, idx).publisher, bob);
    }

    /// ABX refuses a key with no schema, the collection surface and an unminted token before the hook is reached, so
    /// the hook's "ignore" branches are unreachable on a real org and no future project's kind can be pre-seeded.
    function test_abxRefusesWhatTheHookWouldIgnore() public {
        IVetoOrg c = IVetoOrg(org);
        vm.prank(admin);
        vm.expectRevert();
        c.configureTokenParam(0, "abxfs.other", bytes32(uint256(1)));
        vm.prank(admin);
        vm.expectRevert();
        c.configureTokenParam(type(uint256).max, "abxfs.cid", _emptyDir());
        vm.prank(admin);
        vm.expectRevert();
        c.configureTokenParam(1, "abxfs.cid", _emptyDir());
        assertEq(hook.versionCount(org, 1), 0);
        assertEq(hook.publishCount(org), 0);
    }

    /// What the enumeration hook no longer tracks (an org's whole token set) is ABX's own answer: every org numbers
    /// its tokens 0, 1, 2, … in mint order with no gaps, and nothing can be burned, so the tokens of an org are exactly
    /// `0 … nextTokenId() - 1` and `nextTokenId() == totalSupply()`. Held for the first project, for minter mints by
    /// every allowed caller, across transfers, in a second org (ids repeat) and in a deterministic org.
    function test_tokenIdsAreSequentialFromZeroAndPermanent() public {
        IVetoOrg c = IVetoOrg(org);
        OrgMinter m = factory.minter();
        assertFalse(c.burnable(), "orgs are not burnable");
        assertEq(c.nextTokenId(), 1);
        assertEq(c.totalSupply(), 1);
        assertEq(c.ownerOf(0), admin);

        vm.prank(admin);
        factory.setOpen(org, true);
        address[3] memory minters = [admin, makeAddr("anyone"), makeAddr("someone else")];
        for (uint256 i; i < 6; ++i) {
            address who = minters[i % 3];
            uint256 expected = c.nextTokenId();
            vm.prank(who);
            uint256 id = m.mint(org, who);
            assertEq(id, expected, "the next id");
            assertEq(c.ownerOf(id), who);
            assertEq(c.nextTokenId(), id + 1);
            assertEq(c.totalSupply(), id + 1);
        }
        uint256 frontier = c.nextTokenId();
        vm.expectRevert();
        c.ownerOf(frontier);

        // Transfers renumber nothing, and a burn is refused for the owner itself.
        vm.prank(admin);
        c.transferFrom(admin, makeAddr("buyer"), 0);
        assertEq(c.nextTokenId(), 7);
        vm.prank(makeAddr("buyer"));
        vm.expectRevert();
        c.burn(0);
        assertEq(c.totalSupply(), 7);

        // Another org starts at 0 again, and so does a deterministic one.
        vm.prank(admin);
        address org2 = factory.createOrg("Second", "", bytes32(0));
        assertEq(IVetoOrg(org2).nextTokenId(), 1);
        assertEq(IVetoOrg(org2).ownerOf(0), admin);
        vm.prank(admin);
        address org3 = factory.createOrg("Third", "", bytes32(abi.encodePacked(admin, uint96(7))));
        assertEq(IVetoOrg(org3).nextTokenId(), 1);
        assertEq(IVetoOrg(org3).ownerOf(0), admin);
        vm.prank(admin);
        assertEq(m.mint(org3, admin), 1);
    }
}
