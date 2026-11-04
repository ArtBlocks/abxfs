// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";

import {MockStore, MockAbxToken, RevertingAbxToken} from "./mocks/Mocks.sol";

/// @dev Same binding constraint as the card: the ABX metadata renderer `staticcall`s this with no
///      try/catch while building `tokenURI`, so a revert here bricks the token's whole metadata
///      document rather than degrading one field. The "must not revert" cases carry the weight.
contract ProjectTraitsTest is Test {
    using LibString for string;

    ProjectHook internal hook;
    ProjectTraits internal traits;
    MockStore internal dirStore;
    MockStore internal fileStore;
    MockAbxToken internal token;

    /// @dev The trait template's fixed `"` count, measured against a markup-free name.
    uint256 internal templateQuotes;

    address internal alice = address(0xA11CE);

    bytes32 internal constant KEY_CID = "abxfs.cid";
    bytes32 internal constant KEY_NAME = "abxfs.name";
    bytes32 internal constant KEY_GATEWAY = "abxfs.gateway";
    bytes32 internal constant FIELD = "attributes";

    bytes32 internal constant DIR_A = keccak256("dir-a");
    bytes32 internal constant DIR_B = keccak256("dir-b");
    bytes32 internal constant FILE_A = keccak256("file-a");
    uint256 internal constant TOKEN = 7;
    uint256 internal constant COLLECTION_SENTINEL = type(uint256).max;

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        traits = new ProjectTraits(address(hook));
        token = new MockAbxToken(address(hook));

        dirStore.add(DIR_A);
        dirStore.add(DIR_B);
        fileStore.add(FILE_A);
        token.setOwner(TOKEN, alice);

        MockAbxToken clean = new MockAbxToken(address(hook));
        clean.forceData(TOKEN, KEY_NAME, "clean");
        (, bytes memory baseline) = traits.render(address(clean), TOKEN, FIELD);
        templateQuotes = _countQuotes(baseline);
    }

    function _countQuotes(bytes memory data) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == '"') ++n;
        }
    }

    function _render(address tokenAddr, uint256 tokenId) internal view returns (string memory) {
        (string memory contentType, bytes memory data) = traits.render(tokenAddr, tokenId, FIELD);
        assertEq(contentType, "application/json", "content type is part of the renderer contract");
        return string(data);
    }

    // ─── Must never revert ────────────────────────────────────────────────────

    function test_UnpublishedToken() public view {
        string memory json = _render(address(token), TOKEN);
        assertTrue(json.contains('"value":"Unpublished"'));
        assertTrue(json.contains('"value":"None"'), "root kind is None before the first publish");
        assertTrue(json.contains('"value":0'), "zero versions");
    }

    /// @dev Invariant #1 names this case: `contractURI` renders with `tokenId == type(uint256).max`.
    ///      An empty array is the right answer, and it must be well-formed JSON.
    function test_CollectionSentinelReturnsEmptyArray() public view {
        assertEq(_render(address(token), COLLECTION_SENTINEL), "[]");
    }

    function test_TokenThatRevertsOnEveryRead() public {
        RevertingAbxToken hostile = new RevertingAbxToken();
        string memory json = _render(address(hostile), TOKEN);
        assertTrue(json.startsWith("["));
        assertTrue(json.endsWith("]"));
        assertTrue(json.contains("Unpublished"));
    }

    /// @dev A staticcall to a no-code address succeeds with empty returndata — the case `try/catch`
    ///      cannot handle, and the reason every read here is hand-decoded.
    function test_NonContractToken() public view {
        string memory json = _render(address(0xDEAD), TOKEN);
        assertTrue(json.startsWith("["));
        assertTrue(json.endsWith("]"));
    }

    /// @dev A hook that is not the contract we expect must not be guessed at.
    function test_UnknownHookReportsUnknownKind() public {
        ProjectTraits stray = new ProjectTraits(address(0xBEEF));
        (, bytes memory data) = stray.render(address(token), TOKEN, FIELD);
        assertTrue(string(data).contains('"value":"Unknown"'));
    }

    // ─── Content ──────────────────────────────────────────────────────────────

    function test_PublishedDirectoryProject() public {
        vm.startPrank(alice);
        token.configure(TOKEN, KEY_CID, DIR_A);
        token.configure(TOKEN, KEY_CID, DIR_B);
        token.configureData(TOKEN, KEY_NAME, "my-cool-art");
        vm.stopPrank();

        string memory json = _render(address(token), TOKEN);
        assertTrue(json.contains('"value":"Published"'));
        assertTrue(json.contains('"value":"Directory"'));
        assertTrue(json.contains('"value":2'), "two versions published");
        assertTrue(json.contains('"trait_type":"Named","value":"Yes"'));
        assertTrue(json.contains('"trait_type":"Preferred IPFS Gateway","value":"None"'));
    }

    function test_PublishedFileProject() public {
        vm.prank(alice);
        token.configure(TOKEN, KEY_CID, FILE_A);
        assertTrue(_render(address(token), TOKEN).contains('"value":"File"'));
    }

    function test_GatewayPresenceIsReported() public {
        vm.startPrank(alice);
        token.configure(TOKEN, KEY_CID, DIR_A);
        token.configureData(TOKEN, KEY_GATEWAY, "https://ipfs.io");
        vm.stopPrank();
        assertTrue(
            _render(address(token), TOKEN).contains('"trait_type":"Preferred IPFS Gateway","value":"Set"')
        );
    }

    /// @dev Versions uses `display_type: number` so a marketplace sorts numerically. Without it, v10
    ///      sorts before v2.
    function test_VersionsIsANumericTrait() public {
        vm.prank(alice);
        token.configure(TOKEN, KEY_CID, DIR_A);
        assertTrue(
            _render(address(token), TOKEN).contains(
                '{"trait_type":"Versions","display_type":"number","value":1}'
            )
        );
    }

    /// @dev A `abxfs.cid` declared as `String`/`Bytes` would put a keccak commitment in the bytes32.
    ///      Reporting that project as Published on the strength of a hash would be a lie.
    function test_HashValuedCidCountsAsUnpublished() public {
        token.forceParam(TOKEN, KEY_CID, keccak256("commitment"), true);
        assertTrue(_render(address(token), TOKEN).contains('"value":"Unpublished"'));
    }

    // ─── Field guard ──────────────────────────────────────────────────────────

    function test_UnsupportedFieldReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ProjectTraits.UnsupportedField.selector, bytes32("image"))
        );
        traits.render(address(token), TOKEN, "image");
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_NeverRevertsForAnyTokenId(uint256 tokenId) public view {
        traits.render(address(token), tokenId, FIELD);
    }

    function testFuzz_NeverRevertsForAnyCid(bytes32 cid) public {
        token.forceParam(TOKEN, KEY_CID, cid, false);
        traits.render(address(token), TOKEN, FIELD);
    }

    /// @dev Owner-controlled bytes must not be able to reach the JSON. No trait carries free text —
    ///      only constants and a decimal — so an arbitrary name can never break the document.
    function testFuzz_OwnerTextNeverReachesTheJson(bytes calldata name) public {
        vm.assume(name.length <= 512);
        token.forceData(TOKEN, KEY_NAME, name);
        (, bytes memory data) = traits.render(address(token), TOKEN, FIELD);

        string memory json = string(data);
        assertTrue(json.startsWith("["));
        assertTrue(json.endsWith("]"));
        // The template's quote count is fixed, so any excess means payload leaked through. Measured
        // against a markup-free baseline rather than hardcoded — a literal here is a number that has
        // to be recounted by hand every time a trait is added, and gets it wrong.
        assertEq(
            _countQuotes(data),
            templateQuotes,
            "trait JSON must have a fixed quote count regardless of stored text"
        );
    }
}
