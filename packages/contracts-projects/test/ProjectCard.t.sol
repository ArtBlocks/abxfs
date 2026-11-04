// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectHook} from "../src/ProjectHook.sol";

import {MockStore, MockAbxToken, RevertingAbxToken} from "./mocks/Mocks.sol";

/// @dev The ABX metadata renderer `staticcall`s this renderer with NO try/catch while building
///      `tokenURI`, so a revert here does not degrade the image — it bricks the token's entire
///      metadata document. Every test below that asserts "does not revert" is guarding that, and it
///      is the reason the renderer wraps each external read.
contract ProjectCardTest is Test {
    using LibString for string;

    ProjectHook internal hook;
    ProjectCard internal card;
    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxToken internal token;

    /// @dev The published-card template's fixed `<` count, measured against a markup-free name.
    uint256 internal templateOpenTags;

    address internal alice = address(0xA11CE);

    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_NAME = "abxfs.name";
    bytes32 internal constant FIELD_IMAGE = "image";

    bytes32 internal constant DIR_A = keccak256("dir-a");
    uint256 internal constant TOKEN = 7;
    uint256 internal constant COLLECTION_SENTINEL = type(uint256).max;

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        card = new ProjectCard(address(hook));
        token = new MockAbxToken(address(hook));

        dirStore.add(DIR_A);
        token.setOwner(TOKEN, alice);

        MockAbxToken clean = new MockAbxToken(address(hook));
        clean.forceData(TOKEN, KEY_NAME, "clean");
        (, bytes memory baseline) = card.render(address(clean), TOKEN, FIELD_IMAGE);
        templateOpenTags = _countOpenTags(baseline);
    }

    function _countOpenTags(bytes memory data) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == "<") ++count;
        }
    }

    function _render(address tokenAddr, uint256 tokenId) internal view returns (string memory) {
        (string memory contentType, bytes memory data) = card.render(tokenAddr, tokenId, FIELD_IMAGE);
        assertEq(contentType, "image/svg+xml", "contentType is part of the renderer contract");
        return string(data);
    }

    function _publishAndName(bytes memory name) internal {
        vm.startPrank(alice);
        token.configure(TOKEN, KEY_CID, DIR_A);
        token.configureData(TOKEN, KEY_NAME, name);
        vm.stopPrank();
    }

    // ─── Never revert ─────────────────────────────────────────────────────────

    function test_Render_UnsetTokenStillProducesACard() public view {
        string memory svg = _render(address(token), TOKEN);
        assertTrue(svg.startsWith("<svg"));
        assertTrue(svg.endsWith("</svg>"));
        assertTrue(svg.contains("not yet published"));
        assertTrue(svg.contains("untitled"));
    }

    /// @dev Invariant #1 names this case explicitly: `contractURI` renders with
    ///      `tokenId == type(uint256).max`, which is not a real token.
    function test_Render_CollectionSentinel() public view {
        string memory svg = _render(address(token), COLLECTION_SENTINEL);
        assertTrue(svg.startsWith("<svg"));
        assertTrue(svg.contains("ABX FS"));
    }

    /// @dev A collection whose param reads all revert must not be able to brick `tokenURI`.
    function test_Render_TokenThatRevertsOnEveryRead() public {
        RevertingAbxToken hostile = new RevertingAbxToken();
        string memory svg = _render(address(hostile), TOKEN);
        assertTrue(svg.startsWith("<svg"));
        assertTrue(svg.contains("untitled"));
        assertTrue(svg.contains("not yet published"));
    }

    /// @dev An address with no code at all — a mis-wired deploy, or a collection selfdestructed out
    ///      from under the renderer.
    function test_Render_NonContractToken() public view {
        string memory svg = _render(address(0xDEAD), TOKEN);
        assertTrue(svg.startsWith("<svg"));
    }

    /// @dev A `abxfs.cid` declared as `String`/`Bytes` instead of a scalar would put a keccak
    ///      commitment in the bytes32. That is not a CID, so the card must treat it as unpublished
    ///      rather than display a hash as if it were content.
    function test_Render_HashValuedCidIsTreatedAsUnpublished() public {
        token.forceParam(TOKEN, KEY_CID, keccak256("commitment"), true);
        string memory svg = _render(address(token), TOKEN);
        assertTrue(svg.contains("not yet published"));
    }

    function test_Render_PublishedProject() public {
        _publishAndName("my-cool-art");
        string memory svg = _render(address(token), TOKEN);

        assertTrue(svg.contains("my-cool-art"));
        assertTrue(svg.contains("v1"));
        assertFalse(svg.contains("not yet published"));
    }

    function test_Render_VersionCountTracksPublishes() public {
        dirStore.add(keccak256("dir-b"));
        vm.startPrank(alice);
        token.configure(TOKEN, KEY_CID, DIR_A);
        token.configure(TOKEN, KEY_CID, keccak256("dir-b"));
        vm.stopPrank();

        assertTrue(_render(address(token), TOKEN).contains("v2"));
    }

    // ─── The name is owner-controlled text going into an XML document ─────────

    function test_Name_XmlMetacharactersAreEscaped() public {
        _publishAndName('<script>&"x');
        string memory svg = _render(address(token), TOKEN);

        assertTrue(svg.contains("&lt;script&gt;&amp;&quot;x"), "must be escaped, not passed through");
        assertFalse(svg.contains("<script>"), "raw tag must never survive into the document");
    }

    function test_Name_SingleQuoteEscaped() public {
        _publishAndName("it's");
        assertTrue(_render(address(token), TOKEN).contains("it&#39;s"));
    }

    /// @dev A closing-tag injection is the specific attack: an unescaped name could terminate the
    ///      `<text>` element and append arbitrary SVG.
    function test_Name_CannotBreakOutOfTextElement() public {
        _publishAndName("</text><rect width=\"400\" height=\"400\" fill=\"red\"/><text>");
        string memory svg = _render(address(token), TOKEN);
        assertFalse(svg.contains("</text><rect"));
        assertFalse(svg.contains('fill="red"'));
    }

    /// @dev A name with any byte outside printable ASCII is not a name the token's `name` shows (`OrgMeta`), so the
    ///      card does not show it either, not even with the byte dropped: "untitled", whole.
    function test_Name_NonAsciiRefusesTheWholeName() public {
        _publishAndName(hex"6100ff62");
        string memory svg = _render(address(token), TOKEN);
        assertTrue(svg.contains("untitled"));
        assertFalse(svg.contains(">ab<"));
    }

    function test_Name_AllNonPrintableFallsBackToUntitled() public {
        _publishAndName(hex"00010203");
        assertTrue(_render(address(token), TOKEN).contains("untitled"));
    }

    /// @dev The hook caps `abxfs.name` at 128 bytes, but the renderer must stay bounded even against
    ///      a collection that never armed the hook: a longer name is refused whole, and one within the cap is
    ///      shown truncated.
    function test_Name_LongNameIsBoundedIndependentlyOfTheHook() public {
        bytes memory long = new bytes(4096);
        for (uint256 i = 0; i < long.length; ++i) {
            long[i] = "a";
        }
        token.forceData(TOKEN, KEY_NAME, long); // bypasses the hook's cap on purpose

        string memory svg = _render(address(token), TOKEN);
        assertLt(bytes(svg).length, 4096, "output must not scale with the name");
        assertTrue(svg.contains("untitled"), "past the cap is no name at all");

        assembly {
            mstore(long, 100)
        }
        token.forceData(TOKEN, KEY_NAME, long);
        svg = _render(address(token), TOKEN);
        assertTrue(svg.contains(unicode"…"), "truncation should be visible");
    }

    /// @dev Invariant #5: `tokenURI` must stay a cheap single `eth_call`.
    function test_Render_OutputIsSmall() public {
        _publishAndName("a-reasonably-long-project-name");
        assertLt(bytes(_render(address(token), TOKEN)).length, 2048);
    }

    // ─── Field guard ──────────────────────────────────────────────────────────

    /// @dev Invariant #3: reverting on a field this renderer does not compute is correct — that is a
    ///      deploy-time miswiring, not a runtime path. It must never fire for `image`.
    function test_Render_UnsupportedFieldReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ProjectCard.UnsupportedField.selector, bytes32("attributes"))
        );
        card.render(address(token), TOKEN, "attributes");
    }

    // ─── Fuzz: the never-revert guarantee, over the whole input space ─────────

    function testFuzz_RenderNeverRevertsForAnyTokenId(uint256 tokenId) public view {
        card.render(address(token), tokenId, FIELD_IMAGE);
    }

    function testFuzz_RenderNeverRevertsForAnyCid(bytes32 cid) public {
        token.forceParam(TOKEN, KEY_CID, cid, false);
        card.render(address(token), TOKEN, FIELD_IMAGE);
    }

    function testFuzz_RenderNeverRevertsForAnyNameBytes(bytes calldata name) public {
        vm.assume(name.length <= 2048);
        token.forceData(TOKEN, KEY_NAME, name);
        (, bytes memory data) = card.render(address(token), TOKEN, FIELD_IMAGE);
        assertTrue(string(data).startsWith("<svg"));
    }

    /// @dev Escaping is only useful if it holds for arbitrary input, not the cases we thought of.
    ///      The template contributes a fixed number of `<`, so any excess came from the name and
    ///      means the escaper leaked markup into the document.
    function testFuzz_NoRawAngleBracketsFromTheName(bytes calldata name) public {
        vm.assume(name.length <= 256);
        token.forceData(TOKEN, KEY_NAME, name);
        (, bytes memory data) = card.render(address(token), TOKEN, FIELD_IMAGE);
        assertEq(_countOpenTags(data), templateOpenTags, "name must contribute no markup");
    }
}
