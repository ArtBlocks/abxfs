// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IMetaColl {
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function contractURIRenderer() external view returns (address);
    function contractURILocked() external view returns (bool);
    function contractField(bytes32) external view returns (bytes32, bytes memory);
    function contractFieldLocked(bytes32) external view returns (bool);
    function setContractField(bytes32, bytes32, bytes calldata) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
}

/// @dev `OrgMeta` against the REAL ABX on Base Sepolia: that ABX's own `AbxMetadataRenderer` takes our
///      `name` renderer for every token, that the org's `contractURI()` is our document, and that the new
///      fields are frozen. Skipped unless `ABXFS_RPC_URL_84532` is set.
contract OrgMetaForkTest is Test {
    using LibString for string;

    address constant ABX_SERIES_CODE_FACTORY = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIRECTORY_STORE = CONTENT_DIRECTORY_STORE;
    address constant FILE_STORE = CONTENT_FILE_STORE;
    string constant PREFIX = "data:application/json;base64,";
    string constant SVG_PREFIX = "data:image/svg+xml;base64,";
    string constant DESC = "Sites by the Acme team.\nEach one is stored on chain, \"as is\" & <unescaped> here.";

    OrgFactory factory;
    OrgMeta meta;
    address admin = makeAddr("admin");
    address plain;
    address described;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();

        meta = new OrgMeta("https://fs.abx.io");
        factory = OrgComponents.create(
            ABX_SERIES_CODE_FACTORY, ABX_RENDERER, ABX_SEED, DIRECTORY_STORE, FILE_STORE, address(meta)
        );
        vm.startPrank(admin);
        plain = factory.createOrg("Fork Org", "", bytes32(0));
        described = factory.createOrg("A&B <Sites> \"Co\" 'x' \\", DESC, bytes32(0));
        vm.stopPrank();
    }

    function _json(string memory uri) internal pure returns (string memory) {
        assertTrue(uri.startsWith(PREFIX), "on-chain JSON");
        return string(Base64.decode(uri.slice(bytes(PREFIX).length)));
    }

    function _tokenName(address org, uint256 id) internal view returns (string memory) {
        return vm.parseJsonString(_json(IMetaColl(org).tokenURI(id)), ".name");
    }

    function test_realTokenURIUsesTheProjectName() public {
        IMetaColl c = IMetaColl(plain);
        assertEq(_tokenName(plain, 0), "Fork Org #0", "unset: the org's fallback");

        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.name", "My Site");
        assertEq(_tokenName(plain, 0), "My Site", "the project's name, through ABX's real renderer");

        string memory tricky = "A \"quoted\" \\ <name> & more";
        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.name", bytes(tricky));
        assertEq(_tokenName(plain, 0), tricky, "ABX escapes it; the document still parses");

        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.name", bytes(unicode"café"));
        assertEq(_tokenName(plain, 0), "Fork Org #0", "non-ASCII falls back");
        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.name", "-");
        assertEq(_tokenName(plain, 0), "Fork Org #0", "the cleared marker falls back");

        // The rest of the token document is unchanged: the card, and no description for an org without one.
        string memory json = _json(c.tokenURI(0));
        assertTrue(vm.parseJsonString(json, ".image").startsWith(SVG_PREFIX));
        assertFalse(vm.keyExistsJson(json, ".description"));
    }

    /// @dev ABX's `_field` falls back from token scope to collection scope, so an org's description is
    ///      every project's description too.
    function test_realDescriptionIsEveryTokensFallback() public view {
        string memory json = _json(IMetaColl(described).tokenURI(0));
        assertEq(vm.parseJsonString(json, ".description"), DESC);
        assertEq(vm.parseJsonString(json, ".name"), "A&B <Sites> \"Co\" 'x' \\ #0");
    }

    function test_realContractURIIsOurs() public view {
        IMetaColl c = IMetaColl(described);
        assertEq(c.contractURIRenderer(), address(meta));
        assertTrue(c.contractURILocked());
        string memory uri = c.contractURI();
        assertEq(uri, meta.contractURI(described), "the org's contractURI() is OrgMeta's document");

        string memory json = _json(uri);
        string[] memory keys = vm.parseJsonKeys(json, "$");
        assertEq(keys.length, 5, "name, description, image, banner_image, external_link");
        assertEq(vm.parseJsonString(json, ".name"), "A&B <Sites> \"Co\" 'x' \\");
        assertEq(vm.parseJsonString(json, ".description"), DESC);
        assertEq(vm.parseJsonString(json, ".external_link"), "https://fs.abx.io");
        string memory logo = vm.parseJsonString(json, ".image");
        assertTrue(logo.startsWith(SVG_PREFIX), "a drawn logo");
        // The monogram of "A&B <Sites> ...": "A" and "<", escaped.
        assertTrue(string(Base64.decode(logo.slice(bytes(SVG_PREFIX).length))).contains(">A&lt;</text>"));
        assertTrue(vm.parseJsonString(json, ".banner_image").startsWith(SVG_PREFIX));

        string memory plainJson = _json(IMetaColl(plain).contractURI());
        assertTrue(vm.parseJsonString(plainJson, ".description").startsWith("Fork Org is an org on ABX FS."));
    }

    function test_realFieldsAreWiredAndLocked() public {
        IMetaColl c = IMetaColl(described);
        (bytes32 rep, bytes memory value) = c.contractField("name");
        assertEq(rep, bytes32("renderer"));
        assertEq(abi.decode(value, (address)), address(meta));
        (rep, value) = c.contractField("description");
        assertEq(rep, bytes32("inline"));
        assertEq(value, bytes(DESC));

        bytes32[6] memory fields =
            [bytes32("image"), "attributes", "animation_url", "external_url", "name", "description"];
        for (uint256 i; i < 6; ++i) {
            assertTrue(c.contractFieldLocked(fields[i]), "locked");
        }
        assertFalse(IMetaColl(plain).contractFieldLocked("description"), "never set, so never locked");
        // And nobody can set one: the org is renounced.
        address[3] memory who = [admin, address(factory), address(this)];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert();
            IMetaColl(plain).setContractField("description", "inline", "x");
        }
    }

    function test_realGas() public {
        bytes memory n = new bytes(128);
        for (uint256 i; i < 128; ++i) n[i] = '"';
        vm.prank(admin);
        IMetaColl(described).configureTokenParamData(0, "abxfs.name", n);
        uint256 g = gasleft();
        IMetaColl(described).tokenURI(0);
        console2.log("tokenURI gas (128-byte name)", g - gasleft());
        g = gasleft();
        IMetaColl(described).contractURI();
        console2.log("contractURI gas", g - gasleft());
        g = gasleft();
        IMetaColl(described).contractField("description");
        console2.log("contractField(description) gas", g - gasleft());
    }
}
