// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "../fork/ContentLayer.sol";

interface IC {
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
}

contract AuditRenderersForkTest is Test {
    using LibString for string;
    address constant F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant R = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant S = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant D = CONTENT_DIRECTORY_STORE;
    address constant FS = CONTENT_FILE_STORE;
    OrgFactory factory;
    address admin = makeAddr("admin");
    string constant P = "data:application/json;base64,";

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        factory = OrgComponents.create(F, R, S, D, FS, address(new OrgMeta("https://fs.abx.io")));
    }

    function _json(string memory uri) internal pure returns (string memory) {
        if (!uri.startsWith(P)) return uri; // maybe raw json
        return string(Base64.decode(uri.slice(bytes(P).length)));
    }

    function _mk(string memory name, bytes32 salt) internal returns (address org) {
        vm.prank(admin);
        org = factory.createOrg(name, "", salt);
    }

    // The org-name PoCs here (F2) were converted: see test/fork/OrgPolicyFork.t.sol.
    // test_viewValues is informational; the abxfs.view charset is now asserted in test/Orgs.t.sol.
    // ACCEPTED RISK (owner decision): no returndata caps in the renderers (F3 part 1); gas below is the measured worst case.
    function test_viewValues() public {
        address org = _mk("V", bytes32(uint256(4)));
        string[6] memory vs = [
            "https://good.com@evil.com/",
            "https://a'onload='x",
            "https://a.b/%22%3E",
            "https://a.b/{}[]",
            "https://xn--80ak6aa92e.com/",
            "https://a.b/&amp;#x3c;"
        ];
        for (uint256 i; i < vs.length; ++i) {
            vm.prank(admin);
            IC(org).configureTokenParamData(0, "abxfs.view", bytes(vs[i]));
            string memory j = _json(IC(org).tokenURI(0));
            console2.log("VIEWJSON", j);
        }
    }

    function test_gasAndSizeWorstCase() public {
        bytes memory n = new bytes(64);
        for (uint256 i; i < 64; ++i) n[i] = '"';
        address org = _mk(string(n), bytes32(uint256(6)));
        vm.startPrank(admin);
        bytes memory nm = new bytes(128); for (uint256 i; i < 128; ++i) nm[i] = '"';
        IC(org).configureTokenParamData(0, "abxfs.name", nm);
        bytes memory v = new bytes(512); for (uint256 i; i < 512; ++i) v[i] = "a";
        v[0]="h";v[1]="t";v[2]="t";v[3]="p";v[4]="s";v[5]=":";v[6]="/";v[7]="/";
        IC(org).configureTokenParamData(0, "abxfs.view", v);
        bytes memory g = new bytes(512); for (uint256 i; i < 512; ++i) g[i] = "g";
        IC(org).configureTokenParamData(0, "abxfs.gateway", g);
        vm.stopPrank();
        uint256 gs = gasleft();
        string memory tu = IC(org).tokenURI(0);
        console2.log("tokenURI gas", gs - gasleft());
        console2.log("tokenURI bytes", bytes(tu).length);
        gs = gasleft();
        string memory cu = IC(org).contractURI();
        console2.log("contractURI gas", gs - gasleft());
        console2.log("contractURI bytes", bytes(cu).length);
        console2.log(_json(tu).contains('"name":"') ? "name field present" : "no name");
    }
}
