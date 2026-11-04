// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {ProjectLinks} from "../src/ProjectLinks.sol";
import {IAbxParams} from "../src/interfaces/IAbxParams.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

import {RawStub, GasBurner} from "./mocks/Hostile.sol";

/// @dev The three field renderers a project token is built from (`ProjectCard`, `ProjectTraits`, `ProjectLinks`) are
///      `staticcall`ed by ABX with no try/catch, so a revert inside one bricks the token's whole `tokenURI`. Each
///      reads its "token" (and the card and the traits also the hook) with a raw `staticcall` and hand-decodes the
///      answer. These tests put every read behind a scripted callee ({RawStub}) and drive each hostile shape the
///      decoders promise to survive: no code, a revert, short returndata, long returndata, non-canonical offsets and
///      lengths, non-canonical bools. Every case asserts the exact output the shape must produce, not only that
///      nothing reverted.
abstract contract RendererHostileBase is Test {
    bytes4 internal constant PARAM = IAbxParams.tokenParam.selector;
    bytes4 internal constant DATA = IAbxParams.tokenParamData.selector;
    bytes4 internal constant ORG_NAME = bytes4(keccak256("name()"));
    bytes4 internal constant VERSIONS = IProjectHook.versionCount.selector;
    bytes4 internal constant KIND = IProjectHook.kindOf.selector;

    uint256 internal constant SENTINEL = type(uint256).max;
    /// @dev The first three bytes, then the last two: what `ProjectCard._shortCid` shows.
    bytes32 internal constant CID = 0xabcdef0000000000000000000000000000000000000000000000000000001234;

    RawStub internal token;
    RawStub internal hookStub;

    function setUp() public virtual {
        token = new RawStub();
        hookStub = new RawStub();
    }

    /// @dev `(bytes32 value, bool valueIsHash, bool isSet)`, three words, with each flag word free to be non-canonical.
    function _param(bytes32 value, uint256 valueIsHash, uint256 isSet) internal pure returns (bytes memory) {
        return abi.encode(value, valueIsHash, isSet);
    }

    /// @dev A `bytes` return value laid out by hand, so a test can lie about the offset or the length. Unpadded, so
    ///      `declared == payload.length` is exactly "fits the buffer".
    function _bytesRet(uint256 offset, uint256 declared, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(offset, declared, payload);
    }

    /// @dev The canonical encoding of `payload`.
    function _good(bytes memory payload) internal pure returns (bytes memory) {
        return abi.encode(payload);
    }

    function _filled(uint256 n, bytes1 c) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = c;
        }
    }

    /// @dev The text between `open` and the next `</text>`.
    function _between(string memory s, string memory open) internal pure returns (string memory) {
        uint256 at = LibString.indexOf(s, open, 0);
        assertTrue(at != LibString.NOT_FOUND, "marker is in the document");
        uint256 from = at + bytes(open).length;
        uint256 to = LibString.indexOf(s, "</text>", from);
        assertTrue(to != LibString.NOT_FOUND, "text element is closed");
        return LibString.slice(s, from, to);
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// ProjectCard
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract ProjectCardHostileTest is RendererHostileBase {
    ProjectCard internal card;

    string internal constant ORG_AT = 'font-size="13" letter-spacing="3">';
    string internal constant NAME_AT = 'font-size="19">';
    string internal constant LINE_AT = 'font-size="12">';

    function setUp() public override {
        super.setUp();
        card = new ProjectCard(address(hookStub));
    }

    function _svg(address tok, uint256 id) internal view returns (string memory) {
        (string memory ct, bytes memory data) = card.render(tok, id, "image");
        assertEq(ct, "image/svg+xml");
        return string(data);
    }

    function _name(string memory svg) internal pure returns (string memory) {
        return _between(svg, NAME_AT);
    }

    function _org(string memory svg) internal pure returns (string memory) {
        return _between(svg, ORG_AT);
    }

    function _line(string memory svg) internal pure returns (string memory) {
        return _between(svg, LINE_AT);
    }

    /// @dev A published card's version line for `n` versions of `CID`.
    function _published(uint256 n) internal pure returns (string memory) {
        return string.concat("v", LibString.toString(n), unicode"  0xabcdef…1234");
    }

    // ─── The field ───────────────────────────────────────────────────────────

    function test_onlyTheImageFieldIsComputed_andTheRevertNamesTheField() public {
        bytes32[5] memory wrong = [bytes32(0), bytes32("attributes"), bytes32("animation_url"), bytes32("IMAGE"), bytes32("image ")];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ProjectCard.UnsupportedField.selector, wrong[i]));
            card.render(address(token), 1, wrong[i]);
            // Even for the collection surface: the field is checked first.
            vm.expectRevert(abi.encodeWithSelector(ProjectCard.UnsupportedField.selector, wrong[i]));
            card.render(address(token), SENTINEL, wrong[i]);
        }
    }

    function test_hookIsTheConstructorArgument() public view {
        assertEq(address(card.hook()), address(hookStub));
    }

    // ─── The collection surface ──────────────────────────────────────────────

    /// @dev `tokenId == type(uint256).max` has no token behind it: the org's name over a generic, unpublished card,
    ///      whatever the token claims about that id.
    function test_collectionSurface_isTheOrgNameOverAnUnpublishedCard() public {
        token.ret(ORG_NAME, _good("Studio & Co"));
        // Even a token that claims the sentinel is published, named and versioned is not believed.
        token.ret(PARAM, _param(CID, 0, 1));
        token.ret(DATA, _good("A Project"));
        hookStub.ret(VERSIONS, abi.encode(uint256(9)));

        string memory svg = _svg(address(token), SENTINEL);
        assertEq(_org(svg), "Studio &amp; Co");
        assertEq(_name(svg), "ABX FS");
        assertEq(_line(svg), "not yet published");
        assertTrue(LibString.contains(svg, 'stop-color="hsl(210,12%,52%)"'));
        assertTrue(LibString.contains(svg, 'stop-color="hsl(210,12%,34%)"'));
        assertTrue(LibString.contains(svg, '<g opacity="0.28"><rect x="168" y="150" width="64" height="64" rx="6"'));
    }

    function test_collectionSurface_ofATokenThatAnswersNothing() public view {
        string memory svg = _svg(address(0xdead), SENTINEL);
        assertEq(_org(svg), "ABX FS");
        assertEq(_name(svg), "ABX FS");
        assertEq(_line(svg), "not yet published");
    }

    // ─── abxfs.cid: (bytes32 value, bool valueIsHash, bool isSet) ─────────────

    function _lineWith(bytes memory paramAnswer) internal returns (string memory) {
        token.ret(PARAM, paramAnswer);
        return _line(_svg(address(token), 1));
    }

    function test_cid_aWellFormedAnswerIsPublished() public {
        assertEq(_lineWith(_param(CID, 0, 1)), _published(0));
    }

    /// @dev "Any nonzero flag word is read as true" (the contract note): ABX's `bool` decoder would revert on these.
    function test_cid_nonCanonicalIsSetWordsReadAsTrue() public {
        assertEq(_lineWith(_param(CID, 0, 2)), _published(0));
        assertEq(_lineWith(_param(CID, 0, type(uint256).max)), _published(0));
    }

    function test_cid_aNonzeroValueIsHashWordMeansAKeccakCommitmentNotACid() public {
        assertEq(_lineWith(_param(CID, 1, 1)), "not yet published");
        assertEq(_lineWith(_param(CID, 2, 1)), "not yet published");
        assertEq(_lineWith(_param(CID, type(uint256).max, 1)), "not yet published");
    }

    function test_cid_notSetIsUnpublishedWhateverTheValue() public {
        assertEq(_lineWith(_param(CID, 0, 0)), "not yet published");
        assertEq(_lineWith(_param(CID, 1, 0)), "not yet published");
    }

    function test_cid_aSetZeroValueIsUnpublished() public {
        assertEq(_lineWith(_param(bytes32(0), 0, 1)), "not yet published");
    }

    function test_cid_shortReturndataIsUnset() public {
        bytes memory full = _param(CID, 0, 1);
        // 95 bytes: one short of three words.
        bytes memory short95 = new bytes(95);
        for (uint256 i; i < 95; ++i) short95[i] = full[i];
        assertEq(_lineWith(short95), "not yet published");
        assertEq(_lineWith(""), "not yet published"); // no code answers exactly like this
        assertEq(_lineWith(abi.encode(CID)), "not yet published");
        assertEq(_lineWith(abi.encode(CID, uint256(0))), "not yet published");
    }

    function test_cid_longReturndataReadsTheFirstThreeWords() public {
        assertEq(_lineWith(abi.encodePacked(_param(CID, 0, 1), hex"00")), _published(0), "96 bytes + 1");
        assertEq(_lineWith(abi.encodePacked(_param(CID, 0, 1), uint256(7), uint256(8))), _published(0));
        assertEq(_lineWith(abi.encodePacked(_param(CID, 0, 0), uint256(1))), "not yet published", "later words are ignored");
    }

    function test_cid_aRevertingTokenIsUnset() public {
        token.boom(PARAM);
        assertEq(_line(_svg(address(token), 1)), "not yet published");
    }

    /// @dev The data of a FAILED call is not an answer: a revert whose data happens to be a well formed
    ///      `(value, false, true)` is still "unset". (A reader that tested only the data's length would read it as a CID.)
    function test_cid_theDataOfARevertIsNotAnAnswer() public {
        token.boomWith(PARAM, _param(CID, 0, 1));
        assertEq(_line(_svg(address(token), 1)), "not yet published");
    }

    /// @dev 95 bytes: one short of three words, the missing byte being the last of the third. The third word is nonzero
    ///      in its first 31 bytes, so a reader that took 95 bytes for enough would see a set flag.
    function test_cid_95BytesWhoseThirdWordIsNonzeroAreStillShort() public {
        bytes memory b95 = abi.encodePacked(CID, uint256(0), _filled(31, 0xff));
        assertEq(b95.length, 95);
        assertEq(_lineWith(b95), "not yet published");
    }

    /// @dev Flags are read as whole words, whichever byte of the word is set: a nonzero word is true, even one whose
    ///      only set byte is the first (a read shifted by a byte would see zero).
    function test_cid_aFlagWordIsReadWholeNotByItsLastByte() public {
        assertEq(_lineWith(_param(CID, 0, uint256(1) << 248)), _published(0), "isSet with only its top byte set");
        assertEq(_lineWith(_param(CID, uint256(1) << 248, 1)), "not yet published", "valueIsHash with only its top byte set");
        assertEq(_lineWith(_param(CID, 0, uint256(1) << 128)), _published(0));
    }

    // ─── The version count: one `uint256` from the hook ──────────────────────

    function _versions(bytes memory answer) internal returns (string memory) {
        token.ret(PARAM, _param(CID, 0, 1));
        hookStub.ret(VERSIONS, answer);
        return _line(_svg(address(token), 1));
    }

    function test_versions_aWordIsTheCount() public {
        assertEq(_versions(abi.encode(uint256(5))), _published(5));
        assertEq(_versions(abi.encode(uint256(0))), _published(0));
        assertEq(_versions(abi.encode(type(uint256).max)), _published(type(uint256).max));
    }

    function test_versions_longReturndataReadsTheFirstWord() public {
        assertEq(_versions(abi.encode(uint256(5), uint256(99))), _published(5));
        assertEq(_versions(abi.encodePacked(uint256(5), hex"01")), _published(5));
    }

    function test_versions_shortOrRevertingOrNoCodeIsZero() public {
        assertEq(_versions(""), _published(0), "no code / empty");
        assertEq(_versions(hex"05"), _published(0), "one byte");
        assertEq(_versions(new bytes(31)), _published(0), "31 bytes");
        assertEq(_versions(_filled(31, 0x01)), _published(0), "31 nonzero bytes: one short of a word is not a count");
        hookStub.boomWith(VERSIONS, abi.encode(uint256(9)));
        assertEq(_line(_svg(address(token), 1)), _published(0), "the data of a revert is not a count");
        hookStub.boom(VERSIONS);
        assertEq(_line(_svg(address(token), 1)), _published(0), "a reverting hook");

        // A hook address with no code at all.
        ProjectCard noHook = new ProjectCard(address(0xdead));
        (, bytes memory d) = noHook.render(address(token), 1, "image");
        assertEq(_between(string(d), LINE_AT), _published(0));
        ProjectCard zeroHook = new ProjectCard(address(0));
        (, d) = zeroHook.render(address(token), 1, "image");
        assertEq(_between(string(d), LINE_AT), _published(0));
    }

    // ─── abxfs.name: a `bytes` from the token ────────────────────────────────

    function _nameFor(bytes memory answer) internal returns (string memory) {
        token.ret(DATA, answer);
        return _name(_svg(address(token), 1));
    }

    function test_name_aCanonicalNameIsShown() public {
        assertEq(_nameFor(_good("hello")), "hello");
        assertEq(_nameFor(_good("a b-c_d.e")), "a b-c_d.e");
    }

    function test_name_aRevertingTokenIsUntitled() public {
        token.boom(DATA);
        assertEq(_name(_svg(address(token), 1)), "untitled");
    }

    function test_name_theDataOfARevertIsNotAName() public {
        token.boomWith(DATA, _good("Evil"));
        assertEq(_name(_svg(address(token), 1)), "untitled");
    }

    /// @dev 63 bytes that start with the canonical offset: one byte short of offset and length. The length word is
    ///      missing a byte, so there is no length to compare with the buffer (and nothing to subtract it from).
    function test_name_63BytesWithTheCanonicalOffsetAreShort() public {
        bytes memory b63 = abi.encodePacked(uint256(0x20), new bytes(31));
        assertEq(b63.length, 63);
        assertEq(_nameFor(b63), "untitled");
        assertEq(_nameFor(abi.encodePacked(uint256(0x20), _filled(31, 0xff))), "untitled");
    }

    function test_name_emptyOrShortReturndataIsUntitled() public {
        assertEq(_nameFor(""), "untitled", "no code / empty");
        assertEq(_nameFor(new bytes(63)), "untitled", "one byte short of offset and length");
        assertEq(_nameFor(hex"20"), "untitled");
        assertEq(_nameFor(_bytesRet(0x20, 0, "")), "untitled", "64 bytes, length zero");
        assertEq(_nameFor(_good("")), "untitled", "the canonical empty bytes");
    }

    function test_name_aNonCanonicalOffsetIsUntitled() public {
        assertEq(_nameFor(_bytesRet(0x40, 5, "hello")), "untitled");
        assertEq(_nameFor(_bytesRet(0x00, 5, "hello")), "untitled");
        assertEq(_nameFor(_bytesRet(0x21, 5, "hello")), "untitled");
        assertEq(_nameFor(_bytesRet(type(uint256).max, 5, "hello")), "untitled");
    }

    /// @dev `declared > ret.length - 64` is the bound: a length running one byte past the buffer is refused, and one
    ///      that fills it exactly is not.
    function test_name_theDeclaredLengthMustFitTheBuffer() public {
        assertEq(_nameFor(_bytesRet(0x20, 5, "hello")), "hello", "fills the buffer exactly");
        assertEq(_nameFor(_bytesRet(0x20, 6, "hello")), "untitled", "one byte past it");
        assertEq(_nameFor(_bytesRet(0x20, 4, "hello")), "hell", "shorter than the buffer is fine");
        assertEq(_nameFor(_bytesRet(0x20, type(uint256).max, "hello")), "untitled", "2^256-1 cannot overflow a bound");
        assertEq(_nameFor(_bytesRet(0x20, 2 ** 255, "hello")), "untitled");
        assertEq(_nameFor(_bytesRet(0x20, 65, hex"")), "untitled", "a length with nothing behind it");
    }

    function test_name_aLongReturnIsNotAnError() public {
        // Padding and trailing junk after a canonical value are ignored.
        assertEq(_nameFor(abi.encodePacked(_good("hello"), uint256(1), uint256(2))), "hello");
    }

    /// @dev 28 characters is the display cap; a name is a name up to 128 bytes (the hook's cap and `OrgMeta`'s rule), and
    ///      anything longer is none at all rather than a truncated one.
    function test_name_theDisplayCapAndItsEllipsis() public {
        bytes memory n28 = _filled(28, "x");
        assertEq(_nameFor(_good(n28)), string(n28), "28: shown whole");
        assertEq(_nameFor(_good(_filled(29, "x"))), string.concat(string(n28), unicode"…"), "29: truncated");
        assertEq(_nameFor(_good(_filled(100, "x"))), string.concat(string(n28), unicode"…"), "100: truncated");
        assertEq(_nameFor(_good(_filled(128, "x"))), string.concat(string(n28), unicode"…"), "128: truncated");
        assertEq(_nameFor(_good(_filled(129, "x"))), "untitled", "129: not a name");
        assertEq(_nameFor(_good(_filled(5000, "x"))), "untitled", "5000: not a name, bounded work");
        assertEq(_nameFor(_good(_filled(27, "x"))), string(_filled(27, "x")));
    }

    /// @dev `OrgMeta`'s rule decides whether there is a name at all: not only spaces, and not `-` (the SDK's "cleared").
    function test_name_isOrgMetasRule() public {
        assertEq(_nameFor(_good("-")), "untitled", "the cleared marker");
        assertEq(_nameFor(_good(" ")), "untitled", "a space");
        assertEq(_nameFor(_good(_filled(40, " "))), "untitled", "only spaces");
        assertEq(_nameFor(_good("--")), "--");
        assertEq(_nameFor(_good(" -")), " -");
        assertEq(_nameFor(_good(" a ")), " a ", "spaces around a visible character are kept");
    }

    function test_name_everyXmlMetacharacterIsEscapedAndNothingRawSurvives() public {
        assertEq(_nameFor(_good("&")), "&amp;");
        assertEq(_nameFor(_good("<")), "&lt;");
        assertEq(_nameFor(_good(">")), "&gt;");
        assertEq(_nameFor(_good('"')), "&quot;");
        assertEq(_nameFor(_good("'")), "&#39;");
        assertEq(_nameFor(_good("<b>'x'&\"</b>")), "&lt;b&gt;&#39;x&#39;&amp;&quot;&lt;/b&gt;");
        // The worst case: every character becomes the longest entity, at the cap.
        bytes memory quotes = _filled(28, '"');
        string memory want;
        for (uint256 i; i < 28; ++i) {
            want = string.concat(want, "&quot;");
        }
        assertEq(_nameFor(_good(quotes)), want);
    }

    /// @dev Printable ASCII (0x20..0x7e) is kept (the five XML metacharacters escaped); any other byte refuses the whole
    ///      name, boundaries included: a name with a byte dropped is not one anybody wrote.
    function test_name_onlyPrintableAsciiIsAName() public {
        for (uint256 c; c < 256; ++c) {
            bytes memory one = abi.encodePacked("a", bytes1(uint8(c)), "b");
            string memory got = _nameFor(_good(one));
            bool printable = c >= 0x20 && c <= 0x7e;
            string memory kept = c == 0x26
                ? "&amp;"
                : c == 0x3c ? "&lt;" : c == 0x3e ? "&gt;" : c == 0x22 ? "&quot;" : c == 0x27 ? "&#39;" : string(abi.encodePacked(bytes1(uint8(c))));
            assertEq(got, printable ? string.concat("a", kept, "b") : "untitled", "a name iff every byte is printable");
        }
        assertEq(_nameFor(_good(" ~")), " ~", "0x20 and 0x7e are the edges");
        assertEq(_nameFor(_good(hex"1f7f")), "untitled", "0x1f and 0x7f are just outside");
        assertEq(_nameFor(_good(hex"80ff")), "untitled");
    }

    function test_name_aNameWithNothingPrintableIsUntitled() public {
        assertEq(_nameFor(_good(hex"0102030405")), "untitled");
        assertEq(_nameFor(_good(unicode"日本語")), "untitled");
        // 29 bytes, none printable: the empty result wins over the ellipsis.
        assertEq(_nameFor(_good(_filled(29, 0x01))), "untitled");
    }

    /// @dev The whole name is checked, not only what is shown: a byte past the display cap still refuses it.
    function test_name_aByteBeyondTheDisplayCapStillCounts() public {
        assertEq(_nameFor(_good(abi.encodePacked(_filled(100, "p"), hex"01"))), "untitled");
        assertEq(_nameFor(_good(abi.encodePacked(_filled(14, "p"), _filled(14, 0x01), "q"))), "untitled");
        assertEq(_nameFor(_good(abi.encodePacked(_filled(127, "p"), "q"))), string.concat(string(_filled(28, "p")), unicode"…"));
    }

    // ─── The org's own name(): the card's header ─────────────────────────────

    function _orgFor(bytes memory answer) internal returns (string memory) {
        token.ret(ORG_NAME, answer);
        return _org(_svg(address(token), 1));
    }

    function test_orgHeader_aCanonicalNameIsShown() public {
        assertEq(_orgFor(_good("Acme Studio")), "Acme Studio");
        assertEq(_orgFor(_good("A&B")), "A&amp;B");
    }

    function test_orgHeader_failureFallsBackToTheProtocolName() public {
        token.boom(ORG_NAME);
        assertEq(_org(_svg(address(token), 1)), "ABX FS", "revert");
        assertEq(_orgFor(""), "ABX FS", "no code / empty");
        assertEq(_orgFor(new bytes(63)), "ABX FS", "short");
        assertEq(_orgFor(_bytesRet(0x20, 0, "")), "ABX FS", "empty string");
        assertEq(_orgFor(_bytesRet(0x40, 4, "Acme")), "ABX FS", "bad offset");
        assertEq(_orgFor(_bytesRet(0x20, 5, "Acme")), "ABX FS", "length past the buffer");
        assertEq(_orgFor(_bytesRet(0x20, type(uint256).max, "Acme")), "ABX FS", "2^256-1");
        // `name()` that answers a bare word, as a non-ERC-721 might.
        assertEq(_orgFor(abi.encode(uint256(2))), "ABX FS");
    }

    function test_orgHeader_theDataOfARevertIsNotAName() public {
        token.boomWith(ORG_NAME, _good("Evil"));
        assertEq(_org(_svg(address(token), 1)), "ABX FS");
    }

    function test_orgHeader_63BytesWithTheCanonicalOffsetAreShort() public {
        assertEq(_orgFor(abi.encodePacked(uint256(0x20), new bytes(31))), "ABX FS");
    }

    function test_orgHeader_nothingPrintableReadsAsUntitled() public {
        assertEq(_orgFor(_good(hex"0102")), "untitled");
    }

    /// @dev The header keeps exactly printable ASCII, 0x20 to 0x7e: the bytes just outside on either side are dropped.
    function test_orgHeader_keepsExactlyPrintableAscii() public {
        assertEq(_orgFor(_good(hex"1f207e7f41")), " ~A");
        for (uint256 c; c < 256; ++c) {
            string memory got = _orgFor(_good(abi.encodePacked("a", bytes1(uint8(c)))));
            bool printable = c >= 0x20 && c <= 0x7e;
            if (!printable) assertEq(got, "a", "dropped");
            else if (c != 0x26 && c != 0x3c && c != 0x3e && c != 0x22 && c != 0x27) {
                assertEq(got, string(abi.encodePacked("a", bytes1(uint8(c)))), "kept");
            }
        }
    }

    function test_orgHeader_isTruncatedLikeAProjectName() public {
        assertEq(_orgFor(_good(_filled(64, "W"))), string.concat(string(_filled(28, "W")), unicode"…"));
    }

    // ─── What is NOT defended against ────────────────────────────────────────

    /// @dev DOCUMENTED, NOT DESIRED: unlike `OrgMeta`'s reads, the card's reads forward all the gas they are given, so a
    ///      callee that burns it all starves the render itself, which then runs out of gas. That is outside the model:
    ///      the only callee ABX ever passes a field renderer is the org's own collection, never an arbitrary contract.
    ///      The same budget renders fine against an honest token, so it is the callee that costs it.
    function test_aGasBurningTokenStarvesTheRenderer_outOfModel() public {
        GasBurner burner = new GasBurner();
        card.render{gas: 6_000_000}(address(token), 1, "image");
        vm.expectRevert();
        card.render{gas: 6_000_000}(address(burner), 1, "image");
    }

    // ─── The artwork ─────────────────────────────────────────────────────────

    function test_unpublished_isNeutralSlateWithADashedGlyph() public {
        string memory svg = _svg(address(token), 1);
        assertTrue(LibString.contains(svg, 'stop-color="hsl(210,12%,52%)"'));
        assertTrue(LibString.contains(svg, 'stop-color="hsl(210,12%,34%)"'));
        assertTrue(
            LibString.contains(
                svg,
                '<g opacity="0.28"><rect x="168" y="150" width="64" height="64" rx="6" fill="none" stroke="#8b97ad" stroke-width="1.5" stroke-dasharray="4 4"/></g>'
            )
        );
        assertEq(_line(svg), "not yet published");
        assertEq(_name(svg), "untitled");
        assertEq(_org(svg), "ABX FS");
    }

    function _hues(bytes32 cid) internal returns (string memory svg) {
        token.ret(PARAM, _param(cid, 0, 1));
        return _svg(address(token), 1);
    }

    function _gradient(uint256 a, uint256 b) internal pure returns (string memory, string memory) {
        return (
            string.concat('stop-color="hsl(', LibString.toString(a), ',68%,52%)"'),
            string.concat('stop-color="hsl(', LibString.toString(b), ',68%,34%)"')
        );
    }

    /// @dev A CID whose first two bytes are `b0` and `b1` (the last byte keeps it nonzero).
    function _head(uint8 b0, uint8 b1) internal pure returns (bytes32) {
        bytes memory b = new bytes(32);
        b[0] = bytes1(b0);
        b[1] = bytes1(b1);
        b[31] = 0x01;
        return bytes32(b);
    }

    /// @dev hueA = cid[0] * 360 / 256, hueB = (hueA + 40 + cid[1] % 120) % 360, saturation 68 when published.
    function test_hues_followTheFirstTwoBytes() public {
        uint8[5] memory b0 = [0x00, 0xff, 0x80, 0x01, 0xc0];
        uint8[5] memory b1 = [0x00, 0xff, 0x77, 0x78, 0x7f];
        // (hueA, hueB): 0*360/256=0, 0+40+0; 255*360/256=358, (358+40+255%120=15)%360=53; 128*360/256=180,
        // (180+40+119)%360=339; 1*360/256=1, 1+40+(120%120=0)=41; 192*360/256=270, (270+40+127%120=7)%360=317.
        uint256[5] memory hueA = [uint256(0), 358, 180, 1, 270];
        uint256[5] memory hueB = [uint256(40), 53, 339, 41, 317];
        for (uint256 i; i < b0.length; ++i) {
            string memory svg = _hues(_head(b0[i], b1[i]));
            (string memory a, string memory b) = _gradient(hueA[i], hueB[i]);
            assertTrue(LibString.contains(svg, a), "first stop");
            assertTrue(LibString.contains(svg, b), "second stop");
        }
    }

    /// @dev A CID whose first sixteen bytes (the lattice) are all `fill` but byte `i1` = `v1` and byte `i2` = `v2`.
    function _lattice(uint8 fill, uint256 i1, uint8 v1, uint256 i2, uint8 v2) internal pure returns (bytes32) {
        bytes memory b = new bytes(32);
        for (uint256 i; i < 16; ++i) {
            b[i] = bytes1(fill);
        }
        b[i1] = bytes1(v1);
        b[i2] = bytes1(v2);
        b[31] = 0x0f;
        return bytes32(b);
    }

    function test_glyph_isA4x4LatticeThatSkipsMultiplesOfThree() public {
        // All multiples of three but the last: only cell 15 (column 3, row 3) is drawn, at opacity 30 + 4 % 60.
        assertTrue(
            LibString.contains(
                _hues(_lattice(3, 15, 4, 15, 4)),
                '<g><rect x="234" y="214" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.34"/></g>'
            )
        );

        // Nothing drawn: an empty group, and the card is still a well formed document.
        string memory svg = _hues(_lattice(0, 0, 0, 0, 0));
        assertTrue(LibString.contains(svg, "<g></g>"));
        assertTrue(LibString.endsWith(svg, "</svg>"));

        // Cells 0 and 5, in order: x = 132 + (i % 4) * 34, y = 112 + (i / 4) * 34, opacity 30 + b % 60.
        assertTrue(
            LibString.contains(
                _hues(_lattice(3, 0, 1, 5, 89)),
                '<g><rect x="132" y="112" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.31"/><rect x="166" y="146" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.59"/></g>'
            )
        );

        // The top of the range: 59 is not a multiple of three and gives 30 + 59 = 89; 254 gives 30 + 14 = 44.
        assertTrue(
            LibString.contains(
                _hues(_lattice(3, 0, 59, 0, 59)),
                '<g><rect x="132" y="112" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.89"/></g>'
            )
        );
        assertTrue(
            LibString.contains(
                _hues(_lattice(3, 0, 254, 0, 254)),
                '<g><rect x="132" y="112" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.44"/></g>'
            )
        );
        // 255 is a multiple of three, so it is skipped.
        assertTrue(LibString.contains(_hues(_lattice(3, 0, 255, 0, 255)), "<g></g>"));
    }

    /// @dev Cells 4 and 9 are the first of their rows (rows are `i / 4`, not `i / 5`): y = 146 and 180.
    function test_glyph_rowsAreIDividedByFour() public {
        assertTrue(
            LibString.contains(
                _hues(_lattice(3, 4, 1, 9, 2)),
                '<g><rect x="132" y="146" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.31"/><rect x="166" y="180" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.32"/></g>'
            )
        );
    }

    /// @dev Every cell drawn: the lattice is bounded at sixteen rects, however the CID is made. Byte 16 is not part of
    ///      the lattice, and it is not a multiple of three, so a seventeenth cell would be drawn if the loop ran on.
    function test_glyph_atMostSixteenCells() public {
        bytes32 raw = _lattice(1, 0, 1, 0, 1); // 1 % 3 != 0: every cell is drawn
        bytes memory b = abi.encodePacked(raw);
        b[16] = 0x01;
        string memory svg = _hues(bytes32(b));
        uint256 n;
        uint256 at = LibString.indexOf(svg, 'width="26" height="26"', 0);
        while (at != LibString.NOT_FOUND) {
            ++n;
            at = LibString.indexOf(svg, 'width="26" height="26"', at + 1);
        }
        assertEq(n, 16);
    }

    function test_shortCid_isFirstThreeAndLastTwoBytes() public {
        bytes32 cid = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
        token.ret(PARAM, _param(cid, 0, 1));
        assertEq(_line(_svg(address(token), 1)), unicode"v0  0x012345…cdef");
        token.ret(PARAM, _param(CID, 0, 1));
        assertEq(_line(_svg(address(token), 1)), unicode"v0  0xabcdef…1234");
    }

    // ─── Never reverts ───────────────────────────────────────────────────────

    /// @dev Every read answers with arbitrary bytes. The card renders a valid document or the test fails.
    function testFuzz_anyReturndataRendersADocument(bytes calldata p, bytes calldata d, bytes calldata n, bytes calldata v, uint256 id)
        public
    {
        token.ret(PARAM, p);
        token.ret(DATA, d);
        token.ret(ORG_NAME, n);
        hookStub.ret(VERSIONS, v);
        string memory svg = _svg(address(token), id);
        assertTrue(LibString.startsWith(svg, '<svg xmlns="http://www.w3.org/2000/svg"'));
        assertTrue(LibString.endsWith(svg, "</svg>"));
        // The header and the name come from a token that controls every byte of them: nothing raw reaches the markup.
        assertFalse(LibString.contains(_name(svg), "<"));
        assertFalse(LibString.contains(_org(svg), "<"));
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// ProjectTraits
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract ProjectTraitsHostileTest is RendererHostileBase {
    ProjectTraits internal traits;

    bytes32 internal constant KEY_NAME_ = "abxfs.name";
    bytes32 internal constant KEY_GATEWAY_ = "abxfs.gateway";

    function setUp() public override {
        super.setUp();
        traits = new ProjectTraits(address(hookStub));
    }

    /// @dev The whole document for the given facts.
    function _doc(string memory status, string memory kind, string memory versions, string memory named, string memory gw)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '[{"trait_type":"Status","value":"',
            status,
            '"},{"trait_type":"Root Kind","value":"',
            kind,
            '"},{"trait_type":"Versions","display_type":"number","value":',
            versions,
            '},{"trait_type":"Named","value":"',
            named,
            '"},{"trait_type":"Preferred IPFS Gateway","value":"',
            gw,
            '"}]'
        );
    }

    function _render(address tok, uint256 id) internal view returns (string memory) {
        (string memory ct, bytes memory data) = traits.render(tok, id, "attributes");
        assertEq(ct, "application/json");
        return string(data);
    }

    function test_hookIsTheConstructorArgument() public view {
        assertEq(address(traits.hook()), address(hookStub));
    }

    // ─── The field and the collection surface ────────────────────────────────

    function test_onlyAttributesIsComputed_andTheRevertNamesTheField() public {
        bytes32[4] memory wrong = [bytes32(0), bytes32("image"), bytes32("Attributes"), bytes32("attributes\x01")];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ProjectTraits.UnsupportedField.selector, wrong[i]));
            traits.render(address(token), 1, wrong[i]);
            vm.expectRevert(abi.encodeWithSelector(ProjectTraits.UnsupportedField.selector, wrong[i]));
            traits.render(address(token), SENTINEL, wrong[i]);
        }
    }

    function test_collectionSurface_isAnEmptyArrayWhateverTheTokenSays() public {
        token.ret(PARAM, _param(CID, 0, 1));
        hookStub.ret(VERSIONS, abi.encode(uint256(3)));
        (string memory ct, bytes memory data) = traits.render(address(token), SENTINEL, "attributes");
        assertEq(ct, "application/json");
        assertEq(string(data), "[]");
        (, data) = traits.render(address(0xdead), SENTINEL, "attributes");
        assertEq(string(data), "[]");
    }

    function test_aTokenThatAnswersNothingIsAnUnpublishedUnknownProject() public view {
        // No code: every read is an empty success. The hook, also scripted to nothing, reads "Unknown".
        assertEq(_render(address(0xdead), 1), _doc("Unpublished", "Unknown", "0", "No", "None"));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"));
    }

    // ─── Status: abxfs.cid ───────────────────────────────────────────────────

    function _status(bytes memory paramAnswer) internal returns (string memory) {
        token.ret(PARAM, paramAnswer);
        string memory doc = _render(address(token), 1);
        return doc;
    }

    function test_status_publishedOnlyForASetNonHashNonzeroValue() public {
        string memory published = _doc("Published", "Unknown", "0", "No", "None");
        string memory unpublished = _doc("Unpublished", "Unknown", "0", "No", "None");
        assertEq(_status(_param(CID, 0, 1)), published);
        assertEq(_status(_param(CID, 0, 2)), published, "non-canonical true");
        assertEq(_status(_param(CID, 0, type(uint256).max)), published);
        assertEq(_status(_param(CID, 1, 1)), unpublished, "a keccak commitment");
        assertEq(_status(_param(CID, 2, 1)), unpublished, "non-canonical hash flag");
        assertEq(_status(_param(CID, 0, 0)), unpublished, "not set");
        assertEq(_status(_param(bytes32(0), 0, 1)), unpublished, "a zero value");
    }

    function test_status_shortLongAndRevertingReturndata() public {
        string memory published = _doc("Published", "Unknown", "0", "No", "None");
        string memory unpublished = _doc("Unpublished", "Unknown", "0", "No", "None");
        bytes memory full = _param(CID, 0, 1);
        bytes memory short95 = new bytes(95);
        for (uint256 i; i < 95; ++i) short95[i] = full[i];
        assertEq(_status(short95), unpublished);
        assertEq(_status(""), unpublished);
        assertEq(_status(abi.encode(CID, uint256(0))), unpublished);
        assertEq(_status(abi.encodePacked(full, hex"00")), published);
        assertEq(_status(abi.encodePacked(full, full)), published);
        token.boom(PARAM);
        assertEq(_render(address(token), 1), unpublished);
    }

    function test_status_theDataOfARevertIsNotAnAnswer() public {
        token.boomWith(PARAM, _param(CID, 0, 1));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"));
    }

    function test_status_95BytesWhoseThirdWordIsNonzeroAreStillShort() public {
        assertEq(
            _status(abi.encodePacked(CID, uint256(0), _filled(31, 0xff))),
            _doc("Unpublished", "Unknown", "0", "No", "None")
        );
    }

    /// @dev Whole words, whichever byte is set: a CID whose only nonzero byte is its first is a CID, and a flag word
    ///      whose only set byte is its first is true.
    function test_status_wordsAreReadWholeNotByTheirLastBytes() public {
        string memory published = _doc("Published", "Unknown", "0", "No", "None");
        assertEq(_status(_param(bytes32(uint256(0xff) << 248), 0, 1)), published, "value with only its top byte set");
        assertEq(_status(_param(CID, 0, uint256(1) << 248)), published, "isSet with only its top byte set");
        assertEq(
            _status(_param(CID, uint256(1) << 248, 1)), _doc("Unpublished", "Unknown", "0", "No", "None"), "hash flag, top byte"
        );
    }

    // ─── Versions: the hook's versionCount ───────────────────────────────────

    function test_versions_isTheHooksWordOrZero() public {
        hookStub.ret(VERSIONS, abi.encode(uint256(12)));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "12", "No", "None"));
        hookStub.ret(VERSIONS, abi.encode(type(uint256).max));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", vm.toString(type(uint256).max), "No", "None"));
        hookStub.ret(VERSIONS, abi.encode(uint256(12), uint256(99)));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "12", "No", "None"), "long: first word");
        hookStub.ret(VERSIONS, new bytes(31));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "short");
        hookStub.ret(VERSIONS, _filled(31, 0x01));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "short, nonzero");
        hookStub.boomWith(VERSIONS, abi.encode(uint256(12)));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "the data of a revert");
        hookStub.ret(VERSIONS, "");
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "empty");
        hookStub.boom(VERSIONS);
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "reverting");
    }

    // ─── Root Kind: the hook's kindOf ────────────────────────────────────────

    function _kind(bytes memory answer) internal returns (string memory) {
        hookStub.ret(KIND, answer);
        return _render(address(token), 1);
    }

    function test_kind_0IsNone_1IsDirectory_2IsFile_everyOtherWordIsNone() public {
        assertEq(_kind(abi.encode(uint256(0))), _doc("Unpublished", "None", "0", "No", "None"));
        assertEq(_kind(abi.encode(uint256(1))), _doc("Unpublished", "Directory", "0", "No", "None"));
        assertEq(_kind(abi.encode(uint256(2))), _doc("Unpublished", "File", "0", "No", "None"));
        assertEq(_kind(abi.encode(uint256(3))), _doc("Unpublished", "None", "0", "No", "None"));
        assertEq(_kind(abi.encode(uint256(256))), _doc("Unpublished", "None", "0", "No", "None"));
        assertEq(_kind(abi.encode(type(uint256).max)), _doc("Unpublished", "None", "0", "No", "None"));
        // A value that would be 1 in its low byte is not 1.
        assertEq(_kind(abi.encode(uint256(1) << 8 | 1)), _doc("Unpublished", "None", "0", "No", "None"));
    }

    function test_kind_longReturndataReadsTheFirstWord() public {
        assertEq(_kind(abi.encode(uint256(2), uint256(1))), _doc("Unpublished", "File", "0", "No", "None"));
        assertEq(_kind(abi.encodePacked(uint256(1), hex"02")), _doc("Unpublished", "Directory", "0", "No", "None"));
    }

    function test_kind_aShortAnswerIsUnknownWhateverItHolds() public {
        // 31 bytes whose word, read with one byte of zero memory after it, would be 256 ("None") or 512.
        assertEq(_kind(abi.encodePacked(new bytes(30), hex"01")), _doc("Unpublished", "Unknown", "0", "No", "None"));
        assertEq(_kind(abi.encodePacked(new bytes(30), hex"02")), _doc("Unpublished", "Unknown", "0", "No", "None"));
        hookStub.boomWith(KIND, abi.encode(uint256(2)));
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "the data of a revert");
    }

    function test_kind_failureIsUnknown() public {
        assertEq(_kind(""), _doc("Unpublished", "Unknown", "0", "No", "None"), "empty / no code");
        assertEq(_kind(new bytes(31)), _doc("Unpublished", "Unknown", "0", "No", "None"), "short");
        assertEq(_kind(hex"01"), _doc("Unpublished", "Unknown", "0", "No", "None"), "one byte");
        hookStub.boom(KIND);
        assertEq(_render(address(token), 1), _doc("Unpublished", "Unknown", "0", "No", "None"), "reverting");
    }

    // ─── Named / Preferred IPFS Gateway: is a `bytes` param non-empty? ───────

    /// @dev One token answering the data selector for BOTH keys, so `Named` and `Preferred IPFS Gateway` move
    ///      together. {test_namedAndGatewayAreReadIndependently} separates them.
    function _both(bytes memory answer) internal returns (string memory) {
        token.ret(DATA, answer);
        return _render(address(token), 1);
    }

    function _yesSet() internal pure returns (string memory) {
        return _doc("Unpublished", "Unknown", "0", "Yes", "Set");
    }

    function _noNone() internal pure returns (string memory) {
        return _doc("Unpublished", "Unknown", "0", "No", "None");
    }

    function test_presence_aNonEmptyCanonicalBytesIsPresent() public {
        assertEq(_both(_good("x")), _yesSet());
        assertEq(_both(_good("https://gw.example")), _yesSet());
        // A gateway of any length is Set; a name longer than 128 bytes is not one the token's `name` shows.
        assertEq(_both(_good(_filled(5000, "x"))), _doc("Unpublished", "Unknown", "0", "No", "Set"), "long values");
    }

    /// @dev `-` is how the SDK clears a string param (ABX refuses an empty value): it is absent for both traits.
    function test_presence_theClearedMarkerIsAbsent() public {
        assertEq(_both(_good("-")), _noNone());
        // Only a lone `-`: anything around it is a value.
        assertEq(_both(_good("--")), _yesSet());
        assertEq(_both(_good("-a")), _yesSet());
        assertEq(_both(_good(" -")), _yesSet());
    }

    /// @dev Named follows `OrgMeta`'s name rule exactly (1..128 bytes of printable ASCII, not only spaces, not `-`), so
    ///      the trait, the card and the token's `name` agree. Preferred IPFS Gateway is presence only.
    function test_named_isOrgMetasNameRule() public {
        KeyedStub keyed = new KeyedStub();
        bytes memory n128 = _filled(128, "n");
        keyed.set(KEY_NAME_, _good(n128));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "Yes", "None"), "128 bytes");
        keyed.set(KEY_NAME_, _good(abi.encodePacked(n128, "n")));
        assertEq(_render(address(keyed), 1), _noNone(), "129 bytes");
        keyed.set(KEY_NAME_, _good("   "));
        assertEq(_render(address(keyed), 1), _noNone(), "only spaces");
        keyed.set(KEY_NAME_, _good(" a "));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "Yes", "None"), "spaces around");
        keyed.set(KEY_NAME_, _good(unicode"café"));
        assertEq(_render(address(keyed), 1), _noNone(), "non-ASCII");
        keyed.set(KEY_NAME_, _good(hex"615c6e62"));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "Yes", "None"), "a backslash is printable");
        keyed.set(KEY_NAME_, _good(hex"610a62"));
        assertEq(_render(address(keyed), 1), _noNone(), "a newline is not");
        for (uint256 c; c < 256; ++c) {
            keyed.set(KEY_NAME_, _good(abi.encodePacked("a", bytes1(uint8(c)))));
            bool printable = c >= 0x20 && c <= 0x7e;
            assertEq(
                _render(address(keyed), 1),
                _doc("Unpublished", "Unknown", "0", printable ? "Yes" : "No", "None"),
                string.concat("byte ", vm.toString(c))
            );
        }
        // The gateway is not held to it: any non-empty value but `-` is Set.
        keyed.set(KEY_NAME_, "");
        keyed.set(KEY_GATEWAY_, _good(unicode"ipfs://café"));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "No", "Set"));
        keyed.set(KEY_GATEWAY_, _good("-"));
        assertEq(_render(address(keyed), 1), _noNone());
    }

    function test_presence_anEmptyValueIsAbsent() public {
        assertEq(_both(_good("")), _noNone());
        assertEq(_both(_bytesRet(0x20, 0, "")), _noNone());
    }

    function test_presence_shortOrRevertingOrNoCodeIsAbsent() public {
        assertEq(_both(""), _noNone());
        assertEq(_both(new bytes(63)), _noNone(), "63 bytes: one short of the head");
        assertEq(_both(hex"20"), _noNone());
        token.boom(DATA);
        assertEq(_render(address(token), 1), _noNone());
    }

    function test_presence_theDataOfARevertIsNotAValue() public {
        token.boomWith(DATA, _good("x"));
        assertEq(_render(address(token), 1), _noNone());
    }

    /// @dev 63 bytes starting with the canonical offset: no complete length word, and nothing to subtract it from.
    function test_presence_63BytesWithTheCanonicalOffsetAreShort() public {
        assertEq(_both(abi.encodePacked(uint256(0x20), new bytes(31))), _noNone());
        assertEq(_both(abi.encodePacked(uint256(0x20), _filled(31, 0xff))), _noNone());
    }

    function test_presence_aNonCanonicalOffsetIsAbsent() public {
        assertEq(_both(_bytesRet(0x40, 1, "x")), _noNone());
        assertEq(_both(_bytesRet(0x00, 1, "x")), _noNone());
        assertEq(_both(_bytesRet(0x21, 1, "x")), _noNone());
        assertEq(_both(_bytesRet(type(uint256).max, 1, "x")), _noNone());
    }

    /// @dev `declared > ret.length - 64` is the bound.
    function test_presence_theDeclaredLengthMustFitTheBuffer() public {
        assertEq(_both(_bytesRet(0x20, 1, "x")), _yesSet(), "fills the buffer exactly");
        assertEq(_both(_bytesRet(0x20, 2, "x")), _noNone(), "one byte past it");
        assertEq(_both(_bytesRet(0x20, type(uint256).max, "x")), _noNone(), "2^256-1 cannot overflow the bound");
        assertEq(_both(_bytesRet(0x20, 1, hex"")), _noNone(), "a length with nothing behind it");
    }

    function test_presence_trailingBytesAreNotAnError() public {
        assertEq(_both(abi.encodePacked(_good("x"), uint256(1), uint256(2))), _yesSet());
    }

    /// @dev The renderer cannot tell the two keys apart by selector alone, so this uses a token that answers by key.
    function test_namedAndGatewayAreReadIndependently() public {
        KeyedStub keyed = new KeyedStub();
        keyed.set(KEY_NAME_, _good("A name"));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "Yes", "None"));
        keyed.set(KEY_NAME_, "");
        keyed.set(KEY_GATEWAY_, _good("https://gw.example"));
        assertEq(_render(address(keyed), 1), _doc("Unpublished", "Unknown", "0", "No", "Set"));
        keyed.set(KEY_NAME_, _good("A name"));
        assertEq(_render(address(keyed), 1), _yesSet());
    }

    /// @dev DOCUMENTED, NOT DESIRED: see `ProjectCardHostileTest`. The reads forward all their gas; a burner starves
    ///      the render, which is outside the model (the callee is always the org's own collection).
    function test_aGasBurningTokenStarvesTheRenderer_outOfModel() public {
        GasBurner burner = new GasBurner();
        traits.render{gas: 6_000_000}(address(token), 1, "attributes");
        vm.expectRevert();
        traits.render{gas: 6_000_000}(address(burner), 1, "attributes");
    }

    // ─── Never reverts ───────────────────────────────────────────────────────

    /// @dev Every read answers with arbitrary bytes. The output is a document of five traits in a fixed vocabulary.
    function testFuzz_anyReturndataRendersTheSameFiveTraits(
        bytes calldata p,
        bytes calldata d,
        bytes calldata v,
        bytes calldata k,
        uint256 id
    ) public {
        vm.assume(id != SENTINEL); // the collection surface is "[]", tested on its own
        token.ret(PARAM, p);
        token.ret(DATA, d);
        hookStub.ret(VERSIONS, v);
        hookStub.ret(KIND, k);
        string memory doc = _render(address(token), id);
        assertTrue(LibString.startsWith(doc, '[{"trait_type":"Status","value":"'));
        assertTrue(LibString.endsWith(doc, '"}]'));
        // Fixed vocabulary only: a number and nothing a token wrote.
        assertTrue(LibString.contains(doc, '"trait_type":"Versions","display_type":"number","value":'));
    }
}

/// @dev Answers `tokenParamData` per key, one `bytes` for each.
contract KeyedStub {
    mapping(bytes32 => bytes) internal _by;

    function set(bytes32 key, bytes calldata answer) external {
        _by[key] = answer;
    }

    fallback(bytes calldata cd) external returns (bytes memory) {
        if (msg.sig != IAbxParams.tokenParamData.selector) return "";
        (, bytes32 key) = abi.decode(cd[4:], (uint256, bytes32));
        return _by[key];
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// ProjectLinks
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract ProjectLinksHostileTest is RendererHostileBase {
    string internal constant BASE = "https://fs.abx.io";
    bytes32 internal constant ANIM = "animation_url";
    bytes32 internal constant EXT = "external_url";

    ProjectLinks internal links;

    function setUp() public override {
        super.setUp();
        links = new ProjectLinks(BASE);
    }

    function _default(address tok, uint256 id, bool animation) internal view returns (string memory) {
        string memory head = string.concat(BASE, animation ? "/g/p/" : "/projects/", vm.toString(block.chainid), "/");
        return string.concat(head, LibString.toHexString(tok), "/", LibString.toString(id), animation ? "/latest/" : "");
    }

    function _get(address tok, uint256 id, bytes32 field) internal view returns (string memory) {
        (string memory ct, bytes memory data) = links.render(tok, id, field);
        assertEq(ct, "text/uri-list");
        return string(data);
    }

    function _view(bytes memory answer) internal returns (string memory) {
        token.ret(DATA, answer);
        return _get(address(token), 1, ANIM);
    }

    function test_gatewayBaseIsTheConstructorArgument() public view {
        assertEq(links.gatewayBase(), BASE);
    }

    // ─── Fields and the collection surface ───────────────────────────────────

    function test_defaults_areAPureFunctionOfChainOrgAndId() public view {
        assertEq(_get(address(token), 7, ANIM), _default(address(token), 7, true));
        assertEq(_get(address(token), 7, EXT), _default(address(token), 7, false));
        assertEq(_get(address(token), 0, ANIM), _default(address(token), 0, true));
        assertEq(_get(address(token), SENTINEL - 1, EXT), _default(address(token), SENTINEL - 1, false));
    }

    function test_anyOtherFieldIsEmpty_neverAnError() public view {
        bytes32[4] memory others = [bytes32(0), bytes32("image"), bytes32("animation_ur"), bytes32("EXTERNAL_URL")];
        for (uint256 i; i < others.length; ++i) {
            assertEq(_get(address(token), 3, others[i]), "");
        }
    }

    /// @dev The collection surface answers the same for EVERY field, the unknown ones included: the check for it
    ///      comes before the field check.
    /// @dev The collection surface has no project: the site itself, for every field, whatever the token answers. The
    ///      org's own page is reachable by direct link only and is linked from nowhere.
    function test_collectionSurface_isTheSiteForEveryField() public {
        token.ret(DATA, _good("https://my-site.example/"));
        assertEq(_get(address(token), SENTINEL, ANIM), BASE);
        assertEq(_get(address(token), SENTINEL, EXT), BASE);
        assertEq(_get(address(token), SENTINEL, "image"), BASE);
        assertEq(_get(address(token), SENTINEL, bytes32(0)), BASE);
    }

    // ─── abxfs.view: shapes of the `bytes` answer ────────────────────────────

    function test_view_aUsableValueReplacesBothFieldsVerbatim() public {
        token.ret(DATA, _good("https://my-site.example/app?x=1#top"));
        assertEq(_get(address(token), 1, ANIM), "https://my-site.example/app?x=1#top");
        assertEq(_get(address(token), 1, EXT), "https://my-site.example/app?x=1#top");
    }

    function test_view_failureFallsBackToTheDefault() public {
        string memory d = _default(address(token), 1, true);
        token.boom(DATA);
        assertEq(_get(address(token), 1, ANIM), d, "reverting");
        assertEq(_view(""), d, "empty / no code");
        assertEq(_view(new bytes(63)), d, "63 bytes");
        assertEq(_view(_good("")), d, "empty value");
        assertEq(_get(address(0xdead), 1, ANIM), _default(address(0xdead), 1, true), "no code");
        assertEq(_get(address(0), 1, EXT), _default(address(0), 1, false), "the zero address");
    }

    function test_view_theDataOfARevertIsNotAUrl() public {
        string memory d = _default(address(token), 1, true);
        token.boomWith(DATA, _good("https://evil.example"));
        assertEq(_get(address(token), 1, ANIM), d);
        assertEq(_get(address(token), 1, EXT), _default(address(token), 1, false));
    }

    function test_view_63BytesWithTheCanonicalOffsetAreShort() public {
        string memory d = _default(address(token), 1, true);
        assertEq(_view(abi.encodePacked(uint256(0x20), new bytes(31))), d);
        assertEq(_view(abi.encodePacked(uint256(0x20), _filled(31, 0xff))), d);
    }

    function test_view_aNonCanonicalOffsetFallsBack() public {
        string memory d = _default(address(token), 1, true);
        bytes memory u = "https://a.example";
        assertEq(_view(_bytesRet(0x40, u.length, u)), d);
        assertEq(_view(_bytesRet(0x00, u.length, u)), d);
        assertEq(_view(_bytesRet(0x21, u.length, u)), d);
        assertEq(_view(_bytesRet(0x20, u.length, u)), string(u), "the canonical offset is used");
    }

    function test_view_theDeclaredLengthMustFitTheBuffer() public {
        string memory d = _default(address(token), 1, true);
        bytes memory u = "https://a.example";
        assertEq(_view(_bytesRet(0x20, u.length, u)), string(u), "fills the buffer exactly");
        assertEq(_view(_bytesRet(0x20, u.length + 1, u)), d, "one byte past it");
        assertEq(_view(_bytesRet(0x20, type(uint256).max, u)), d, "2^256-1 cannot overflow the bound");
        assertEq(_view(_bytesRet(0x20, 513, hex"")), d, "past the cap and past the buffer");
    }

    /// @dev The cap is 512 bytes: at it the value is used, one over it falls back (even though the buffer holds it).
    function test_view_theCapIs512BytesAndIsNotTruncated() public {
        string memory d = _default(address(token), 1, true);
        bytes memory prefix = "https://a.example/";
        bytes memory at = abi.encodePacked(prefix, _filled(512 - prefix.length, "a"));
        assertEq(at.length, 512);
        assertEq(_view(_good(at)), string(at));
        assertEq(_view(_good(abi.encodePacked(at, "a"))), d, "513 is refused, not cut to 512");
        assertEq(_view(_good(_filled(10_000, "a"))), d);
    }

    /// @dev "https://" plus at least one character.
    function test_view_theShortestUsableValueIsNineBytes() public {
        string memory d = _default(address(token), 1, true);
        assertEq(_view(_good("https://")), d, "eight bytes: the scheme alone");
        assertEq(_view(_good("https://a")), "https://a", "nine");
        assertEq(_view(_good("short")), d);
    }

    function test_view_theSchemeIsExactlyLowercaseHttps() public {
        string memory d = _default(address(token), 1, true);
        string[9] memory bad = [
            "HTTPS://a.example",
            "Https://a.example",
            "httpS://a.example",
            "http://a.example/",
            "https:/a.example/x",
            "https//a.example/x",
            "ftp://a.example/xx",
            "javascript:alert(1)",
            " https://a.example"
        ];
        for (uint256 i; i < bad.length; ++i) {
            assertEq(_view(_good(bytes(bad[i]))), d, bad[i]);
        }
        // Same length as the scheme check, different case in the last byte of "https://" only.
        assertEq(_view(_good("https:/ /a")), d);
    }

    /// @dev Every byte value, in the middle of an otherwise good URL: usable iff it is visible ASCII (0x21..0x7e)
    ///      and not one of `"` `&` `'` `<` `>` `\` `` ` ``.
    function test_view_everyByteValue() public {
        string memory d = _default(address(token), 1, true);
        for (uint256 c; c < 256; ++c) {
            bytes memory url = abi.encodePacked("https://a.example/", bytes1(uint8(c)), "z");
            // JSON and markup breakers, the RFC 3986 outlaws, and what ends a Markdown link or a CSS `url()`.
            bool unsafe = c == 0x22 || c == 0x26 || c == 0x27 || c == 0x28 || c == 0x29 || c == 0x3c || c == 0x3e
                || c == 0x5b || c == 0x5c || c == 0x5d || c == 0x5e || c == 0x60 || c == 0x7b || c == 0x7c || c == 0x7d;
            bool usable = c >= 0x21 && c <= 0x7e && !unsafe;
            assertEq(_view(_good(url)), usable ? string(url) : d, string.concat("byte ", vm.toString(c)));
        }
        // The edges as the first and last byte after the scheme as well.
        assertEq(_view(_good("https://!")), "https://!");
        assertEq(_view(_good("https://~")), "https://~");
        assertEq(_view(_good("https://!~")), "https://!~");
    }

    function test_view_aDefaultIsUsedPerField_notShared() public {
        token.ret(DATA, _good("https://ok.example"));
        assertEq(_get(address(token), 1, ANIM), "https://ok.example");
        token.ret(DATA, _good("http://not.ok"));
        assertEq(_get(address(token), 1, ANIM), _default(address(token), 1, true));
        assertEq(_get(address(token), 1, EXT), _default(address(token), 1, false));
    }

    /// @dev DOCUMENTED, NOT DESIRED: `ProjectLinks` says so itself ("the call has no gas or returndata cap (unlike
    ///      `OrgMeta`'s reads): the only callee ABX ever passes is the org itself"). A burner starves the render.
    function test_aGasBurningTokenStarvesTheRenderer_outOfModel() public {
        GasBurner burner = new GasBurner();
        // A smaller budget than the other two renderers: after a burner takes 63/64 of it, what is left must be too
        // little to assemble even this short URL, while the same budget is plenty against an honest token.
        links.render{gas: 100_000}(address(token), 1, ANIM);
        vm.expectRevert();
        links.render{gas: 100_000}(address(burner), 1, ANIM);
    }

    // ─── Never reverts ───────────────────────────────────────────────────────

    function testFuzz_anyReturndataIsEitherTheVerbatimViewOrTheDefault(bytes calldata answer, uint256 id, bool animation) public {
        vm.assume(id != SENTINEL);
        token.ret(DATA, answer);
        string memory got = _get(address(token), id, animation ? ANIM : EXT);
        string memory d = _default(address(token), id, animation);
        if (keccak256(bytes(got)) != keccak256(bytes(d))) {
            // Used: it must be the canonical value, https only, with nothing that could leave a JSON string.
            assertTrue(LibString.startsWith(got, "https://"));
            assertLe(bytes(got).length, 512);
            bytes memory g = bytes(got);
            for (uint256 i; i < g.length; ++i) {
                uint8 c = uint8(g[i]);
                assertTrue(c >= 0x21 && c <= 0x7e);
                assertTrue(c != 0x22 && c != 0x26 && c != 0x27 && c != 0x3c && c != 0x3e && c != 0x5c && c != 0x60);
            }
        }
    }
}
