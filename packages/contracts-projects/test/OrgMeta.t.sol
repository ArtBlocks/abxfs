// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgComponents} from "../script/OrgComponents.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {IOrgFactory} from "../src/interfaces/IOrgFactory.sol";
import {AbxContractField} from "../src/interfaces/IAbxOrgDeploy.sol";

import {MockStore} from "./mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection} from "./mocks/AbxMocks.sol";

/// @dev A contract whose every answer is scripted, per exact calldata or per selector, so a test can make
///      any read `OrgMeta` performs come back well formed, reverting, gas-burning, oversized or as
///      arbitrary bytes. Modes: 0 return `data` verbatim, 1 revert, 2 burn all gas, 3 a 1 MiB returndata
///      bomb, 4 a declared length of 2^256-1, 5 64 KiB of garbage (affordable, so the copy cap is what
///      bounds it, not the gas cap).
contract Scripted {
    struct R {
        uint8 mode;
        bool set;
        bytes data;
    }

    mapping(bytes32 => R) internal _byCall;
    mapping(bytes4 => R) internal _bySig;

    function onCall(bytes calldata cd, uint8 mode, bytes calldata data) external {
        _byCall[keccak256(cd)] = R(mode, true, data);
    }

    function onSig(bytes4 sig, uint8 mode, bytes calldata data) external {
        _bySig[sig] = R(mode, true, data);
    }

    fallback(bytes calldata cd) external returns (bytes memory) {
        R memory r = _byCall[keccak256(cd)];
        if (!r.set) r = _bySig[msg.sig];
        uint256 m = r.mode % 6;
        if (m == 1) revert("scripted");
        if (m == 2) {
            uint256 x;
            while (gasleft() > 0) ++x;
        }
        if (m == 3) {
            assembly {
                return(0, 0x100000)
            }
        }
        if (m == 4) {
            assembly {
                mstore(0, 0x20)
                mstore(0x20, not(0))
                return(0, 0x40)
            }
        }
        if (m == 5) {
            assembly {
                mstore(0, 0x20)
                mstore(0x20, 0xffff)
                return(0, 0x10000)
            }
        }
        return r.data;
    }
}

contract OrgMetaTest is Test {
    using LibString for string;

    string internal constant GATEWAY = "https://fs.abx.io";
    string internal constant JSON_PREFIX = "data:application/json;base64,";
    string internal constant SVG_PREFIX = "data:image/svg+xml;base64,";
    address internal constant RENDERER = address(0xBEEF01);

    MockAbxFactory internal abxFactory;
    OrgFactory internal factory;
    OrgMeta internal meta;
    address internal alice = makeAddr("alice");

    bytes4 internal constant CONTRACT_FIELD = bytes4(keccak256("contractField(bytes32)"));
    bytes4 internal constant NAME = bytes4(keccak256("name()"));
    bytes4 internal constant PARAM_DATA = bytes4(keccak256("tokenParamData(uint256,bytes32)"));

    function setUp() public {
        abxFactory = new MockAbxFactory();
        meta = new OrgMeta(GATEWAY);
        factory = OrgComponents.create(
            address(abxFactory), RENDERER, address(0xBEEF02), address(new MockStore()), address(new MockStore()), address(meta)
        );
    }

    function _create(string memory name, string memory description) internal returns (MockOrgCollection org) {
        vm.prank(alice);
        org = MockOrgCollection(factory.createOrg(name, description, bytes32(0)));
    }

    function _ascii(uint256 n, bytes1 c) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = c;
        return string(b);
    }

    function _json(string memory uri) internal pure returns (string memory) {
        assertTrue(uri.startsWith(JSON_PREFIX), "a JSON data URI");
        return string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
    }

    function _svg(string memory uri) internal pure returns (string memory svg) {
        assertTrue(uri.startsWith(SVG_PREFIX), "an SVG data URI");
        svg = string(Base64.decode(uri.slice(bytes(SVG_PREFIX).length)));
        assertTrue(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""), "an SVG document");
        assertTrue(svg.endsWith("</svg>"), "a closed SVG document");
    }

    function _has(string[] memory keys, string memory k) internal pure returns (bool) {
        for (uint256 i; i < keys.length; ++i) {
            if (keccak256(bytes(keys[i])) == keccak256(bytes(k))) return true;
        }
        return false;
    }

    function _name(address token, uint256 id) internal view returns (string memory) {
        (string memory ct, bytes memory data) = meta.render(token, id, "name");
        assertEq(ct, "text/plain");
        return string(data);
    }

    // ─── The collection document ─────────────────────────────────────────────

    function test_contractURI_withDescription() public {
        string memory desc = "Line one, \"quoted\" and \\ back.\nLine two: <b>not markup</b> & more.";
        MockOrgCollection org = _create("Acme", desc);
        // The org's own `contractURI()` is ours: the mock forwards to `contractURIRenderer`, as ABX does.
        string memory json = _json(org.contractURI());

        string[] memory keys = vm.parseJsonKeys(json, "$");
        assertEq(keys.length, 5);
        assertTrue(_has(keys, "name") && _has(keys, "description") && _has(keys, "image"));
        assertTrue(_has(keys, "banner_image") && _has(keys, "external_link"));
        assertEq(vm.parseJsonString(json, ".name"), "Acme");
        assertEq(vm.parseJsonString(json, ".description"), desc, "the description, exactly");
        assertEq(vm.parseJsonString(json, ".external_link"), GATEWAY, "the ABX FS site, not the org page");

        // The logo is a monogram drawn here, not the card: one letter for a one-word name.
        string memory logo = _svg(vm.parseJsonString(json, ".image"));
        assertTrue(logo.contains('viewBox="0 0 400 400"'));
        assertTrue(logo.contains(">A</text>"));
        assertTrue(logo.contains(">ABX FS</text>"));
        string memory banner = _svg(vm.parseJsonString(json, ".banner_image"));
        assertTrue(banner.contains('viewBox="0 0 1400 350"'));
        assertTrue(banner.contains(">Acme</text>"));
    }

    function test_contractURI_withoutDescriptionUsesTheStandardText() public {
        MockOrgCollection org = _create("Acme", "");
        string memory json = _json(org.contractURI());
        assertEq(vm.parseJsonKeys(json, "$").length, 5);
        assertEq(
            vm.parseJsonString(json, ".description"),
            "Acme is an org on ABX FS. Each token in it is a project: a website or set of files."
        );
    }

    function test_contractURI_namesThatNeedEscaping() public {
        string[4] memory names = [
            string("A&B <C> \"D\" 'E' \\F"),
            "<script>alert(1)</script>",
            _ascii(64, '"'),
            _ascii(64, "\\")
        ];
        for (uint256 i; i < names.length; ++i) {
            MockOrgCollection org = _create(names[i], "");
            string memory json = _json(org.contractURI());
            assertEq(vm.parseJsonString(json, ".name"), names[i], "the name survives JSON");
            string memory banner = _svg(vm.parseJsonString(json, ".banner_image"));
            assertTrue(banner.contains(string.concat(">", LibString.escapeHTML(names[i]), "</text>")), "escaped for XML");
            if (i < 3) assertFalse(banner.contains(names[i]), "never raw");
            // Every image the document carries still decodes.
            string memory logo = _svg(vm.parseJsonString(json, ".image"));
            assertTrue(logo.contains(string.concat(">", _monogram(names[i]), "</text>")), "escaped monogram");
        }
    }

    function test_contractURI_maxLengthNameAndDescription() public {
        string memory name = _ascii(64, "W");
        bytes memory d = bytes(_ascii(1000, "d"));
        d[500] = "\n";
        MockOrgCollection org = _create(name, string(d));
        string memory json = _json(org.contractURI());
        assertEq(vm.parseJsonString(json, ".name"), name);
        assertEq(vm.parseJsonString(json, ".description"), string(d));
        // 64 monospace characters at 1900/64 = 29px (about 1240px) fit in the 1352px frame.
        assertTrue(_svg(vm.parseJsonString(json, ".banner_image")).contains('font-size="29"'));
    }

    // ─── Token names ─────────────────────────────────────────────────────────

    function test_tokenName_rules() public {
        MockOrgCollection org = _create("Acme", "");
        address o = address(org);
        assertEq(_name(o, 0), "Acme #0", "unset: the org's fallback");
        assertEq(_name(o, type(uint256).max), "Acme", "the collection surface is the org name");
        assertEq(_name(o, 7), "Acme #7", "a token that does not exist yet is still named");

        string[6] memory refused = [
            string(unicode"café"), // UTF-8
            "   ", // only spaces
            "-", // the SDK's cleared marker
            "tab\there",
            "nul\x00",
            "del\x7f"
        ];
        for (uint256 i; i < refused.length; ++i) {
            vm.prank(alice);
            org.configureTokenParamData(0, "abxfs.name", bytes(refused[i]));
            assertEq(_name(o, 0), "Acme #0", refused[i]);
        }

        string[4] memory used = [string("My Site"), " padded ", "A&B <C> \"D\" 'E' \\F", "--"];
        for (uint256 i; i < used.length; ++i) {
            vm.prank(alice);
            org.configureTokenParamData(0, "abxfs.name", bytes(used[i]));
            assertEq(_name(o, 0), used[i]);
        }
        vm.prank(alice);
        org.configureTokenParamData(0, "abxfs.name", bytes(_ascii(128, "n")));
        assertEq(_name(o, 0), _ascii(128, "n"), "128 bytes is the hook's cap and is used");

        // Another field is a miswiring: empty, never a revert.
        (, bytes memory other) = meta.render(o, 0, "description");
        assertEq(other.length, 0);
    }

    /// @dev Over the cap. The hook refuses a 129-byte name, so this needs a token the hook never saw.
    function test_tokenName_tooLongFallsBack() public {
        Scripted t = new Scripted();
        t.onSig(NAME, 0, abi.encode("Org"));
        t.onSig(PARAM_DATA, 0, abi.encode(bytes(_ascii(129, "n"))));
        assertEq(_name(address(t), 3), "Org #3");
        t.onSig(PARAM_DATA, 0, abi.encode(bytes(_ascii(128, "n"))));
        assertEq(_name(address(t), 3), _ascii(128, "n"));
    }

    // ─── Never reverts ───────────────────────────────────────────────────────

    function test_noCodeToken() public view {
        string memory json = _json(meta.contractURI(address(0xdead)));
        assertEq(vm.parseJsonString(json, ".name"), "Untitled org");
        assertTrue(_logoOf(address(0xdead)).contains(">UO</text>"), "the fallback name's monogram");
        assertEq(_name(address(0xdead), 5), "Untitled org #5");
        assertEq(_name(address(0), type(uint256).max), "Untitled org");
    }

    /// @dev Both reads (`name()`, the description field) behave in any of the six ways, or return fuzzed
    ///      bytes, and the document is still valid JSON with all five keys and two decodable SVGs.
    function testFuzz_contractURINeverReverts(
        uint8[2] calldata modes,
        bool[2] calldata garbage,
        bytes calldata junk,
        string calldata desc
    ) public {
        Scripted token = new Scripted();
        bytes[2] memory good = [abi.encode("Acme"), abi.encode(bytes32("inline"), bytes(desc))];
        bytes[2] memory cd =
            [abi.encodeWithSelector(NAME), abi.encodeWithSelector(CONTRACT_FIELD, bytes32("description"))];
        for (uint256 i; i < 2; ++i) {
            token.onCall(cd[i], modes[i], garbage[i] ? junk : good[i]);
        }
        string memory json = _json(meta.contractURI(address(token)));
        assertEq(vm.parseJsonKeys(json, "$").length, 5);
        _svg(vm.parseJsonString(json, ".banner_image"));
        _svg(vm.parseJsonString(json, ".image"));
        _printableOnly(bytes(vm.parseJsonString(json, ".name")));
        _printableOnly(bytes(vm.parseJsonString(json, ".description")));
    }

    /// @dev Any name the factory could accept: the logo is a valid SVG whose monogram is the escaped
    ///      initials, and nothing from the name reaches the SVG raw.
    function testFuzz_logoForAnyName(bytes calldata raw) public {
        bytes memory b = new bytes(raw.length > 64 ? 64 : raw.length);
        for (uint256 i; i < b.length; ++i) b[i] = bytes1(uint8(0x20 + uint8(raw[i]) % 95));
        Scripted t = new Scripted();
        t.onSig(NAME, 0, abi.encode(string(b)));
        string memory logo = _logoOf(address(t));
        bool visible;
        for (uint256 i; i < b.length; ++i) if (b[i] != " ") visible = true;
        string memory expected = visible ? _monogram(string(b)) : "UO"; // all spaces: "Untitled org"
        assertTrue(logo.contains(string.concat(">", expected, "</text>")), "the escaped monogram");
    }

    /// @dev Reference: the first visible character of each of the first two words, uppercased, escaped.
    function _monogram(string memory name) internal pure returns (string memory) {
        bytes memory b = bytes(name);
        string memory m;
        uint256 n;
        for (uint256 i; i < b.length && n < 2; ++i) {
            if (b[i] != " " && (i == 0 || b[i - 1] == " ")) {
                m = string.concat(m, string(abi.encodePacked(b[i])));
                ++n;
            }
        }
        return n == 0 ? "B" : LibString.escapeHTML(LibString.upper(m));
    }

    function _logoOf(address token) internal view returns (string memory) {
        return _svg(vm.parseJsonString(_json(meta.contractURI(token)), ".image"));
    }

    function test_logoMonogram() public {
        string[10] memory names = [
            string("acme"), // one word: one letter, uppercased
            "acme sites co", // two words at most
            "  padded   name  ",
            "& < > \" '", // escaped: &amp; &lt;
            "\" '", // &quot;&#39;
            "x<y z>w", // only word starts count: X, Z
            "9 lives",
            "~",
            "a", // the shortest name
            "Untitled org"
        ];
        string[10] memory want = [
            string(">A</text>"),
            ">AS</text>",
            ">PN</text>",
            ">&amp;&lt;</text>",
            ">&quot;&#39;</text>",
            ">XZ</text>",
            ">9L</text>",
            ">~</text>",
            ">A</text>",
            ">UO</text>"
        ];
        for (uint256 i; i < names.length; ++i) {
            Scripted t = new Scripted();
            t.onSig(NAME, 0, abi.encode(names[i]));
            string memory logo = _logoOf(address(t));
            assertTrue(logo.contains(want[i]), names[i]);
            assertEq(_monogram(names[i]), LibString.slice(want[i], 1, bytes(want[i]).length - 7));
            // One letter is drawn larger than two.
            assertTrue(logo.contains(bytes(want[i]).length == 9 ? 'font-size="160"' : 'font-size="132"'));
        }
        // A name with nothing visible after filtering reads as "Untitled org"; "B" is the last resort in code.
        Scripted e = new Scripted();
        e.onSig(NAME, 0, abi.encode(string(hex"e2808b0a")));
        assertTrue(_logoOf(address(e)).contains(">UO</text>"));
    }

    function testFuzz_renderNeverReverts(uint8 nameMode, uint8 paramMode, bytes calldata junk, uint256 id, bool garbage)
        public
    {
        Scripted token = new Scripted();
        token.onSig(NAME, nameMode, garbage ? junk : abi.encode("Acme"));
        token.onSig(PARAM_DATA, paramMode, garbage ? junk : abi.encode(junk));
        (, bytes memory n) = meta.render(address(token), id, "name");
        assertGt(n.length, 0);
        _printableOnly(n);
        (, n) = meta.render(address(token), id, bytes32(id));
        assertTrue(n.length == 0 || bytes32(id) == "name");
    }

    /// @dev The specific hostile shapes, each alone, against a token that is otherwise well formed.
    function test_hostileShapes() public {
        for (uint8 m = 1; m < 6; ++m) {
            Scripted token = new Scripted();
            token.onSig(NAME, 0, abi.encode("Acme"));
            token.onSig(CONTRACT_FIELD, m, "");
            string memory json = _json(meta.contractURI(address(token)));
            assertEq(vm.parseJsonString(json, ".name"), "Acme");
            assertTrue(vm.parseJsonString(json, ".description").contains("is an org on ABX FS"));

            token.onSig(NAME, m, "");
            assertEq(vm.parseJsonString(_json(meta.contractURI(address(token))), ".name"), "Untitled org");
            assertEq(_name(address(token), 1), "Untitled org #1");
        }
        // `name()` that answers a non-string, a word with a short tail, and a string of the wrong shape.
        Scripted t = new Scripted();
        t.onSig(NAME, 0, abi.encode(uint256(2)));
        assertEq(_name(address(t), 0), "Untitled org #0");
        t.onSig(NAME, 0, abi.encodePacked(uint256(0x20), uint256(10), bytes4("abcd")));
        assertEq(_name(address(t), 0), "Untitled org #0");
        // Non-printable bytes in a name are dropped, not escaped.
        t.onSig(NAME, 0, abi.encode(string(hex"4163e2808b6d650a"))); // "Ac", a zero-width space, "me", a newline
        assertEq(_name(address(t), 0), "Acme #0");
        // A description that is not `inline`, or carries a byte the factory would refuse, is replaced.
        t.onCall(abi.encodeWithSelector(CONTRACT_FIELD, bytes32("description")), 0, abi.encode(bytes32("url"), bytes("x")));
        assertTrue(vm.parseJsonString(_json(meta.contractURI(address(t))), ".description").contains("is an org on ABX FS"));
        t.onCall(abi.encodeWithSelector(CONTRACT_FIELD, bytes32("description")), 0, abi.encode(bytes32("inline"), bytes("a\tb")));
        assertTrue(vm.parseJsonString(_json(meta.contractURI(address(t))), ".description").contains("is an org on ABX FS"));
        t.onCall(abi.encodeWithSelector(CONTRACT_FIELD, bytes32("description")), 0, abi.encode(bytes32("inline"), bytes(_ascii(1001, "d"))));
        assertTrue(vm.parseJsonString(_json(meta.contractURI(address(t))), ".description").contains("is an org on ABX FS"));
    }

    /// @dev The caps are generous: a real org's reads cost a small fraction of them.
    function test_gasOfARealOrgIsFarBelowTheCaps() public {
        MockOrgCollection org = _create(_ascii(64, "&"), _ascii(1000, "d"));
        uint256 g = gasleft();
        meta.contractURI(address(org));
        emit log_named_uint("contractURI gas (mock org, max name and description)", g - gasleft());
        g = gasleft();
        meta.render(address(org), 0, "name");
        emit log_named_uint("render name gas (unset, fallback)", g - gasleft());
    }

    function _printableOnly(bytes memory b) internal pure {
        for (uint256 i; i < b.length; ++i) {
            assertTrue(uint8(b[i]) >= 0x20 && uint8(b[i]) <= 0x7e, "printable ASCII only");
        }
    }

    // ─── The factory side ────────────────────────────────────────────────────

    function test_createOrg_wiresTheCollectionDocumentAndNames() public {
        MockOrgCollection org = _create("Acme", "About Acme.");
        assertEq(org.contractURIRenderer(), address(meta), "the collection document is ours");
        assertEq(org.tokenURIRenderer(), RENDERER, "token metadata is still ABX's");
        assertEq(factory.orgMeta(), address(meta));
        assertEq(address(factory.links()), address(meta.links()));
        assertEq(org.contractFieldCount(), 6);

        (bytes32 rep, bytes memory value) = org.contractField("name");
        assertEq(rep, bytes32("renderer"));
        assertEq(abi.decode(value, (address)), address(meta));
        (rep, value) = org.contractField("description");
        assertEq(rep, bytes32("inline"));
        assertEq(value, bytes("About Acme."), "raw bytes, as ABX's inline representation carries them");

        bytes32[6] memory fields =
            [bytes32("image"), "attributes", "animation_url", "external_url", "name", "description"];
        for (uint256 i; i < 6; ++i) {
            assertEq(org.contractFieldAt(i).field, fields[i]);
            assertTrue(org.contractFieldLocked(fields[i]), "every field is locked");
        }
        assertEq(org.owner(), address(0), "and renounced");

        // A project's name, once set, is its token name.
        vm.prank(alice);
        org.configureTokenParamData(0, "abxfs.name", "My Site");
        assertEq(_name(address(org), 0), "My Site");
    }

    function test_createOrg_noDescriptionNoField() public {
        MockOrgCollection org = _create("Acme", "");
        assertEq(org.contractFieldCount(), 5);
        (, bytes memory value) = org.contractField("description");
        assertEq(value.length, 0);
    }

    function test_factoryRefusesAnOrgMetaWithNoCode() public {
        vm.expectRevert();
        new OrgFactory(address(abxFactory), RENDERER, address(0xBEEF02), address(1), address(2), address(0xdead), address(0xdead));
    }

    function _refuse(bytes memory d) internal {
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidDescription.selector);
        factory.createOrg("Acme", string(d), bytes32(0));
    }

    function test_descriptionBounds() public {
        vm.startPrank(alice);
        factory.createOrg("Acme", "", bytes32(0));
        factory.createOrg("Acme", "x", bytes32(0));
        factory.createOrg("Acme", _ascii(1000, "x"), bytes32(0));
        factory.createOrg("Acme", "line one\nline two", bytes32(0));
        factory.createOrg("Acme", "\n x \n", bytes32(0));
        vm.stopPrank();
        _refuse(bytes(_ascii(1001, "x")));
        _refuse(" ");
        _refuse("\n");
        _refuse(" \n \n");
        _refuse(bytes(_ascii(1000, " ")));
        _refuse("a\tb"); // tab
        _refuse("a\rb"); // CR
        _refuse("a\r\nb"); // CRLF
        _refuse(hex"617f62"); // DEL
        _refuse(hex"6100"); // NUL
        _refuse(unicode"café"); // UTF-8
        _refuse(hex"41ff42"); // invalid UTF-8
        _refuse(hex"61e280ae62"); // bidi override
    }

    function test_descriptionEveryByteValue() public {
        for (uint256 v; v < 256; ++v) {
            bool ok = (v >= 0x20 && v <= 0x7e) || v == 0x0a;
            vm.prank(alice);
            if (!ok) vm.expectRevert(IOrgFactory.InvalidDescription.selector);
            factory.createOrg("Acme", string(abi.encodePacked("a", bytes1(uint8(v)))), bytes32(0));
        }
    }

    /// @dev The name is checked first, and nothing is deployed for a refused description.
    function test_descriptionCheckedBeforeAnythingIsDeployed() public {
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        factory.createOrg("", "\t", bytes32(0));
        _refuse("\t");
        assertEq(factory.orgCount(), 0);
        assertEq(abxFactory.lastClone(), address(0));
    }
}
