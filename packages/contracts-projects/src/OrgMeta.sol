// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "./interfaces/IAbxFieldRenderer.sol";
import {IAbxParams} from "./interfaces/IAbxParams.sol";
import {ProjectLinks} from "./ProjectLinks.sol";

/// @title OrgMeta
/// @notice What an org looks like on a marketplace. Two surfaces, both computed on chain from the org's own
///         state (its frozen name and description, and each project's `abxfs.name`), so nobody needs to own
///         the collection to keep them right:
///
///         - `contractURI(token)` — the org's ERC-7572 collection document (what marketplaces read for
///           the collection page): its name, its description, a logo (a monogram of the name), a banner,
///           and a link to the ABX FS site. An org renounces ABX
///           ownership at creation, so this document is the ONLY way its collection page is ever
///           filled in. ABX's own renderer emits `name` alone at this surface.
///         - `render(token, tokenId, "name")` — every token's `name`: the project's own `abxfs.name`
///           when usable (1..128 bytes of printable ASCII, not only spaces, not `-`), else
///           `"<org name> #<id>"`; at the collection surface, the org's name.
///
/// @dev    THE BINDING CONSTRAINT IS THE SAME AS THE CARD'S: ABX `staticcall`s `render` with no
///         try/catch, so a revert there bricks the whole `tokenURI`, and `contractURI()` on the org is
///         a direct call into this contract. So NOTHING here reverts, for any `token`:
///
///         - every external read is a raw `staticcall` with a gas cap and a returndata cap ({_call}),
///           decoded by hand ({_slice}). A no-code address, a revert, short or malformed returndata, and
///           a callee that burns its gas all read as "unset"; an oversized value is truncated (the org
///           name) or read as unset (everything else); and unset has a defined fallback;
///         - every string copied in is capped and is either filtered (the org name) or checked whole (the
///           description and a project's name) to printable ASCII, newlines allowed in the description;
///           every string this contract assembles is escaped for where it lands (JSON, or XML inside the
///           logo and banner), and ABX escapes the `name` that `render` returns.
///
///         No mutable state: no owner, no setter. `gatewayBase` and `links` are written once, in the
///         constructor. Deployed separately from the factory (CREATE2, fixed salt), because the factory's
///         initcode would not fit EIP-3860's limit with it; it is a constructor argument of the factory and
///         frozen into every org the factory makes.
contract OrgMeta is IAbxFieldRenderer {
    using LibString for uint256;

    string internal constant _TEXT = "text/plain";
    /// @dev The gradient shared by the logo and the banner: the unpublished card's neutral palette.
    string internal constant _DEFS =
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(210,12%,52%)"/><stop offset="1" stop-color="hsl(210,12%,34%)"/></linearGradient></defs>';
    /// @dev The card's monospace face, centred.
    string internal constant _FONT = '" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="middle"';

    bytes32 internal constant _FIELD_NAME = "name";
    bytes32 internal constant _FIELD_DESCRIPTION = "description";
    bytes32 internal constant _INLINE = "inline";
    bytes32 internal constant _KEY_NAME = "abxfs.name";
    uint256 internal constant _SENTINEL = type(uint256).max;

    /// @dev `contractField(bytes32)` on ABX's On-Chain Metadata extension: `(bytes32 representation, bytes value)`.
    bytes4 internal constant _CONTRACT_FIELD = bytes4(keccak256("contractField(bytes32)"));

    /// @dev The factory's caps (org name, description) and the hook's (`abxfs.name`). A longer value from anywhere is not from an org, and is truncated (the org
    ///      name, which only labels) or refused (the description and project name, which would otherwise
    ///      say something nobody wrote).
    uint256 internal constant _MAX_ORG_NAME = 64;
    uint256 internal constant _MAX_PROJECT_NAME = 128;
    uint256 internal constant _MAX_DESCRIPTION = 1000;
    /// @dev Gas cap per read, more than ten times what the largest cost against a real org when measured (a
    ///      1000-byte description, ~80k), so a repricing of storage reads does not reach it. It exists only
    ///      so a hostile callee cannot leave this contract too little gas to finish. A cap that is hit falls
    ///      back; it never reverts.
    uint256 internal constant _READ_GAS = 1_000_000;

    /// @notice e.g. `https://fs.abx.io`, with no trailing slash. The collection's `external_link`.
    string public gatewayBase;

    /// @notice The `animation_url` / `external_url` renderer, deployed by this constructor with the same
    ///         `gatewayBase`. The factory reads it from here and wires it into every org it makes.
    ProjectLinks public immutable links;

    constructor(string memory gatewayBase_) {
        gatewayBase = gatewayBase_;
        links = new ProjectLinks(gatewayBase_);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The collection document
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice The org's ERC-7572 collection document, as `data:application/json;base64,…` (the same form
    ///         ABX's renderer returns). Called by the org's own `contractURI()`. Never reverts.
    function contractURI(address token) external view returns (string memory) {
        string memory name = _orgName(token);
        string memory json = string.concat(
            '{"name":"',
            LibString.escapeJSON(name),
            '","description":"',
            LibString.escapeJSON(_description(token, name)),
            '"'
        );
        json = string.concat(
            json,
            ',"image":"',
            _svgUri(_logo(name)),
            '","banner_image":"',
            _svgUri(_banner(name)),
            '","external_link":"',
            LibString.escapeJSON(gatewayBase),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev The org's `description` contract field when it is `inline` and well formed (what the factory
    ///      accepts: printable ASCII and newlines, 1..1000 bytes, not only whitespace), else a plain
    ///      standard text.
    function _description(address token, string memory name) internal view returns (string memory) {
        (bool ok, bytes memory ret) =
            _call(token, abi.encodeWithSelector(_CONTRACT_FIELD, _FIELD_DESCRIPTION), _READ_GAS, 96 + _MAX_DESCRIPTION);
        if (ok && _word(ret, 0) == _INLINE) {
            (bytes memory d, bool whole) = _slice(ret, 1, _MAX_DESCRIPTION);
            if (whole && _printable(d, true)) return string(d);
        }
        return string.concat(
            name,
            " is an org on ABX FS. Each token in it is a project: a website or set of files."
        );
    }

    /// @dev A 400x400 logo built for a marketplace's small circular crop: a monogram, the first visible
    ///      character of the name's first two words (uppercased), centred, with a small "ABX FS" under it
    ///      inside the inscribed circle and nothing that matters near a corner. `name` always has a visible
    ///      character ({_orgName}), so the monogram is never empty. Drawn here from the name rather than read
    ///      from the card: the card's collection surface says "not yet published", and drawing it costs no
    ///      external read.
    function _logo(string memory name) internal pure returns (bytes memory) {
        bytes memory b = bytes(name);
        bytes memory m = new bytes(2);
        uint256 n;
        for (uint256 i; i < b.length && n < 2; ++i) {
            if (b[i] != " " && (i == 0 || b[i - 1] == " ")) m[n++] = b[i];
        }
        assembly {
            mstore(m, n)
        }
        string memory mono = LibString.escapeHTML(LibString.upper(string(m)));
        return bytes(
            string.concat(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
                _DEFS,
                '<rect width="400" height="400" fill="#0b0d12"/>',
                '<circle cx="200" cy="200" r="168" fill="url(#g)" fill-opacity="0.18" stroke="url(#g)" stroke-width="2"/>',
                '<text x="200" y="240" fill="#f2f5fa" font-size="',
                n > 1 ? "132" : "160",
                _FONT,
                ">",
                mono,
                '</text><text x="200" y="300" fill="#8b97ad" font-size="16" letter-spacing="5',
                _FONT,
                ">ABX FS</text></svg>"
            )
        );
    }

    /// @dev A 1400x350 banner in the card's palette: the org name, centred so any crop keeps it. Sized so
    ///      the longest name (64 monospace characters) still fits. `name` is printable ASCII already
    ///      ({_orgName}); only the five XML metacharacters need escaping.
    function _banner(string memory name) internal pure returns (bytes memory) {
        // A monospace glyph advances about 0.67em, so 64 characters at 1900/64 = 29px span ~1240px.
        uint256 size = 1900 / bytes(name).length;
        if (size > 64) size = 64;
        return bytes(
            string.concat(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 350" width="1400" height="350">',
                _DEFS,
                '<rect width="1400" height="350" fill="#0b0d12"/>',
                '<rect x="24" y="24" width="1352" height="302" rx="18" fill="url(#g)" fill-opacity="0.18" stroke="url(#g)" stroke-width="1.5"/>',
                '<text x="700" y="',
                (165 + size / 3).toString(),
                '" fill="#f2f5fa" font-size="',
                size.toString(),
                _FONT,
                ">",
                LibString.escapeHTML(name),
                '</text><text x="700" y="262" fill="#8b97ad" font-size="14" letter-spacing="6',
                _FONT,
                ">ABX FS</text></svg>"
            )
        );
    }

    function _svgUri(bytes memory svg) internal pure returns (string memory) {
        return string.concat("data:image/svg+xml;base64,", Base64.encode(svg));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // A token's name
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IAbxFieldRenderer
    /// @dev Wired to the org's `name` contract field, so ABX calls it for every token (a contract field is
    ///      every token's fallback). ABX JSON-escapes the result; it is printable ASCII regardless. Any other
    ///      field is a miswiring and gets an empty value, never a revert.
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != _FIELD_NAME) return (_TEXT, "");
        if (tokenId != _SENTINEL) {
            data = _projectName(token, tokenId);
            if (data.length != 0) return (_TEXT, data);
            return (_TEXT, bytes(string.concat(_orgName(token), " #", tokenId.toString())));
        }
        return (_TEXT, bytes(_orgName(token)));
    }

    /// @dev The token's `abxfs.name` when it is 1..128 bytes of printable ASCII and not only spaces, else
    ///      empty. `-` is the SDK's "cleared" marker for a string param (ABX refuses an empty value), so it
    ///      reads as unset too. A UTF-8 name is refused whole rather than mangled: the fallback is honest,
    ///      a half-decoded name is not.
    function _projectName(address token, uint256 tokenId) internal view returns (bytes memory) {
        (bool ok, bytes memory ret) = _call(
            token,
            abi.encodeWithSelector(IAbxParams.tokenParamData.selector, tokenId, _KEY_NAME),
            _READ_GAS,
            64 + _MAX_PROJECT_NAME
        );
        if (!ok) return "";
        (bytes memory n, bool whole) = _slice(ret, 0, _MAX_PROJECT_NAME);
        if (!whole || !_printable(n, false) || (n.length == 1 && n[0] == "-")) return "";
        return n;
    }

    /// @dev The collection's ERC-721 `name()`, capped at 64 bytes and filtered to printable ASCII. For an
    ///      org that is the name exactly (the factory accepts nothing else, and it is frozen). Anything that
    ///      leaves nothing visible reads as "Untitled org".
    function _orgName(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = _call(token, abi.encodeWithSignature("name()"), _READ_GAS, 64 + _MAX_ORG_NAME);
        if (ok) {
            (bytes memory raw,) = _slice(ret, 0, _MAX_ORG_NAME);
            uint256 n;
            for (uint256 i; i < raw.length; ++i) {
                bytes1 c = raw[i];
                if (c >= 0x20 && c <= 0x7e) raw[n++] = c;
            }
            assembly {
                mstore(raw, n)
            }
            if (_printable(raw, false)) return string(raw);
        }
        return "Untitled org";
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Reads that cannot revert
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev A `staticcall` with at most `gasCap` gas that copies at most `maxRet` bytes of returndata, so
    ///      neither a gas sink nor a returndata bomb can exhaust this frame. A call to an address with no
    ///      code succeeds with nothing returned, which every decoder below reads as unset.
    function _call(address to, bytes memory data, uint256 gasCap, uint256 maxRet)
        internal
        view
        returns (bool ok, bytes memory ret)
    {
        assembly ("memory-safe") {
            ok := staticcall(gasCap, to, add(data, 0x20), mload(data), 0, 0)
            let n := returndatasize()
            if gt(n, maxRet) { n := maxRet }
            ret := mload(0x40)
            mstore(ret, n)
            returndatacopy(add(ret, 0x20), 0, n)
            mstore(0x40, add(add(ret, 0x40), and(add(n, 0x1f), not(0x1f))))
        }
    }

    /// @dev Word `i` of `ret`, or zero if `ret` is too short to hold it.
    function _word(bytes memory ret, uint256 i) internal pure returns (bytes32 w) {
        if (ret.length < (i + 1) * 32) return bytes32(0);
        assembly {
            w := mload(add(add(ret, 0x20), mul(i, 0x20)))
        }
    }

    /// @dev The dynamic `bytes`/`string` whose offset is head word `i`, copying at most `cap` bytes.
    ///      `whole` is true only if the value is no longer than `cap` and lies entirely inside `ret`; a
    ///      longer value yields its first `cap` bytes with `whole` false, and anything malformed (offset
    ///      or length out of range) yields nothing.
    function _slice(bytes memory ret, uint256 i, uint256 cap) internal pure returns (bytes memory out, bool whole) {
        uint256 len = ret.length;
        uint256 offset = uint256(_word(ret, i));
        if (len < (i + 1) * 32 || offset > len || len - offset < 32) return ("", false);
        uint256 declared;
        assembly {
            declared := mload(add(add(ret, 0x20), offset))
        }
        uint256 n = declared > cap ? cap : declared;
        if (len - offset - 32 < n) return ("", false);
        assembly ("memory-safe") {
            out := mload(0x40)
            mstore(out, n)
            mcopy(add(out, 0x20), add(add(ret, 0x40), offset), n)
            mstore(add(add(out, 0x20), n), 0)
            mstore(0x40, add(add(out, 0x40), and(add(n, 0x1f), not(0x1f))))
        }
        whole = n == declared;
    }

    /// @dev Non-empty, every byte printable ASCII (or `\n` when `newline`), and not only whitespace.
    function _printable(bytes memory b, bool newline) internal pure returns (bool) {
        bool visible;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c == 0x0a && newline) continue;
            if (c < 0x20 || c > 0x7e) return false;
            if (c != 0x20) visible = true;
        }
        return visible;
    }
}
