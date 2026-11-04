// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgMeta} from "../src/OrgMeta.sol";
import {ProjectLinks} from "../src/ProjectLinks.sol";

import {RawStub, GasBurner, ReturnBomb} from "./mocks/Hostile.sol";

/// @dev `OrgMeta` promises that NOTHING in it reverts, for any `token`: its reads are gas- and returndata-capped and
///      hand-decoded. `OrgMeta.t.sol` drives the shapes with a generic scripted callee; these tests take each condition
///      of `_slice`, `_word`, `_orgName`, `_description`, `_projectName`, the logo and the banner on its own and assert
///      the exact string that comes out, plus the cost of a gas burner and of a returndata bomb.
contract OrgMetaBranchesTest is Test {
    string internal constant GATEWAY = "https://fs.abx.io";
    bytes4 internal constant NAME = bytes4(keccak256("name()"));
    bytes4 internal constant CONTRACT_FIELD = bytes4(keccak256("contractField(bytes32)"));
    bytes4 internal constant PARAM_DATA = bytes4(keccak256("tokenParamData(uint256,bytes32)"));
    bytes32 internal constant INLINE = "inline";
    uint256 internal constant SENTINEL = type(uint256).max;
    string internal constant STANDARD = " is an org on ABX FS. Each token in it is a project: a website or set of files.";

    OrgMeta internal meta;
    RawStub internal token;

    function setUp() public {
        meta = new OrgMeta(GATEWAY);
        token = new RawStub();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _json(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        assertTrue(LibString.startsWith(uri, prefix), "a JSON data URI");
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length)));
    }

    function _svg(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:image/svg+xml;base64,";
        assertTrue(LibString.startsWith(uri, prefix), "an SVG data URI");
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length)));
    }

    /// @dev The org name as it appears in the collection document.
    function _orgName(address t) internal view returns (string memory) {
        return vm.parseJsonString(_json(meta.contractURI(t)), ".name");
    }

    function _description(address t) internal view returns (string memory) {
        return vm.parseJsonString(_json(meta.contractURI(t)), ".description");
    }

    function _tokenName(address t, uint256 id) internal view returns (string memory) {
        (string memory ct, bytes memory data) = meta.render(t, id, "name");
        assertEq(ct, "text/plain");
        return string(data);
    }

    function _nameIs(bytes memory answer) internal returns (string memory) {
        token.ret(NAME, answer);
        return _orgName(address(token));
    }

    function _head(uint256 offset, uint256 declared, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(offset, declared, payload);
    }

    function _filled(uint256 n, bytes1 c) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = c;
        }
    }

    function test_constructorArgumentsAndTheLinksRenderer() public view {
        assertEq(meta.gatewayBase(), GATEWAY);
        assertEq(meta.links().gatewayBase(), GATEWAY);
    }

    // ─── The org's name(): _call, _slice and the filter ──────────────────────

    function test_orgName_aCanonicalNameIsUsedVerbatim() public {
        assertEq(_nameIs(abi.encode("Acme Studio")), "Acme Studio");
        assertEq(_nameIs(abi.encode("  padded  ")), "  padded  ", "spaces are kept, only an all-space name is refused");
        assertEq(_nameIs(abi.encode("A&B <C> \"D\" 'E' \\F")), "A&B <C> \"D\" 'E' \\F");
        assertEq(_nameIs(abi.encode("~")), "~");
        assertEq(_nameIs(abi.encode(" a")), " a");
    }

    function test_orgName_noCodeRevertingAndEmptyAreUntitled() public {
        assertEq(_orgName(address(0xDEAD)), "Untitled org");
        assertEq(_orgName(address(0)), "Untitled org");
        assertEq(_nameIs(""), "Untitled org", "an empty success");
        token.boom(NAME);
        assertEq(_orgName(address(token)), "Untitled org");
    }

    /// @dev Each condition of `_slice` that makes it "malformed": a head that is not there, an offset past the end, an
    ///      offset with no room for a length word, a length longer than what follows.
    function test_orgName_everyMalformedShapeIsUntitled() public {
        assertEq(_nameIs(new bytes(31)), "Untitled org", "one byte short of the head word");
        assertEq(_nameIs(abi.encode(uint256(2))), "Untitled org", "a bare word: offset 2 points into the word itself");
        assertEq(_nameIs(abi.encode(uint256(0x1000))), "Untitled org", "offset past the end");
        assertEq(_nameIs(abi.encode(type(uint256).max)), "Untitled org", "offset 2^256-1");
        assertEq(_nameIs(abi.encodePacked(uint256(32), new bytes(31))), "Untitled org", "offset 32 with 31 bytes where the length goes");
        assertEq(_nameIs(abi.encodePacked(uint256(33), new bytes(32))), "Untitled org", "offset 33: only 31 bytes left");
        assertEq(_nameIs(_head(0x20, 5, "Acme")), "Untitled org", "declared one past what follows");
        assertEq(_nameIs(_head(0x20, type(uint256).max, "Acme")), "Untitled org", "declared 2^256-1");
        assertEq(_nameIs(_head(0x20, 2 ** 255, "Acme")), "Untitled org");
        assertEq(_nameIs(_head(0x20, 0, "")), "Untitled org", "the empty string");
    }

    /// @dev A short, non-canonical answer whose first word is a small number. ABI says that word is an OFFSET, so the length
    ///      would be read from inside the word itself, which is garbage (the length comes out enormous): refused. A decoder
    ///      that took the word for "zero" instead, because the buffer is too short to hold two words, would read the length
    ///      from the start of the buffer, find that same small number, and hand back the bytes after it as the value.
    function test_aSmallFirstWordIsAnOffsetAndNeverReadAsZero() public {
        // 40 bytes: the word 5, then 8 bytes. A zero offset would give the 5 bytes at 32..36: "ABCDE".
        assertEq(_nameIs(abi.encodePacked(uint256(5), "ABCDEFGH")), "Untitled org");
        // 63 bytes, the longest answer too short for a length word at offset 32.
        assertEq(_nameIs(abi.encodePacked(uint256(5), "ABCDEFGHABCDEFGHABCDEFGHABCDEFG")), "Untitled org");
        // The same through the token-name read.
        token.ret(NAME, abi.encode("Org"));
        token.ret(PARAM_DATA, abi.encodePacked(uint256(5), "ABCDEFGH"));
        assertEq(_tokenName(address(token), 5), "Org #5");
    }

    /// @dev Exactly fits is fine; one more is not. And any in-range offset is honoured (the decoder is not pinned to 0x20).
    function test_orgName_theLengthMustFitAndTheOffsetIsHonoured() public {
        assertEq(_nameIs(_head(0x20, 4, "Acme")), "Acme", "declared == what follows");
        assertEq(_nameIs(_head(0x20, 3, "Acme")), "Acm", "declared less than what follows");
        // offset 0x40: a junk word sits between the head and the length.
        assertEq(_nameIs(abi.encodePacked(uint256(0x40), uint256(0xdead), uint256(4), "Acme")), "Acme");
        // Trailing bytes after the value are ignored.
        assertEq(_nameIs(abi.encodePacked(abi.encode("Acme"), uint256(7), uint256(8))), "Acme");
    }

    /// @dev A name longer than 64 bytes is cut at 64 (it only labels), not refused.
    function test_orgName_isTruncatedAtSixtyFourBytes() public {
        assertEq(_nameIs(abi.encode(string(_filled(64, "w")))), string(_filled(64, "w")));
        assertEq(_nameIs(abi.encode(string(_filled(65, "w")))), string(_filled(64, "w")));
        assertEq(_nameIs(abi.encode(string(_filled(5000, "w")))), string(_filled(64, "w")), "the copy is capped: no gas for the rest");
        // ...which is the first 64 BYTES: a multi-byte character cut in half is then dropped by the filter.
        bytes memory raw = abi.encodePacked(_filled(63, "a"), unicode"é", "tail"); // 'é' is bytes 63 and 64
        assertEq(_nameIs(abi.encode(string(raw))), string(_filled(63, "a")));
    }

    function test_orgName_nonPrintableBytesAreDroppedAndNothingVisibleIsUntitled() public {
        assertEq(_nameIs(abi.encode(string(abi.encodePacked("A", hex"00", "B")))), "AB");
        assertEq(_nameIs(abi.encode(string(abi.encodePacked("A", hex"1f", "B", hex"7f", "C")))), "ABC");
        assertEq(_nameIs(abi.encode(string(abi.encodePacked(hex"0a", "A", hex"09")))), "A");
        assertEq(_nameIs(abi.encode(unicode"café")), "caf", "the two bytes of e-acute are dropped");
        assertEq(_nameIs(abi.encode(unicode"日本語")), "Untitled org");
        assertEq(_nameIs(abi.encode(string(hex"0102"))), "Untitled org");
        assertEq(_nameIs(abi.encode("   ")), "Untitled org", "nothing visible");
        assertEq(_nameIs(abi.encode(string(abi.encodePacked(" ", hex"00", " ")))), "Untitled org", "spaces after the filter");
    }

    function test_orgName_everyByteValueIsKeptIffPrintable() public {
        for (uint256 c; c < 256; ++c) {
            string memory got = _nameIs(abi.encode(string(abi.encodePacked("a", bytes1(uint8(c)), "b"))));
            bool printable = c >= 0x20 && c <= 0x7e;
            string memory want = printable ? string(abi.encodePacked("a", bytes1(uint8(c)), "b")) : "ab";
            assertEq(got, want, string.concat("byte ", vm.toString(c)));
        }
    }

    /// @dev A FAILED call's data is not an answer. Each of the three reads is given a revert whose data is exactly what a
    ///      success would have said, and falls back as if it had said nothing.
    function test_theDataOfARevertIsNeverTakenForAnAnswer() public {
        token.boomWith(NAME, abi.encode("Evil org"));
        assertEq(_orgName(address(token)), "Untitled org");

        token.ret(NAME, abi.encode("Org"));
        token.boomWith(CONTRACT_FIELD, abi.encode(INLINE, bytes("Evil description")));
        assertEq(_description(address(token)), string.concat("Org", STANDARD));

        token.boomWith(PARAM_DATA, abi.encode(bytes("Evil project")));
        assertEq(_tokenName(address(token), 4), "Org #4");
    }

    // ─── Gas burners and returndata bombs ────────────────────────────────────

    /// @dev Reads cost at most their cap (1,000,000 gas each), and a callee that burns it all reads as "unset". Two
    ///      reads in `contractURI` (name and description), so about two caps, never "all the gas".
    function test_aGasBurningCalleeCostsAtMostItsCapPerRead() public {
        GasBurner burner = new GasBurner();
        uint256 g = gasleft();
        string memory uri = meta.contractURI(address(burner));
        uint256 used = g - gasleft();
        string memory json = _json(uri);
        assertEq(vm.parseJsonString(json, ".name"), "Untitled org");
        assertEq(vm.parseJsonString(json, ".description"), string.concat("Untitled org", STANDARD));
        assertGe(used, 2_000_000, "both reads burned their whole cap");
        assertLt(used, 2_600_000, "and no more than that plus the document");
    }

    function test_aGasBurningTokenNameCostsOneCap() public {
        GasBurner burner = new GasBurner();
        uint256 g = gasleft();
        string memory n = _tokenName(address(burner), 7);
        uint256 used = g - gasleft();
        assertEq(n, "Untitled org #7");
        assertGe(used, 2_000_000, "the project-name read and the org-name read each burned a cap");
        assertLt(used, 2_300_000);
    }

    /// @dev A bomb returns a lot of bytes; only the first ones up to the cap are copied, so what the reader pays for is
    ///      the call, not the size. (256 KiB is what a callee can afford to return within the 1M gas cap: a megabyte
    ///      costs the callee more than the cap in memory expansion and reads as a failed call, which is also unset.)
    function test_aReturndataBombCostsNothingExtra() public {
        ReturnBomb bomb = new ReturnBomb(256 * 1024);
        uint256 g = gasleft();
        string memory json = _json(meta.contractURI(address(bomb)));
        uint256 used = g - gasleft();
        assertEq(vm.parseJsonString(json, ".name"), "Untitled org");
        assertEq(vm.parseJsonString(json, ".description"), string.concat("Untitled org", STANDARD));
        assertLt(used, 1_000_000, "the copy is capped: the bomb's size is not paid for by the reader");
        assertEq(_tokenName(address(bomb), 3), "Untitled org #3");
        // A megabyte costs its callee more than the cap, so the call fails: the same fallback.
        ReturnBomb huge = new ReturnBomb(1 << 20);
        assertEq(_orgName(address(huge)), "Untitled org");
        assertEq(_tokenName(address(huge), 3), "Untitled org #3");
    }

    /// @dev A long declared length with plenty of bytes behind it: the value is cut at the cap, so an oversized name is
    ///      the first 64 bytes of it (it only labels), and anything in range is read exactly.
    function test_orgName_aHugeDeclaredLengthIsCutAtTheCap() public {
        token.ret(NAME, abi.encodePacked(uint256(0x20), uint256(4000), _filled(4000, "z")));
        assertEq(_orgName(address(token)), string(_filled(64, "z")));
        token.ret(NAME, abi.encodePacked(uint256(0x20), uint256(64), _filled(4000, "z")));
        assertEq(_orgName(address(token)), string(_filled(64, "z")));
        token.ret(NAME, abi.encodePacked(uint256(0x20), uint256(10), _filled(4000, "z")));
        assertEq(_orgName(address(token)), string(_filled(10, "z")));
    }

    // ─── The description ─────────────────────────────────────────────────────

    function _described(bytes memory answer) internal returns (string memory) {
        token.ret(NAME, abi.encode("Acme"));
        token.ret(CONTRACT_FIELD, answer);
        return _description(address(token));
    }

    function _standard() internal pure returns (string memory) {
        return string.concat("Acme", STANDARD);
    }

    function test_description_anInlineValueIsUsed() public {
        assertEq(_described(abi.encode(INLINE, bytes("About Acme."))), "About Acme.");
        assertEq(_described(abi.encode(INLINE, bytes("line one\nline two"))), "line one\nline two");
        assertEq(_described(abi.encode(INLINE, bytes("x"))), "x");
        assertEq(_described(abi.encode(INLINE, bytes(_filled(1000, "d")))), string(_filled(1000, "d")), "1000 bytes is the cap");
        assertEq(_described(abi.encode(INLINE, bytes("\n x \n"))), "\n x \n", "leading and trailing whitespace is fine");
    }

    function test_description_failureAndWrongRepresentationUseTheStandardText() public {
        assertEq(_described(""), _standard(), "empty / no code");
        token.boom(CONTRACT_FIELD);
        assertEq(_description(address(token)), _standard(), "reverting");
        assertEq(_described(new bytes(31)), _standard(), "short: no first word");
        assertEq(_described(abi.encode(bytes32("url"), bytes("About Acme."))), _standard(), "not inline");
        assertEq(_described(abi.encode(bytes32("renderer"), bytes("About Acme."))), _standard());
        assertEq(_described(abi.encode(bytes32("inline "), bytes("About Acme."))), _standard(), "inline plus a byte is not inline");
        assertEq(_described(abi.encode(bytes32(0), bytes("About Acme."))), _standard());
    }

    function test_description_everyMalformedValueUsesTheStandardText() public {
        // The first word is `inline`; the value is wrong in each way `_slice` or `_printable` can say no.
        assertEq(_described(abi.encodePacked(INLINE)), _standard(), "the head word of the value is missing");
        assertEq(_described(abi.encodePacked(INLINE, uint256(0x1000))), _standard(), "offset past the end");
        assertEq(_described(abi.encodePacked(INLINE, uint256(0x40), uint256(5), "ab")), _standard(), "declared past what follows");
        assertEq(_described(abi.encodePacked(INLINE, uint256(0x40), type(uint256).max, "ab")), _standard());
        assertEq(_described(abi.encode(INLINE, bytes(""))), _standard(), "empty");
        assertEq(_described(abi.encode(INLINE, bytes("   "))), _standard(), "spaces only");
        assertEq(_described(abi.encode(INLINE, bytes(" \n \n "))), _standard(), "whitespace only");
        assertEq(_described(abi.encode(INLINE, bytes("a\tb"))), _standard(), "tab");
        assertEq(_described(abi.encode(INLINE, bytes("a\rb"))), _standard(), "CR");
        assertEq(_described(abi.encode(INLINE, bytes(hex"617f62"))), _standard(), "DEL");
        assertEq(_described(abi.encode(INLINE, bytes(hex"6100"))), _standard(), "NUL");
        assertEq(_described(abi.encode(INLINE, bytes(unicode"café"))), _standard(), "UTF-8");
        assertEq(_described(abi.encode(INLINE, bytes(_filled(1001, "d")))), _standard(), "1001 bytes: refused, not cut to 1000");
        assertEq(_described(abi.encode(INLINE, bytes(_filled(5000, "d")))), _standard(), "5000 bytes");
    }

    /// @dev Printable ASCII and `\n` are accepted, nothing else, byte by byte.
    function test_description_everyByteValue() public {
        for (uint256 c; c < 256; ++c) {
            bytes memory d = abi.encodePacked("a", bytes1(uint8(c)), "b");
            bool ok = (c >= 0x20 && c <= 0x7e) || c == 0x0a;
            assertEq(_described(abi.encode(INLINE, d)), ok ? string(d) : _standard(), string.concat("byte ", vm.toString(c)));
        }
    }

    // ─── A token's name: abxfs.name ──────────────────────────────────────────

    function _projectNamed(bytes memory answer) internal returns (string memory) {
        token.ret(NAME, abi.encode("Org"));
        token.ret(PARAM_DATA, answer);
        return _tokenName(address(token), 5);
    }

    function test_tokenName_aUsableNameIsUsed() public {
        assertEq(_projectNamed(abi.encode(bytes("My Site"))), "My Site");
        assertEq(_projectNamed(abi.encode(bytes("x"))), "x");
        assertEq(_projectNamed(abi.encode(bytes("--"))), "--", "only a lone dash is the cleared marker");
        assertEq(_projectNamed(abi.encode(bytes(" - "))), " - ");
        assertEq(_projectNamed(abi.encode(bytes(_filled(128, "n")))), string(_filled(128, "n")), "128 is the hook's cap");
        assertEq(_projectNamed(abi.encode(bytes("A&B <C>"))), "A&B <C>", "ABX escapes it, not this contract");
    }

    function test_tokenName_everythingElseFallsBackToTheOrgNameAndId() public {
        assertEq(_projectNamed(""), "Org #5", "empty / no code");
        token.boom(PARAM_DATA);
        assertEq(_tokenName(address(token), 5), "Org #5", "reverting");
        assertEq(_projectNamed(new bytes(31)), "Org #5");
        assertEq(_projectNamed(abi.encode(bytes(""))), "Org #5", "an empty value");
        assertEq(_projectNamed(abi.encode(bytes("-"))), "Org #5", "the SDK's cleared marker");
        assertEq(_projectNamed(abi.encode(bytes("   "))), "Org #5", "spaces only");
        assertEq(_projectNamed(abi.encode(bytes("a\nb"))), "Org #5", "a newline is not allowed in a name");
        assertEq(_projectNamed(abi.encode(bytes("a\tb"))), "Org #5");
        assertEq(_projectNamed(abi.encode(bytes(hex"617f62"))), "Org #5");
        assertEq(_projectNamed(abi.encode(bytes(hex"6100"))), "Org #5");
        assertEq(_projectNamed(abi.encode(bytes(unicode"café"))), "Org #5", "refused whole, not mangled");
        assertEq(_projectNamed(abi.encode(bytes(_filled(129, "n")))), "Org #5", "129 bytes: refused, not cut");
        assertEq(_projectNamed(abi.encode(bytes(_filled(9000, "n")))), "Org #5");
        assertEq(_projectNamed(_head(0x20, 9, "short")), "Org #5", "declared past what follows");
        assertEq(_projectNamed(_head(0x20, type(uint256).max, "short")), "Org #5");
        assertEq(_projectNamed(abi.encodePacked(uint256(0x1000))), "Org #5", "offset past the end");
    }

    function test_tokenName_theFallbackNamesTheIdAndTheSentinelIsJustTheOrg() public {
        token.ret(NAME, abi.encode("Org"));
        assertEq(_tokenName(address(token), 0), "Org #0");
        assertEq(_tokenName(address(token), SENTINEL - 1), string.concat("Org #", LibString.toString(SENTINEL - 1)));
        assertEq(_tokenName(address(token), SENTINEL), "Org", "the collection surface");
        // The project name is not consulted at the collection surface, even if the token claims one.
        token.ret(PARAM_DATA, abi.encode(bytes("A Project")));
        assertEq(_tokenName(address(token), SENTINEL), "Org");
        assertEq(_tokenName(address(token), 1), "A Project");
        // No org name either: the fallback org name, with the id.
        assertEq(_tokenName(address(0xDEAD), 4), "Untitled org #4");
        assertEq(_tokenName(address(0xDEAD), SENTINEL), "Untitled org");
    }

    function test_anyOtherFieldIsEmptyNeverAnError() public {
        token.ret(NAME, abi.encode("Org"));
        bytes32[5] memory fields = [bytes32(0), bytes32("image"), bytes32("description"), bytes32("Name"), bytes32("name\x01")];
        for (uint256 i; i < fields.length; ++i) {
            (string memory ct, bytes memory data) = meta.render(address(token), 1, fields[i]);
            assertEq(ct, "text/plain");
            assertEq(data.length, 0);
            (ct, data) = meta.render(address(token), SENTINEL, fields[i]);
            assertEq(ct, "text/plain");
            assertEq(data.length, 0, "the field is checked before the surface");
        }
    }

    // ─── The artwork ─────────────────────────────────────────────────────────

    function _bannerFor(string memory name) internal returns (string memory) {
        token.ret(NAME, abi.encode(name));
        return _svg(vm.parseJsonString(_json(meta.contractURI(address(token))), ".banner_image"));
    }

    function _logoFor(string memory name) internal returns (string memory) {
        token.ret(NAME, abi.encode(name));
        return _svg(vm.parseJsonString(_json(meta.contractURI(address(token))), ".image"));
    }

    /// @dev The banner's text size is 1900 / length, capped at 64, and its baseline sits at 165 + size / 3.
    function test_banner_sizeIs1900OverTheLengthCappedAt64() public {
        uint256[6] memory lengths = [uint256(1), 2, 29, 30, 63, 64];
        uint256[6] memory sizes = [uint256(64), 64, 64, 63, 30, 29];
        for (uint256 i; i < lengths.length; ++i) {
            string memory svg = _bannerFor(string(_filled(lengths[i], "m")));
            uint256 y = 165 + sizes[i] / 3;
            assertTrue(
                LibString.contains(
                    svg,
                    string.concat('<text x="700" y="', LibString.toString(y), '" fill="#f2f5fa" font-size="', LibString.toString(sizes[i]), '"')
                ),
                string.concat("length ", LibString.toString(lengths[i]))
            );
            assertTrue(LibString.contains(svg, string.concat(">", string(_filled(lengths[i], "m")), "</text>")));
        }
    }

    /// @dev Lengths that divide 1900 give an exact quotient, which is where a different numerator would show: 38 -> 50
    ///      and 50 -> 38 (and 19 would be 100, capped).
    function test_banner_exactQuotients() public {
        uint256[3] memory lengths = [uint256(38), 50, 19];
        uint256[3] memory sizes = [uint256(50), 38, 64];
        for (uint256 i; i < lengths.length; ++i) {
            string memory svg = _bannerFor(string(_filled(lengths[i], "m")));
            assertTrue(
                LibString.contains(
                    svg,
                    string.concat(
                        '<text x="700" y="',
                        LibString.toString(165 + sizes[i] / 3),
                        '" fill="#f2f5fa" font-size="',
                        LibString.toString(sizes[i]),
                        '"'
                    )
                ),
                string.concat("length ", LibString.toString(lengths[i]))
            );
        }
    }

    function test_banner_theNameIsXmlEscaped() public {
        string memory svg = _bannerFor("a<b>&\"'");
        assertTrue(LibString.contains(svg, ">a&lt;b&gt;&amp;&quot;&#39;</text>"));
        assertFalse(LibString.contains(svg, "a<b>"));
    }

    function test_logo_monogramOfTheFirstVisibleCharacterOfEachOfTheFirstTwoWords() public {
        string[8] memory names = ["Acme", "acme sites co", "  two   spaces", "x", "9 lives", "~tilde", "<a> &b", "Untitled org"];
        string[8] memory mono = ["A", "AS", "TS", "X", "9L", "~", "&lt;&amp;", "UO"];
        for (uint256 i; i < names.length; ++i) {
            bytes memory name = bytes(names[i]);
            string memory svg = _logoFor(names[i]);
            // A one-word name gets a single larger letter.
            string memory size = bytes(mono[i]).length == 1 ? "160" : "132";
            assertTrue(LibString.contains(svg, string.concat('font-size="', size, '"')), string(name));
            assertTrue(LibString.contains(svg, string.concat(">", mono[i], "</text>")), string(name));
        }
    }

    /// @dev A name with no visible first character reads as the fallback org name before it reaches the logo.
    function test_logo_anAllSpaceNameIsTheFallbackOrgName() public {
        assertTrue(LibString.contains(_logoFor("    "), ">UO</text>"));
    }

    // ─── The collection document ─────────────────────────────────────────────

    function test_externalLinkIsTheGatewayBaseEscapedForJson() public {
        OrgMeta odd = new OrgMeta('https://a.example/"x\\y');
        string memory json = _json(odd.contractURI(address(token)));
        assertEq(vm.parseJsonString(json, ".external_link"), 'https://a.example/"x\\y');
        assertEq(odd.links().gatewayBase(), 'https://a.example/"x\\y');
    }

    function test_theDocumentHasExactlyTheFiveKeysInOrder() public {
        token.ret(NAME, abi.encode("Acme"));
        string memory json = _json(meta.contractURI(address(token)));
        assertTrue(LibString.startsWith(json, '{"name":"Acme","description":"'));
        assertTrue(LibString.contains(json, '","image":"data:image/svg+xml;base64,'));
        assertTrue(LibString.contains(json, '","banner_image":"data:image/svg+xml;base64,'));
        assertTrue(LibString.endsWith(json, string.concat('","external_link":"', GATEWAY, '"}')));
    }
}
