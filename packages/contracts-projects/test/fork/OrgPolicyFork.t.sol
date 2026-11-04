// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {IProjectHook} from "../../src/interfaces/IProjectHook.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IPolicyColl {
    function ownerOf(uint256) external view returns (address);
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function tokenParam(uint256, bytes32) external view returns (bytes32, bool, bool);
    function tokenParamData(uint256, bytes32) external view returns (bytes memory);
    function delegateRegistry() external view returns (address);
    function transferFrom(address, address, uint256) external;
    function name() external view returns (string memory);
}

interface IDelegateRegistryV2 {
    function delegateAll(address to, bytes32 rights, bool enable) external payable returns (bytes32);
    function delegateContract(address to, address contract_, bytes32 rights, bool enable)
        external
        payable
        returns (bytes32);
    function delegateERC721(address to, address contract_, uint256 tokenId, bytes32 rights, bool enable)
        external
        payable
        returns (bytes32);
}

/// @dev Regression tests for two policies frozen into every org, run against the REAL ABX
///      contracts on Base Sepolia (skipped without `ABXFS_RPC_URL_84532`):
///
///      1. delegate.xyz token-owner delegation is disabled, so `ownerOf` is the whole authorization
///         model for a project (audit F1).
///      2. org names are printable ASCII, so ABX's JSON output and the card stay valid for every name
///         the factory accepts (audit F2).
contract OrgPolicyForkTest is Test {
    using LibString for string;

    address constant ABX_F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIR = CONTENT_DIRECTORY_STORE;
    address constant FILES = CONTENT_FILE_STORE;
    /// @dev A collection with published roots, borrowed for a CID the stores really hold.
    address constant PUBLISHED_COLLECTION = 0x7015Ab36fA7d62dAf286561114E7f3c250511E31;
    /// @dev delegate.xyz v2, the same address on every chain.
    address constant DELEGATE_REGISTRY_V2 = 0x00000000000000447e69651d841bD8D104Bed493;
    string constant PREFIX = "data:application/json;base64,";

    OrgFactory f;
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        f = OrgComponents.create(ABX_F, ABX_RENDERER, ABX_SEED, DIR, FILES, address(new OrgMeta("https://fs.abx.io")));
    }

    /// @dev A real directory in the content stores on the fork, so the hook accepts it because the stores hold it.
    function _publishedCid() internal returns (bytes32) {
        return ContentLayer.realDirectory("policy");
    }

    // ─── F1: delegation ──────────────────────────────────────────────────────

    function _writeEveryKey(address org, address who) internal returns (uint256 refused) {
        IPolicyColl c = IPolicyColl(org);
        bytes32 cid = _publishedCid();
        vm.startPrank(who);
        try c.configureTokenParam(0, "abxfs.cid", cid) {} catch { refused++; }
        try c.configureTokenParamData(0, "abxfs.gateway", bytes("https://g.example")) {} catch { refused++; }
        try c.configureTokenParamData(0, "abxfs.name", bytes("n")) {} catch { refused++; }
        try c.configureTokenParamData(0, "abxfs.view", bytes("https://v.example")) {} catch { refused++; }
        try c.configureTokenParamData(0, "abxfs.meta", bytes("m")) {} catch { refused++; }
        vm.stopPrank();
    }

    function test_delegateXyzDelegateCannotWriteAnyAbxFsParam() public {
        vm.prank(alice);
        address org = f.createOrg("Delegation", "", bytes32(0));
        IPolicyColl c = IPolicyColl(org);
        assertEq(c.delegateRegistry(), address(0), "the collection consults no delegation registry");
        assertGt(DELEGATE_REGISTRY_V2.code.length, 0, "delegate.xyz exists on this chain");
        IDelegateRegistryV2 reg = IDelegateRegistryV2(DELEGATE_REGISTRY_V2);

        // Every delegation shape delegate.xyz offers over this token.
        vm.startPrank(alice);
        reg.delegateAll(mallory, bytes32(0), true);
        reg.delegateContract(mallory, org, bytes32(0), true);
        reg.delegateERC721(mallory, org, 0, bytes32(0), true);
        vm.stopPrank();

        assertEq(_writeEveryKey(org, mallory), 5, "a delegate is refused on all five keys");
        (, , bool cidSet) = c.tokenParam(0, "abxfs.cid");
        assertFalse(cidSet, "nothing landed");
        assertEq(c.tokenParamData(0, "abxfs.meta").length, 0);
        assertEq(f.hook().versionCount(org, 0), 0);

        // The real owner is unaffected.
        assertEq(_writeEveryKey(org, alice), 0, "the owner writes all five");
        assertEq(f.hook().versionCount(org, 0), 1);
    }

    function test_tagsStayOnOwnerOfForOwnerAndDelegateAlike() public {
        vm.prank(alice);
        address org = f.createOrg("Tags", "", bytes32(0));
        IPolicyColl c = IPolicyColl(org);
        IProjectHook hook = IProjectHook(address(f.hook())); // read first: a getter would eat a prank
        vm.prank(alice);
        IDelegateRegistryV2(DELEGATE_REGISTRY_V2).delegateAll(mallory, bytes32(0), true);

        bytes32 cid = _publishedCid();
        vm.prank(alice);
        c.configureTokenParam(0, "abxfs.cid", cid);

        vm.prank(mallory);
        vm.expectRevert();
        hook.setTag(org, 0, "v1", 1);
        vm.prank(alice);
        hook.setTag(org, 0, "v1", 1);
        vm.prank(mallory);
        vm.expectRevert();
        hook.removeTag(org, 0, "v1");

        // A buyer inherits tag authority with the token, and the seller loses it.
        vm.prank(alice);
        c.transferFrom(alice, mallory, 0);
        vm.prank(alice);
        vm.expectRevert();
        hook.removeTag(org, 0, "v1");
        vm.prank(mallory);
        hook.removeTag(org, 0, "v1");
    }

    // ─── F2: names ───────────────────────────────────────────────────────────

    function _json(string memory uri) internal pure returns (string memory) {
        require(uri.startsWith(PREFIX), "not a data uri");
        return string(Base64.decode(uri.slice(bytes(PREFIX).length)));
    }

    function _assertSane(string memory name_, bytes32 salt) internal {
        vm.prank(alice);
        address org = f.createOrg(name_, "", salt);
        IPolicyColl c = IPolicyColl(org);

        string memory tj = _json(c.tokenURI(0));
        string memory cj = _json(c.contractURI());
        // Valid JSON (parse reverts otherwise) and every byte printable ASCII, so valid UTF-8.
        vm.parseJson(tj);
        vm.parseJson(cj);
        _assertPrintable(bytes(tj));
        _assertPrintable(bytes(cj));
        // The name field is the name, round-tripped through ABX's escaping.
        assertEq(vm.parseJsonString(cj, ".name"), name_, "contractURI name");
        assertEq(vm.parseJsonString(tj, ".name"), string.concat(name_, " #0"), "tokenURI name");

        // The card cannot be made to carry markup from the name.
        string memory marker = "data:image/svg+xml;base64,";
        uint256 at = tj.indexOf(marker);
        assertTrue(at != LibString.NOT_FOUND, "card present");
        string memory rest = tj.slice(at + bytes(marker).length);
        string memory svg = string(Base64.decode(rest.slice(0, rest.indexOf('"'))));
        assertFalse(svg.contains("<script"), "no script element in the card");
        assertFalse(svg.contains("</text><script"), "the name cannot close its element");
        if (vm.envOr("ABXFS_SHOW_CARD", false)) console2.log(svg);
    }

    function _assertPrintable(bytes memory b) internal pure {
        // One assertion per document, not per byte: the collection document now carries two base64 SVGs,
        // and a cheatcode call per byte put the every-byte sweep below over the per-test gas budget.
        bool ok = true;
        for (uint256 i; i < b.length; ++i) ok = ok && b[i] >= 0x20 && b[i] <= 0x7e;
        assertTrue(ok, "non-printable byte in metadata");
    }

    function test_extremeValidNamesKeepMetadataValid() public {
        string[8] memory names = [
            "<script>\"\\'&",
            "</text><script>alert(1)</script>&amp;'",
            'X","animation_url":"https://evil.example","y":"\\',
            "A\\u0000B\\n\\\\",
            "{{7*7}} ${x} %s %n",
            "ABX FS",
            "a",
            " leading and trailing "
        ];
        for (uint256 i; i < names.length; ++i) {
            _assertSane(names[i], bytes32(uint256(100 + i)));
        }
        // The widest and nastiest 64-byte names.
        bytes memory q = new bytes(64);
        for (uint256 i; i < 64; ++i) q[i] = '"';
        _assertSane(string(q), bytes32(uint256(200)));
        for (uint256 i; i < 64; ++i) q[i] = "\\";
        _assertSane(string(q), bytes32(uint256(201)));
        for (uint256 i; i < 64; ++i) q[i] = "<";
        _assertSane(string(q), bytes32(uint256(202)));
        for (uint256 i; i < 64; ++i) q[i] = "&";
        _assertSane(string(q), bytes32(uint256(203)));
    }

    /// @dev The card header is the name, entity-escaped; ABX's own name field is JSON-escaped.
    function test_theCardHeaderEscapesTheName() public {
        vm.prank(alice);
        address org = f.createOrg("<script>\"\\'&", "", bytes32(uint256(300)));
        string memory tj = _json(IPolicyColl(org).tokenURI(0));
        string memory marker = "data:image/svg+xml;base64,";
        string memory rest = tj.slice(tj.indexOf(marker) + bytes(marker).length);
        string memory svg = string(Base64.decode(rest.slice(0, rest.indexOf('"'))));
        assertTrue(svg.contains("&lt;script&gt;&quot;\\&#39;&amp;"), "escaped in the header");
    }

    function test_everyPrintableAsciiByteAsAName() public {
        for (uint256 c = 0x20; c <= 0x7e; ++c) {
            bytes memory one = abi.encodePacked(bytes1(uint8(c)), "x");
            _assertSane(string(one), bytes32(uint256(1000 + c)));
        }
    }

    function test_refusedNamesNeverReachAbx() public {
        bytes[8] memory bad = [
            bytes(hex"00"),
            bytes(hex"410a42"),
            bytes(hex"417f42"),
            bytes(hex"c3a9"),
            bytes(hex"41ff42"),
            bytes("   "),
            bytes(""),
            new bytes(65)
        ];
        for (uint256 i; i < bad.length; ++i) {
            if (i == 7) for (uint256 j; j < 65; ++j) bad[i][j] = "a";
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSignature("InvalidName()"));
            f.createOrg(string(bad[i]), "", bytes32(0));
        }
        assertEq(f.orgCount(), 0);
    }
}
