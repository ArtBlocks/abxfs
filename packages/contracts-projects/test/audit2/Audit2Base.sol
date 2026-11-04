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

/// @dev The slice of the real ABX SeriesCode clone the re-audit drives.
interface IA2Coll {
    function owner() external view returns (address);
    function name() external view returns (string memory);
    function ownerOf(uint256) external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function getApproved(uint256) external view returns (address);
    function isApprovedForAll(address, address) external view returns (bool);
    function approve(address, uint256) external;
    function setApprovalForAll(address, bool) external;
    function transferFrom(address, address, uint256) external;
    function safeTransferFrom(address, address, uint256) external;
    function safeTransferFrom(address, address, uint256, bytes calldata) external;
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function tokenParam(uint256, bytes32) external view returns (bytes32, bool, bool);
    function tokenParamData(uint256, bytes32) external view returns (bytes memory);
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function setTokenParam(uint256, bytes32, bytes32) external;
    function setTokenParamData(uint256, bytes32, bytes calldata) external;
    function clearTokenParam(uint256, bytes32) external;
    function delegateRegistry() external view returns (address);
    function mint(address) external returns (uint256);
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
    function burn(uint256) external;
    function paramHooks() external view returns (address, address, address);
    function paramHooksLocked() external view returns (bool);
    function nextTokenId() external view returns (uint256);
}

abstract contract Audit2Base is Test {
    address constant ABX_F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIR = CONTENT_DIRECTORY_STORE;
    address constant FILES = CONTENT_FILE_STORE;
    address constant DEPLOYED_FACTORY = 0x8A6fb64B3065b8F6EF49C637A48A0e0011a6e5f9;
    string constant GATEWAY = "https://fs.abx.io";

    OrgFactory f;
    ProjectHook hook;
    ProjectEnumeration en;
    Lens lens;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    function _fork() internal {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        f = OrgComponents.create(ABX_F, ABX_RENDERER, ABX_SEED, DIR, FILES, address(new OrgMeta(GATEWAY)));
        hook = f.hook();
        en = f.enumeration();
        lens = new Lens(address(f), address(hook));
    }

    /// @dev Make the stores report `cid` as a directory (cheap stand-in for real content; the hook's
    ///      whole relationship with the stores is these two predicates).
    function _dirRoot(bytes32 cid) internal {
        vm.mockCall(DIR, abi.encodeWithSignature("directoryExists(bytes32)", cid), abi.encode(true));
    }

    function _fileRoot(bytes32 cid) internal {
        vm.mockCall(FILES, abi.encodeWithSignature("fileExists(bytes32)", cid), abi.encode(true));
    }

    function _newOrg(address who, string memory nm) internal returns (address org) {
        vm.prank(who);
        org = f.createOrg(nm, "", bytes32(0));
    }
}
