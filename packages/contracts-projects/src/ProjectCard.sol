// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "./interfaces/IAbxFieldRenderer.sol";
import {IAbxParams} from "./interfaces/IAbxParams.sol";
import {IProjectHook} from "./interfaces/IProjectHook.sol";

/// @title ProjectCard
/// @notice The `image` field for an ABX FS project token: a card computed entirely on-chain from the
///         project's own state (its name, its current root CID and how many versions it has
///         published) under its org's name, with the token's id. The token's `animation_url` points at
///         the live project; this is the still that marketplaces and wallets display beside it.
///
///         It needs no render service and no hosted file: the card is computed from chain state on
///         every `tokenURI` read.
///
/// @dev    THE BINDING CONSTRAINT IS {IAbxFieldRenderer} INVARIANT 1: the ABX metadata renderer `staticcall`s this
///         with no try/catch, so a revert here bricks the entire `tokenURI` — not just the image.
///         Every external read below is wrapped, every loop is bounded, and every unset value has a
///         defined fallback. `render` has exactly one revert path (`UnsupportedField`), which can
///         only fire on a deploy-time miswiring to a field this contract does not compute.
///
///         The reads have no gas or returndata cap (unlike `OrgMeta`'s): a token that burns all the gas it is
///         given would starve the render. That is outside the model, because the only token ABX ever passes is
///         the org itself, and the hook is this factory's own.
contract ProjectCard is IAbxFieldRenderer {
    using LibString for uint256;

    /// @dev Wiring this renderer to a field it does not compute is a deploy-time mistake. Failing
    ///      loudly on that is {IAbxFieldRenderer} invariant 3; it is not a runtime path.
    error UnsupportedField(bytes32 field);

    string internal constant _CONTENT_TYPE = "image/svg+xml";
    bytes32 internal constant _FIELD_IMAGE = "image";

    bytes32 internal constant _KEY_CID = "abxfs.cid";
    bytes32 internal constant _KEY_NAME = "abxfs.name";

    uint256 internal constant _COLLECTION_SENTINEL = type(uint256).max;
    /// @dev Display cap, in characters, for the project's name and the org's.
    uint256 internal constant _MAX_NAME_CHARS = 28;
    /// @dev The hook's cap on `abxfs.name`, and the longest name `OrgMeta` shows as a token's `name`.
    uint256 internal constant _MAX_PROJECT_NAME = 128;

    string internal constant _FONT = '" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="';

    IProjectHook public immutable hook;

    constructor(address hook_) {
        hook = IProjectHook(hook_);
    }

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != _FIELD_IMAGE) revert UnsupportedField(field);

        // The collection surface (`contractURI`) has no token behind it. Return the generic card.
        if (tokenId == _COLLECTION_SENTINEL) {
            return (_CONTENT_TYPE, bytes(_svg(_orgName(token), "", "ABX FS", bytes32(0), 0)));
        }

        // The id is shown because a name proves nothing about which token this is: a project may name itself
        // after a sibling ("Acme #0" on token 3).
        return (
            _CONTENT_TYPE,
            bytes(
                _svg(
                    _orgName(token),
                    string.concat("#", tokenId.toString()),
                    _name(token, tokenId),
                    _cid(token, tokenId),
                    _versionCount(token, tokenId)
                )
            )
        );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Reads — every one of these must tolerate an unset value or a hostile callee
    // ──────────────────────────────────────────────────────────────────────────
    //
    // These use raw `staticcall` and hand-decode the result rather than `try/catch` on a typed
    // call, because `try/catch` is NOT sufficient for the never-revert invariant:
    //
    //   • A `staticcall` to an address with **no code** SUCCEEDS and returns zero bytes. The typed
    //     call then fails to decode its return values, and a return-data decoding failure reverts
    //     in the *calling* context — `catch` is never entered. A `token` or `hook` address with no
    //     code would otherwise brick every `tokenURI` in the collection.
    //   • Solidity's `bool` decoder rejects any word outside {0, 1}, so a collection returning a
    //     malformed word reverts inside the decoder for the same uncatchable reason.
    //
    // Decoding by hand removes both: a short or malformed return is treated as "unset", and any
    // nonzero flag word is read as true. No input reaches a revert.

    /// @dev `abxfs.cid` is a scalar param, so the value lives in the `bytes32` itself and
    ///      `valueIsHash` is false. A true `valueIsHash` means the key was declared as
    ///      `String`/`Bytes`, making the bytes32 a keccak commitment rather than a CID — treat that
    ///      as unset instead of displaying a hash as though it were content.
    function _cid(address token, uint256 tokenId) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IAbxParams.tokenParam.selector, tokenId, _KEY_CID)
        );
        // (bytes32 value, bool valueIsHash, bool isSet) — three words.
        if (!ok || ret.length < 96) return bytes32(0);

        bytes32 value;
        uint256 valueIsHash;
        uint256 isSet;
        assembly {
            value := mload(add(ret, 0x20))
            valueIsHash := mload(add(ret, 0x40))
            isSet := mload(add(ret, 0x60))
        }
        if (isSet == 0 || valueIsHash != 0) return bytes32(0);
        return value;
    }

    /// @dev The project's `abxfs.name`, under the rule `OrgMeta` applies to the token's `name`: 1..128 bytes of
    ///      printable ASCII, not only spaces and not `-` (the SDK's "cleared" marker). Anything else (unset,
    ///      malformed, longer, any byte outside printable ASCII) reads as "untitled", whole: a name with bytes
    ///      dropped is not one anybody wrote, and the card and the token's `name` must agree on whether there is
    ///      one. Shown up to {_MAX_NAME_CHARS} characters.
    function _name(address token, uint256 tokenId) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IAbxParams.tokenParamData.selector, tokenId, _KEY_NAME)
        );
        if (ok) {
            (bytes memory raw, uint256 declared) = _decodeBytes(ret, _MAX_PROJECT_NAME);
            if (declared == raw.length && _isName(raw)) return _show(raw, raw.length > _MAX_NAME_CHARS);
        }
        return "untitled";
    }

    /// @dev The collection's own ERC-721 `name()`. For an org it is frozen at creation, so the header
    ///      cannot be changed to impersonate another org after the fact. Falls back to "ABX FS" for
    ///      anything that does not answer with a canonical non-empty string. Of the first
    ///      {_MAX_NAME_CHARS} bytes, only printable ASCII is kept (an org's name is nothing else), so a
    ///      string with none reads as "untitled".
    function _orgName(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("name()"));
        if (!ok) return "ABX FS";
        (bytes memory raw, uint256 declared) = _decodeBytes(ret, _MAX_NAME_CHARS);
        if (declared == 0) return "ABX FS";
        uint256 n;
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            if (c >= 0x20 && c <= 0x7e) raw[n++] = c;
        }
        if (n == 0) return "untitled";
        assembly ("memory-safe") {
            mstore(raw, n)
        }
        return _show(raw, declared > _MAX_NAME_CHARS);
    }

    function _versionCount(address token, uint256 tokenId) internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(hook).staticcall(
            abi.encodeWithSelector(IProjectHook.versionCount.selector, token, tokenId)
        );
        if (!ok || ret.length < 32) return 0;

        uint256 count;
        assembly {
            count := mload(add(ret, 0x20))
        }
        return count;
    }

    /// @dev Decode an ABI-encoded `bytes`/`string` return value: its declared length, and its first `cap` bytes
    ///      at most, in place in `ret` (no copy). Anything non-canonical (a head that is too short, an offset other
    ///      than 0x20, or a declared length running past the buffer) is empty with a declared length of zero.
    ///      `ret`'s payload begins at index 0, so the offset word is `ret[0..31]`, the length word `ret[32..63]`,
    ///      and data at `ret[64]`.
    function _decodeBytes(bytes memory ret, uint256 cap) internal pure returns (bytes memory out, uint256 declared) {
        if (ret.length < 64) return ("", 0);

        uint256 offset;
        assembly {
            offset := mload(add(ret, 0x20))
            declared := mload(add(ret, 0x40))
        }
        if (offset != 0x20 || declared > ret.length - 64) return ("", 0);

        uint256 n = declared > cap ? cap : declared;
        assembly ("memory-safe") {
            out := add(ret, 0x40)
            mstore(out, n)
        }
    }

    /// @dev Non-empty, every byte printable ASCII (0x20..0x7e), not only spaces, and not exactly `-`.
    function _isName(bytes memory b) internal pure returns (bool visible) {
        if (b.length == 1 && b[0] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7e) return false;
            if (c != 0x20) visible = true;
        }
    }

    /// @dev Printable ASCII `raw`, at most {_MAX_NAME_CHARS} characters of it, escaped for the SVG text it lands in,
    ///      with an ellipsis if `cut`. Solady's `escapeHTML` turns each of `&` `<` `>` `"` `'` into an XML entity
    ///      (`&amp;` `&lt;` `&gt;` `&quot;` `&#39;`) and passes every other byte through, so the result can neither
    ///      open markup nor leave a quoted attribute, and holds no byte XML forbids. Bounded: 28 characters, each at
    ///      most six bytes.
    function _show(bytes memory raw, bool cut) internal pure returns (string memory s) {
        if (raw.length > _MAX_NAME_CHARS) {
            uint256 m = _MAX_NAME_CHARS;
            assembly ("memory-safe") {
                mstore(raw, m)
            }
        }
        s = LibString.escapeHTML(string(raw));
        if (cut) s = string.concat(s, unicode"…");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The card
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev `id` is empty at the collection surface, which has no token.
    function _svg(string memory org, string memory id, string memory name, bytes32 cid, uint256 versions)
        internal
        pure
        returns (string memory)
    {
        bool published = cid != bytes32(0);
        string memory line = published
            ? string.concat("v", versions.toString(), "  ", _shortCid(cid))
            : "not yet published";
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
            _background(cid, published),
            _glyph(cid, published),
            _text(org, id, name, line),
            "</svg>"
        );
    }

    /// @dev Two hues seeded from the CID give each project a stable identity at a glance. An unpublished project
    ///      has a zero CID and lands on a neutral slate, which reads as "nothing here yet" rather than as a real
    ///      colorway.
    function _background(bytes32 cid, bool published) internal pure returns (string memory) {
        uint256 hueA = published ? (uint256(uint8(cid[0])) * 360) / 256 : 210;
        uint256 hueB = published ? (hueA + 40 + (uint256(uint8(cid[1])) % 120)) % 360 : 210;
        string memory sat = published ? "68" : "12";
        return string.concat(
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(',
            hueA.toString(),
            ",",
            sat,
            '%,52%)"/><stop offset="1" stop-color="hsl(',
            hueB.toString(),
            ",",
            sat,
            '%,34%)"/></linearGradient></defs>',
            '<rect width="400" height="400" fill="#0b0d12"/>',
            '<rect x="24" y="24" width="352" height="352" rx="18" fill="url(#g)" fill-opacity="0.18" stroke="url(#g)" stroke-width="1.5"/>'
        );
    }

    /// @dev A 4x4 lattice keyed off the CID — the same bytes the gateway resolves, made visible.
    ///      At most 16 cells, so the output size is bounded.
    function _glyph(bytes32 cid, bool published) internal pure returns (string memory) {
        if (!published) {
            return
            '<g opacity="0.28"><rect x="168" y="150" width="64" height="64" rx="6" fill="none" stroke="#8b97ad" stroke-width="1.5" stroke-dasharray="4 4"/></g>';
        }

        string memory cells;
        for (uint256 i = 0; i < 16;) {
            uint8 b = uint8(cid[i]);
            // Skip roughly a third of the cells so the lattice reads as a pattern, not a block.
            if (b % 3 != 0) {
                uint256 x = 132 + (i % 4) * 34;
                uint256 y = 112 + (i / 4) * 34;
                cells = string.concat(
                    cells,
                    '<rect x="',
                    x.toString(),
                    '" y="',
                    y.toString(),
                    '" width="26" height="26" rx="4" fill="#e8edf7" fill-opacity="0.',
                    (30 + (uint256(b) % 60)).toString(),
                    '"/>'
                );
            }
            unchecked {
                ++i;
            }
        }
        return string.concat("<g>", cells, "</g>");
    }

    /// @dev The org's name at the top; the token's id, its name and its version line at the bottom.
    function _text(string memory org, string memory id, string memory name, string memory line)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<text x="48" y="72" fill="#8b97ad',
            _FONT,
            '13" letter-spacing="3">',
            org,
            "</text>",
            bytes(id).length == 0
                ? ""
                : string.concat('<text x="48" y="284" fill="#8b97ad', _FONT, '13" letter-spacing="2">', id, "</text>"),
            '<text x="48" y="316" fill="#f2f5fa',
            _FONT,
            '19">',
            name,
            "</text>",
            '<text x="48" y="342" fill="#8b97ad',
            _FONT,
            '12">',
            line,
            "</text>"
        );
    }

    /// @dev `0xabcdef…1234` — enough to eyeball against a gateway URL without dominating the card.
    function _shortCid(bytes32 cid) internal pure returns (string memory) {
        return string.concat("0x", _hexSlice(cid, 0, 3), unicode"…", _hexSlice(cid, 30, 2));
    }

    function _hexSlice(bytes32 v, uint256 startByte, uint256 nBytes)
        internal
        pure
        returns (string memory)
    {
        bytes memory out = new bytes(nBytes * 2);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < nBytes;) {
            uint8 b = uint8(v[startByte + i]);
            out[i * 2] = digits[b >> 4];
            out[i * 2 + 1] = digits[b & 0x0f];
            unchecked {
                ++i;
            }
        }
        return string(out);
    }
}
