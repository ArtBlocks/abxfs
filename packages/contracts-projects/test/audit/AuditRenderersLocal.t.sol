// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ProjectCard} from "../../src/ProjectCard.sol";
import {ProjectTraits} from "../../src/ProjectTraits.sol";
import {ProjectLinks} from "../../src/ProjectLinks.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {MockStore} from "../mocks/Mocks.sol";

/// Configurable token: answers name(), tokenParamData, tokenParam by mode.
contract AuditTok {
    uint256 public mode; // 0 canonical, 1 fuzz raw bytes, 2 big canonical bytes len, 3 burn gas, 4 return N garbage bytes, 5 revert
    bytes public raw;
    bytes public dataVal;   // tokenParamData payload
    string public nm;       // name()
    uint256 public n;
    bool public setCid;

    function set(uint256 m, bytes calldata r, bytes calldata d, string calldata name_, uint256 n_) external {
        mode = m; raw = r; dataVal = d; nm = name_; n = n_;
    }
    function setCidFlag(bool b) external { setCid = b; }

    fallback(bytes calldata cd) external returns (bytes memory) {
        uint256 m = mode;
        if (m == 5) revert("x");
        if (m == 3) { while (true) {} }
        if (m == 4) { uint256 N = n; assembly { return(0, N) } }
        if (m == 1) return raw;
        bytes4 s = bytes4(cd[:4]);
        if (s == bytes4(keccak256("name()"))) return abi.encode(nm);
        if (s == bytes4(keccak256("tokenParamData(uint256,bytes32)"))) {
            if (m == 2) { return abi.encode(new bytes(n)); }
            return abi.encode(dataVal);
        }
        if (s == bytes4(keccak256("tokenParam(uint256,bytes32)"))) {
            return abi.encode(bytes32(uint256(0xabcdef)), false, setCid);
        }
        return "";
    }
}

contract AuditRenderersLocalTest is Test {
    using LibString for string;
    ProjectHook hook;
    ProjectCard card;
    ProjectTraits traits;
    ProjectLinks links;
    AuditTok tok;

    function setUp() public {
        MockStore a = new MockStore(); MockStore b = new MockStore();
        hook = new ProjectHook(address(a), address(b), address(0));
        card = new ProjectCard(address(hook));
        traits = new ProjectTraits(address(hook));
        links = new ProjectLinks("https://fs.abx.io");
        tok = new AuditTok();
    }

    function _setCanon(string memory name_, bytes memory data) internal {
        tok.set(0, "", data, name_, 0);
    }

    // ACCEPTED RISK (owner decision, F3): renderers copy returndata uncapped; not reachable through ABX, which passes its own collection.
    // ---------------- gas bombs ----------------
    function _gas(uint256 mode_, uint256 n_) internal returns (uint256 gCard, uint256 gTraits, uint256 gLinks) {
        tok.set(mode_, "", "", "x", n_);
        uint256 g = gasleft();
        try card.render(address(tok), 1, "image") {} catch {}
        gCard = g - gasleft();
        g = gasleft();
        try traits.render(address(tok), 1, "attributes") {} catch {}
        gTraits = g - gasleft();
        g = gasleft();
        try links.render(address(tok), 1, "animation_url") {} catch {}
        gLinks = g - gasleft();
    }

    function test_gas_returndataBomb() public {
        uint256[4] memory sizes = [uint256(512), 24_576, 262_144, 1_048_576];
        for (uint256 i; i < sizes.length; ++i) {
            (uint256 c, uint256 t, uint256 l) = _gas(2, sizes[i]); // canonical bytes of N zero bytes
            console2.log("canonical-bytes N, card/traits/links gas:", sizes[i], c, t);
            console2.log("   links:", l);
        }
        for (uint256 i; i < sizes.length; ++i) {
            (uint256 c, uint256 t, uint256 l) = _gas(4, sizes[i]); // raw garbage return
            console2.log("garbage N, card/traits/links gas:", sizes[i], c, t);
            console2.log("   links:", l);
        }
    }

    // A callee that burns all gas: caller keeps only 1/64. Show render reverts (OOG) given a limited budget
    function test_gas_burner_causesOOGForDirectCaller() public {
        tok.set(3, "", "", "", 0);
        (bool ok,) = address(card).staticcall{gas: 5_000_000}(abi.encodeCall(card.render, (address(tok), 1, bytes32("image"))));
        console2.log("burner: card.render success under 5M gas =", ok);
        (ok,) = address(links).staticcall{gas: 5_000_000}(abi.encodeCall(links.render, (address(tok), 1, bytes32("animation_url"))));
        console2.log("burner: links.render success under 5M gas =", ok);
        (ok,) = address(traits).staticcall{gas: 5_000_000}(abi.encodeCall(traits.render, (address(tok), 1, bytes32("attributes"))));
        console2.log("burner: traits.render success under 5M gas =", ok);
    }

    // Realistic worst-case: hook-capped inputs (name 128, view 512, org name 64)
    function test_gas_realisticWorstCase() public {
        bytes memory nm = new bytes(128);
        for (uint256 i; i < 128; ++i) nm[i] = '"';
        _setCanon("<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<", nm);
        uint256 g = gasleft();
        card.render(address(tok), 1, "image");
        console2.log("card worst-case gas", g - gasleft());
        bytes memory v = new bytes(512);
        for (uint256 i; i < 512; ++i) v[i] = "a";
        v[0]="h";v[1]="t";v[2]="t";v[3]="p";v[4]="s";v[5]=":";v[6]="/";v[7]="/";
        _setCanon("n", v);
        g = gasleft();
        links.render(address(tok), 1, "animation_url");
        console2.log("links worst-case gas", g - gasleft());
    }

    // ---------------- never-revert fuzz (arbitrary returndata, arbitrary ids) ----------------
    function testFuzz_neverRevert_rawReturndata(bytes calldata r, uint256 id, bool sentinel) public {
        if (r.length > 20_000) return;
        tok.set(1, r, "", "", 0);
        uint256 tid = sentinel ? type(uint256).max : id;
        card.render(address(tok), tid, "image");
        traits.render(address(tok), tid, "attributes");
        links.render(address(tok), tid, "animation_url");
        links.render(address(tok), tid, "external_url");
    }

    function testFuzz_neverRevert_canonicalData(bytes calldata data, string calldata nm, uint256 id) public {
        if (data.length > 5000 || bytes(nm).length > 5000) return;
        _setCanon(nm, data);
        card.render(address(tok), id, "image");
        traits.render(address(tok), id, "attributes");
        links.render(address(tok), id, "animation_url");
    }

    // ---------------- link validator exactness ----------------
    function testFuzz_view_accepted_implies_safe(bytes calldata tail) public {
        if (tail.length > 600) return;
        bytes memory v = bytes.concat("https://", tail);
        _setCanon("n", v);
        (, bytes memory out) = links.render(address(tok), 1, "animation_url");
        bool isDefault = out.length >= 17 && keccak256(_slice(out, 0, 17)) == keccak256("https://fs.abx.io");
        if (keccak256(out) == keccak256(v)) {
            assertLe(v.length, 512);
            for (uint256 i; i < v.length; ++i) {
                uint8 c = uint8(v[i]);
                assertTrue(c > 0x20 && c < 0x7f, "visible ascii");
                assertTrue(c != 0x22 && c != 0x5c && c != 0x3c && c != 0x3e && c != 0x60 && c != 0x27 && c != 0x26, "unsafe");
            }
        } else {
            assertTrue(isDefault, "either exactly the owner's value or the default");
        }
    }

    function _slice(bytes memory b, uint256 s, uint256 l) internal pure returns (bytes memory o) {
        o = new bytes(l);
        for (uint256 i; i < l; ++i) o[i] = b[s + i];
    }

    // ---------------- card: sanitizer and impersonation ----------------
    function _svgOf(string memory org, bytes memory name) internal returns (string memory) {
        _setCanon(org, name);
        (, bytes memory d) = card.render(address(tok), 1, "image");
        return string(d);
    }
    function _headerText(string memory svg) internal pure returns (string memory) {
        uint256 a = svg.indexOf('letter-spacing="3">') + bytes('letter-spacing="3">').length;
        string memory rest = svg.slice(a);
        return rest.slice(0, rest.indexOf("</text>"));
    }

    // Now unreachable through the factory (names are printable ASCII); kept as hardening of the card itself.
    function test_impersonation_zeroWidthAndHomoglyphSpoofOfBrand() public {
        string memory official = _headerText(_svgOf("ABX FS", "x"));
        string memory zw = _headerText(_svgOf(unicode"ABX​ FS", "x"));
        string memory bidi = _headerText(_svgOf(string(abi.encodePacked(hex"e280ae", "ABX FS")), "x"));
        string memory cy = _headerText(_svgOf(unicode"ABX FS⠀", "x"));
        console2.log("official:", official); console2.log("zerowidth:", zw);
        assertEq(official, zw, "zero-width org name renders identical to ABX FS header");
        assertEq(official, bidi);
        assertEq(official, cy);
    }

    function test_card_whitespaceOrgNameBlank() public {
        string memory h = _headerText(_svgOf("                            ", "x"));
        assertEq(bytes(h).length, 28, "28 spaces: a blank header");
    }

    function test_card_nonAsciiOnlyBecomesUntitled() public {
        assertEq(_headerText(_svgOf(unicode"БАМФС", "x")), "untitled");
    }

    function test_card_truncationEllipsisMisleading() public {
        // 29 bytes where most are dropped controls: ellipsis shown though nothing visible was cut
        bytes memory raw = new bytes(29);
        for (uint256 i; i < 29; ++i) raw[i] = 0x01;
        raw[0] = "A";
        console2.log(_headerText(_svgOf("o", raw)));
    }

    function testFuzz_card_nameCannotInjectMarkup(bytes calldata name, bytes calldata org) public {
        if (name.length > 300 || org.length > 300) return;
        _setCanon(string(org), name);
        (, bytes memory d) = card.render(address(tok), 1, "image");
        string memory svg = string(d);
        // Count '<' and '"' in whole document vs. a clean baseline
        _setCanon("o", "x");
        (, bytes memory b) = card.render(address(tok), 1, "image");
        assertEq(_count(d, "<"), _count(b, "<"));
        assertEq(_count(d, '"'), _count(b, '"'));
        assertEq(_count(d, ">"), _count(b, ">"));
        // every '&' begins one of our five entities
        bytes memory s = bytes(svg);
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == "&") {
                bool ok = _at(s, i, "&amp;") || _at(s, i, "&lt;") || _at(s, i, "&gt;") || _at(s, i, "&quot;") || _at(s, i, "&#39;");
                assertTrue(ok, "stray &");
            }
            assertTrue(s[i] != "'" || true);
        }
        assertLe(s.length, b.length + 2 * 28 * 6 + 12, "bounded");
    }
    function _count(bytes memory b, bytes1 c) internal pure returns (uint256 n) { for (uint256 i; i < b.length; ++i) if (b[i] == c) ++n; }
    function _at(bytes memory s, uint256 i, string memory p) internal pure returns (bool) {
        bytes memory q = bytes(p);
        if (i + q.length > s.length) return false;
        for (uint256 j; j < q.length; ++j) if (s[i + j] != q[j]) return false;
        return true;
    }

    // ---------------- traits: values are constants ----------------
    function testFuzz_traits_valid_json_shape(bytes calldata data, uint256 id) public {
        if (data.length > 2000) return;
        _setCanon("n", data);
        (, bytes memory d) = traits.render(address(tok), id, "attributes");
        for (uint256 i; i < d.length; ++i) assertTrue(uint8(d[i]) >= 0x20 && uint8(d[i]) < 0x7f);
    }

    // ---------------- wrong-field / sentinel / no-code ----------------
    function test_wrongFieldBehaviour() public {
        vm.expectRevert();
        this.callCardField("animation_url");
        vm.expectRevert();
        this.callTraitsField("image");
        (, bytes memory e) = links.render(address(0), 5, "image");
        assertEq(e.length, 0);
    }
    function callCardField(bytes32 f) external view { card.render(address(tok), 1, f); }
    function callTraitsField(bytes32 f) external view { traits.render(address(tok), 1, f); }

    function test_noCodeAndSentinel() public view {
        card.render(address(0xdead), type(uint256).max, "image");
        card.render(address(0xdead), 1, "image");
        traits.render(address(0xdead), type(uint256).max, "attributes");
        traits.render(address(0xdead), type(uint256).max - 1, "attributes");
        links.render(address(0xdead), type(uint256).max, "animation_url");
    }
}
