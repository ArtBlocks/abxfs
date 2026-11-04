// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {IOrgFactory} from "../../src/interfaces/IOrgFactory.sol";
import {MockStore} from "../mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection} from "../mocks/AbxMocks.sol";
import {Audit2Base, IA2Coll} from "./Audit2Base.sol";

/// @dev Re-audit of the org-name policy (round-1 fix F2), differential against an independent reference,
///      on the mock (fast, adversarial inputs) and on the real ABX fork (what ABX does with accepted names).
contract Audit2NamesMock is Test {
    MockAbxFactory abx;
    OrgFactory factory;
    address alice = makeAddr("alice");

    function setUp() public {
        abx = new MockAbxFactory();
        factory = OrgComponents.create(
            address(abx), address(0xBEEF01), address(0xBEEF02), address(new MockStore()), address(new MockStore()), address(new OrgMeta("https://fs.abx.io"))
        );
    }

    /// @dev The policy as written in the spec, not as coded: 1..64 bytes, each in 0x20..0x7e, one not 0x20.
    function _ref(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > 64) return false;
        bool visible;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7e) return false;
            if (c != 0x20) visible = true;
        }
        return visible;
    }

    function _try(bytes memory name) internal returns (bool ok, bytes memory ret) {
        vm.prank(alice);
        (ok, ret) = address(factory).call(abi.encodeCall(factory.createOrg, (string(name), "", bytes32(0))));
    }

    function _check(bytes memory name) internal {
        (bool ok, bytes memory ret) = _try(name);
        assertEq(ok, _ref(name), "policy differs from reference");
        if (!ok) {
            assertEq(bytes4(ret), IOrgFactory.InvalidName.selector, "refused with InvalidName");
        } else {
            address org = abi.decode(ret, (address));
            assertEq(MockOrgCollection(org).name(), string(name), "ABX saw exactly the validated bytes");
        }
    }

    /// CONFIRMED PROPERTY: every byte value, at first / middle / last position, alone and padded.
    /// (Split across tests: each createOrg on the mock costs ~1.5M gas and a test has a 1e9 budget.)
    function test_everyByteValue_short() public {
        for (uint256 v; v < 256; ++v) {
            bytes memory one = new bytes(1);
            one[0] = bytes1(uint8(v));
            _check(one);
            _check(abi.encodePacked("x", bytes1(uint8(v))));
        }
    }

    function test_everyByteValue_leadingAndMiddle() public {
        for (uint256 v; v < 256; ++v) {
            _check(abi.encodePacked(bytes1(uint8(v)), "x"));
            _check(abi.encodePacked("ab", bytes1(uint8(v)), "cd"));
        }
    }

    function test_everyByteValue_atTheSixtyFourByteBoundary() public {
        bytes memory b = new bytes(64);
        for (uint256 i; i < 64; ++i) b[i] = "a";
        for (uint256 v; v < 256; ++v) {
            b[63] = bytes1(uint8(v));
            _check(b);
        }
        b[63] = "a";
        for (uint256 v; v < 256; v += 1) {
            b[0] = bytes1(uint8(v));
            _check(b);
        }
    }

    /// CONFIRMED PROPERTY: length boundaries, for visible and for all-space names.
    function test_lengthBoundaries() public {
        for (uint256 n; n <= 70; n += 1) {
            bytes memory a = new bytes(n);
            bytes memory s = new bytes(n);
            bytes memory sx = new bytes(n);
            for (uint256 i; i < n; ++i) {
                a[i] = "a";
                s[i] = " ";
                sx[i] = " ";
            }
            if (n > 0) sx[n - 1] = "x";
            _check(a);
            _check(s); // all spaces: always refused
            _check(sx); // spaces then one visible byte
            if (n > 1) {
                bytes memory xs = new bytes(n);
                for (uint256 i; i < n; ++i) xs[i] = " ";
                xs[0] = "x";
                _check(xs);
            }
        }
    }

    /// CONFIRMED PROPERTY: fully random bytes.
    function testFuzz_randomBytes(bytes calldata name) public {
        _check(name);
    }

    /// CONFIRMED PROPERTY: mostly-printable strings with at most one injected bad byte, so the fuzzer
    /// actually reaches the accepting branch and the near-miss branches.
    function testFuzz_nearMiss(uint256 seed, uint8 len, uint8 badPos, uint8 badVal, uint8 mode) public {
        uint256 n = uint256(len) % 70;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            b[i] = bytes1(uint8(0x20 + (seed % 95)));
            if (mode % 3 == 0 && i % 2 == 0) b[i] = " "; // lots of spaces
        }
        if (mode % 5 == 0) for (uint256 i; i < n; ++i) b[i] = " ";
        if (n > 0 && mode % 2 == 1) b[uint256(badPos) % n] = bytes1(badVal);
        _check(b);
    }

    /// CONFIRMED PROPERTY: the validated bytes and the bytes ABX receives are the same bytes, even for a
    /// hand-built (non-canonical but decodable) calldata layout: odd offset, garbage between head and
    /// tail, dirty padding after the string.
    function test_rawCalldataLayoutsSeeTheSameBytes() public {
        bytes4 sel = factory.createOrg.selector;
        // Head: name offset, description offset, salt. The description is the empty string at 0x60 in every
        // layout below, so each one exercises the name alone.
        // layout A: name offset 0xa0, 32 bytes of garbage in the gap, length 3, "abc" + dirty padding
        bytes memory a = abi.encodePacked(
            sel, uint256(0xa0), uint256(0x60), bytes32(0), uint256(0), keccak256("gap"), uint256(3),
            bytes32(bytes("abc")) | bytes32(uint256(0xdead))
        );
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(factory).call(a);
        assertTrue(ok);
        assertEq(MockOrgCollection(abi.decode(ret, (address))).name(), "abc");

        // layout B: string whose data region contains a NUL AFTER the declared length (must be ignored)
        bytes memory bb = abi.encodePacked(sel, uint256(0x80), uint256(0x60), bytes32(0), uint256(0), uint256(2), bytes32(hex"6162000000000000000000000000000000000000000000000000000000000000"));
        vm.prank(alice);
        (ok, ret) = address(factory).call(bb);
        assertTrue(ok);
        assertEq(MockOrgCollection(abi.decode(ret, (address))).name(), "ab");

        // layout C: declared length longer than calldata: must revert (decoder), never read past the end
        bytes memory c = abi.encodePacked(sel, uint256(0x80), uint256(0x60), bytes32(0), uint256(0), uint256(64), bytes32("short"));
        vm.prank(alice);
        (ok,) = address(factory).call(c);
        assertFalse(ok);

        // layout D: huge declared length (overflow attempt)
        bytes memory d = abi.encodePacked(sel, uint256(0x80), uint256(0x60), bytes32(0), uint256(0), type(uint256).max, bytes32("x"));
        vm.prank(alice);
        (ok,) = address(factory).call(d);
        assertFalse(ok);

        // layout E: embedded zero inside the declared length is refused
        bytes memory e = abi.encodePacked(sel, uint256(0x80), uint256(0x60), bytes32(0), uint256(0), uint256(3), bytes32(hex"610062"));
        vm.prank(alice);
        (ok,) = address(factory).call(e);
        assertFalse(ok);
    }
}

/// @dev Real ABX: what happens to every accepted name.
contract Audit2NamesFork is Audit2Base {
    using LibString for string;

    string constant PREFIX = "data:application/json;base64,";

    function setUp() public {
        _fork();
    }

    function _json(string memory uri) internal pure returns (string memory) {
        require(uri.startsWith(PREFIX), "not a data uri");
        return string(Base64.decode(uri.slice(bytes(PREFIX).length)));
    }

    function _svgOf(string memory tj) internal pure returns (string memory) {
        string memory marker = "data:image/svg+xml;base64,";
        uint256 at = tj.indexOf(marker);
        require(at != LibString.NOT_FOUND, "no card");
        string memory rest = tj.slice(at + bytes(marker).length);
        return string(Base64.decode(rest.slice(0, rest.indexOf('"'))));
    }

    /// @dev Header text of the card (the org name line), entity-decoded; reverts if it holds markup.
    function _header(string memory svg) internal pure returns (bytes memory out) {
        string memory open = 'letter-spacing="3">';
        uint256 s = svg.indexOf(open) + bytes(open).length;
        string memory rest = svg.slice(s);
        bytes memory h = bytes(rest.slice(0, rest.indexOf("</text>")));
        out = new bytes(h.length);
        uint256 n;
        for (uint256 i; i < h.length;) {
            bytes1 c = h[i];
            require(c != "<" && c != ">" && c != '"' && c != "'", "raw markup char in header");
            if (c == "&") {
                if (_has(h, i, "&amp;")) { out[n++] = "&"; i += 5; }
                else if (_has(h, i, "&lt;")) { out[n++] = "<"; i += 4; }
                else if (_has(h, i, "&gt;")) { out[n++] = ">"; i += 4; }
                else if (_has(h, i, "&quot;")) { out[n++] = '"'; i += 6; }
                else if (_has(h, i, "&#39;")) { out[n++] = "'"; i += 5; }
                else revert("bare ampersand in header");
            } else {
                out[n++] = c;
                ++i;
            }
        }
        assembly { mstore(out, n) }
    }

    function _has(bytes memory h, uint256 at, string memory pat) internal pure returns (bool) {
        bytes memory p = bytes(pat);
        if (at + p.length > h.length) return false;
        for (uint256 i; i < p.length; ++i) if (h[at + i] != p[i]) return false;
        return true;
    }

    function _assertName(string memory nm) internal {
        vm.prank(alice);
        address org = f.createOrg(nm, "", bytes32(0));
        IA2Coll c = IA2Coll(org);
        assertEq(c.name(), nm, "ABX stores the exact name");
        string memory tj = _json(c.tokenURI(0));
        string memory cj = _json(c.contractURI());
        vm.parseJson(tj);
        vm.parseJson(cj);
        assertEq(vm.parseJsonString(cj, ".name"), nm, "contractURI.name round-trips");
        assertEq(vm.parseJsonString(tj, ".name"), string.concat(nm, " #0"), "tokenURI.name round-trips");
        // every byte of both documents is printable ASCII (so valid UTF-8, valid for strict parsers)
        bytes memory t = bytes(tj);
        for (uint256 i; i < t.length; ++i) require(t[i] >= 0x20 && t[i] <= 0x7e, "non-ASCII in tokenURI json");
        t = bytes(cj);
        for (uint256 i; i < t.length; ++i) require(t[i] >= 0x20 && t[i] <= 0x7e, "non-ASCII in contractURI json");
        // the only keys in the token JSON are ours: an injected `animation_url`/`image` would add a duplicate
        assertEq(_count(tj, '"animation_url":'), 1, "one animation_url");
        assertEq(_count(tj, '"external_url":'), 1, "one external_url");
        assertEq(_count(tj, '"image":'), 1, "one image");
        // the card header is the name, entity-decoded, truncated at 28 characters
        bytes memory h = _header(_svgOf(tj));
        bytes memory nb = bytes(nm);
        if (nb.length > 28) {
            // truncated body + the ellipsis (3 UTF-8 bytes)
            assertEq(h.length, 28 + 3, "truncated header length");
            for (uint256 i; i < 28; ++i) assertEq(h[i], nb[i]);
        } else {
            assertEq(string(h), nm, "header equals the name");
        }
        // sanity: the card has no <script / <foreignObject / on* attributes anywhere
        string memory svg = _svgOf(tj);
        assertFalse(svg.contains("<script"));
        assertFalse(svg.contains("<foreignObject"));
        assertFalse(svg.contains("<a "));
    }

    function _count(string memory hay, string memory needle) internal pure returns (uint256 n) {
        bytes memory h = bytes(hay);
        bytes memory p = bytes(needle);
        if (p.length == 0 || h.length < p.length) return 0;
        for (uint256 i; i + p.length <= h.length; ++i) {
            bool m = true;
            for (uint256 j; j < p.length; ++j) if (h[i + j] != p[j]) { m = false; break; }
            if (m) ++n;
        }
    }

    /// CONFIRMED: fuzzed accepted names through the real ABX renderer and the real card.
    /// forge-config: default.fuzz.runs = 60
    function testFuzz_acceptedNamesAreSaneThroughRealAbx(uint256 seed, uint8 len, uint8 mode) public {
        uint256 n = 1 + (uint256(len) % 64);
        bytes memory b = new bytes(n);
        // weight the nasty characters: " \ < > & ' / % { } ` \
        bytes memory nasty = bytes("\"\\<>&'/%{}`$@#;:,=? ");
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            if (mode % 2 == 0 && seed % 3 == 0) b[i] = nasty[(seed >> 8) % nasty.length];
            else b[i] = bytes1(uint8(0x20 + (seed % 95)));
        }
        if (n > 0) b[n - 1] = "z"; // keep one visible byte
        _assertName(string(b));
    }

    /// CONFIRMED: the two length boundaries through real ABX (1 and 64 bytes) and a refused 65.
    function test_boundaryLengthsThroughRealAbx() public {
        _assertName("a");
        bytes memory b = new bytes(64);
        for (uint256 i; i < 64; ++i) b[i] = "\"";
        _assertName(string(b));
        for (uint256 i; i < 64; ++i) b[i] = "&";
        _assertName(string(b));
        bytes memory c = new bytes(65);
        for (uint256 i; i < 65; ++i) c[i] = "a";
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        f.createOrg(string(c), "", bytes32(0));
    }

    /// CONFIRMED: ABX cannot be handed a name the factory refused, from any entry path: `predictOrg` and
    /// deterministic creation use the same check.
    function test_deterministicPathAlsoValidates() public {
        bytes32 salt = bytes32(abi.encodePacked(alice, uint96(7)));
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        f.createOrg(unicode"caf\u00e9", "", salt);
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.InvalidName.selector);
        f.createOrg("   ", "", salt);
        assertEq(f.orgCount(), 0);
    }

    /// CONFIRMED (round-1 `predictOrg(0)` fix): a zero salt has no deterministic address; every other salt's
    /// prediction matches the real deployment, for zero-prefix and prefix-bound salts alike, and salts
    /// differing only in their prefix are different orgs.
    function test_predictOrgZeroRevertsAndOthersMatch() public {
        vm.expectRevert(IOrgFactory.NoDeterministicAddress.selector);
        f.predictOrg(bytes32(0));

        bytes32[4] memory salts = [
            bytes32(uint256(1)),
            bytes32(uint256(type(uint96).max)),
            bytes32(abi.encodePacked(alice, uint96(0))),
            bytes32(abi.encodePacked(alice, uint96(1)))
        ];
        for (uint256 i; i < salts.length; ++i) {
            address predicted = f.predictOrg(salts[i]);
            vm.prank(alice);
            address made = f.createOrg("P", "", salts[i]);
            assertEq(made, predicted, "prediction == deployment");
        }
        // the same low 96 bits with a different (bob) prefix is a different address, and bob's salt is bob's only
        bytes32 bobSalt = bytes32(abi.encodePacked(bob, uint96(1)));
        assertTrue(f.predictOrg(bobSalt) != f.predictOrg(salts[3]));
        vm.prank(alice);
        vm.expectRevert(IOrgFactory.SaltSenderMismatch.selector);
        f.createOrg("steal", "", bobSalt);
    }
}
