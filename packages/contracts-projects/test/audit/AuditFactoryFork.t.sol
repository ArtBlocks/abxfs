// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "../fork/ContentLayer.sol";

interface IC {
    function owner() external view returns (address);
    function ownerOf(uint256) external view returns (address);
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function tokenParamData(uint256, bytes32) external view returns (bytes memory);
    function delegateRegistry() external view returns (address);
    function transferFrom(address, address, uint256) external;
    function totalSupply() external view returns (uint256);
    function nextTokenId() external view returns (uint256);
    function getTransferValidator() external view returns (address);
    function paused() external view returns (bool);
}

interface IDelegateRegistry {
    function delegateAll(address to, bytes32 rights, bool enable) external payable returns (bytes32);
}

/// @dev Receiver that tries to reenter everything in the factory during the first mint of createOrg.
contract Reenter {
    OrgFactory public f;
    address public org;
    bool public entered;
    uint256 public depth;
    uint256 public enumBalanceAtCallback;
    bool public isOrgAtCallback;
    uint256 public orgsAdministeredAtCallback;

    constructor(OrgFactory f_) { f = f_; }

    function go(string calldata n) external { org = f.createOrg(n, "", bytes32(0)); }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        address o = msg.sender;
        if (depth == 0) {
            depth = 1;
            entered = true;
            isOrgAtCallback = f.isOrg(o);
            enumBalanceAtCallback = f.enumeration().balanceOfTracked(o, address(this));
            orgsAdministeredAtCallback = f.orgsAdministeredCount(address(this));
            // reenter: more mints (we are admin), setOpen, nested createOrg, admin offer/accept to self
            f.minter().mint(o, address(this));
            f.setOpen(o, true);
            f.createOrg("nested", "", bytes32(0));
            f.transferAdmin(o, address(this));
            f.acceptAdmin(o);
        }
        return this.onERC721Received.selector;
    }
}

contract NoReceiver {
    function go(OrgFactory f) external returns (address) { return f.createOrg("x", "", bytes32(0)); }
}

contract RevertingReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { revert("no"); }
}

contract GasBurner {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        while (true) {}
        return 0;
    }
}

contract AuditFactoryForkTest is Test {
    using LibString for string;

    address constant ABX_F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIR = CONTENT_DIRECTORY_STORE;
    address constant FILES = CONTENT_FILE_STORE;

    OrgFactory f;
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");
    address victim = makeAddr("victim");

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        f = OrgComponents.create(ABX_F, ABX_RENDERER, ABX_SEED, DIR, FILES, address(new OrgMeta("https://fs.abx.io")));
    }

    // ACCEPTED RISK (owner decision): zero-prefix salts stay open to everyone; documented in IOrgFactory.
    // The delegation (F1) and predictOrg(0) (F5) PoCs were converted: see test/fork/OrgPolicyFork.t.sol and Orgs.t.sol.
    // 1. Zero-prefix salt squat: attacker takes the exact address the victim predicted.
    function test_saltSquat() public {
        bytes32 salt = bytes32(uint256(777));
        address predicted = f.predictOrg(salt);
        vm.prank(mallory);
        address got = f.createOrg("evil", "", salt);
        assertEq(got, predicted);
        assertEq(f.adminOf(predicted), mallory);
        vm.prank(alice);
        vm.expectRevert();
        f.createOrg("alice", "", salt);
    }

    // 2/3/4. HOLD: ABX mint is NOT a safe-mint, so no receiver callback exists: no reentrancy window,
    //    contract admins without onERC721Received can create orgs, and a hostile/gas-burning
    //    recipient cannot be used to grief or reenter.
    function test_abxMintNeverCallsReceiver() public {
        Reenter r = new Reenter(f);
        r.go("re");
        assertFalse(r.entered(), "no onERC721Received on mint");
        NoReceiver n = new NoReceiver();
        address o = n.go(f); // contract without receiver can create
        assertEq(IC(o).ownerOf(0), address(n));
        RevertingReceiver rr = new RevertingReceiver();
        vm.prank(address(rr));
        f.createOrg("x", "", bytes32(0));
        address m = address(f.minter());
        address burner = address(new GasBurner());
        vm.prank(address(n));
        (bool ok,) = m.call(abi.encodeWithSignature("mint(address,address)", o, burner));
        console2.log("mint to gas-burning contract ok?", ok);
        assertTrue(ok, "mint to burner");
        assertEq(f.orgCount(), 3);
    }

    // ACCEPTED RISK (owner decision): the constructor does not validate; script/Deploy.s.sol does, before broadcasting.
    // Does ABX validate renderer / seed source passed by a mis-configured deploy?
    function test_abxAcceptsBogusRenderer() public {
        OrgFactory bad = OrgComponents.create(ABX_F, address(0x1234), ABX_SEED, DIR, FILES, address(new OrgMeta("https://x")));
        vm.prank(alice);
        address org = bad.createOrg("x", "", bytes32(0));
        console2.log("org created with EOA renderer/seed; frozen forever");
        (bool ok,) = org.staticcall(abi.encodeWithSignature("tokenURI(uint256)", 0));
        console2.log("tokenURI ok with EOA renderer?", ok);
        assertFalse(ok);
    }

    // 5. Open org: stranger mints into a victim's wallet, unsolicited, and into the victim's enumeration.
    function test_openOrgStrangerSpamsVictim() public {
        vm.prank(alice);
        address org = f.createOrg("o", "", bytes32(0));
        vm.prank(alice);
        f.setOpen(org, true);
        address m = address(f.minter());
        uint256 g0 = gasleft();
        for (uint256 i; i < 50; ++i) {
            vm.prank(mallory);
            (bool ok,) = m.call(abi.encodeWithSignature("mint(address,address)", org, victim));
            assertTrue(ok);
        }
        console2.log("gas for 50 spam mints", g0 - gasleft());
        assertEq(f.enumeration().orgsHeldBy(victim).length, 1);
        assertEq(f.enumeration().balanceOfTracked(org, victim), 50);
        // victim must be a *held* party in org list now
    }

    // Informational (log only): names with JSON breakers are valid ASCII and ABX escapes them; asserted in test/fork/OrgPolicyFork.t.sol.
    // 6. Name with JSON / HTML breakers -> are tokenURI / contractURI valid & safe?
    function test_hostileNameInMetadata() public {
        string memory nm = "A\",\"animation_url\":\"https://evil.example/\",\"x\":\"";
        vm.prank(alice);
        address org = f.createOrg(nm, "", bytes32(0));
        string memory prefix = "data:application/json;base64,";
        string memory uri = IC(org).tokenURI(0);
        console2.log(uri.slice(0, 40));
        string memory json = string(Base64.decode(uri.slice(bytes(prefix).length)));
        console2.log(json.slice(0, 320));
        string memory curi = IC(org).contractURI();
        if (curi.startsWith(prefix)) console2.log(string(Base64.decode(curi.slice(bytes(prefix).length))));
        else console2.log(curi.slice(0, 200));
    }

    // 8. Frozen state of the real collection + proxy shape.
    function test_cloneShape() public {
        vm.prank(alice);
        address org = f.createOrg("o", "", bytes32(0));
        console2.log("clone code length", org.code.length);
        console2.logBytes(org.code);
        assertEq(IC(org).owner(), address(0));
        assertFalse(IC(org).paused());
        assertEq(IC(org).getTransferValidator(), address(0));
    }

    // 9. gas of createOrg and size of factory
    function test_gasAndSize() public {
        uint256 g = gasleft();
        vm.prank(alice);
        f.createOrg("o", "", bytes32(0));
        console2.log("createOrg gas", g - gasleft());
        console2.log("factory runtime size", address(f).code.length);
        bytes memory init = abi.encodePacked(type(OrgFactory).creationCode, abi.encode(ABX_F, ABX_RENDERER, ABX_SEED, DIR, FILES, "https://fs.abx.io"));
        console2.log("factory initcode size", init.length);
    }

    // ACCEPTED RISK: see above; the deploy script validates.
    // 10. Wrong ABX address at deploy: constructor does not validate; every createOrg then reverts / does something odd
    function test_constructorDoesNotValidateAbx() public {
        OrgFactory bad = OrgComponents.create(address(0x1234), ABX_RENDERER, ABX_SEED, DIR, FILES, address(new OrgMeta("")));
        vm.prank(alice);
        vm.expectRevert();
        bad.createOrg("x", "", bytes32(0));
        // empty gatewayBase accepted too
        assertEq(bad.orgCount(), 0);
    }
}
