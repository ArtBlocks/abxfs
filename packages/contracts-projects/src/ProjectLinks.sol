// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "./interfaces/IAbxFieldRenderer.sol";
import {IAbxParams} from "./interfaces/IAbxParams.sol";

/// @title ProjectLinks
/// @notice The two link fields of a project token's metadata, which marketplaces show:
///
///         - `animation_url` — the live project. Marketplaces that embed an animation render it in the
///           token's page.
///         - `external_url`  — the "view on website" link.
///
///         They return `text/uri-list`, which ABX's metadata renderer treats as "this payload is a
///         URL": it lands verbatim rather than being wrapped in a `data:` URI no marketplace would
///         dereference.
///
///         **The project's owner chooses where they point.** If the token's `abxfs.view` param holds a
///         usable URL, BOTH fields are exactly that URL, with nothing appended: no path shape is
///         assumed, so it can be a bespoke gateway, a project's own domain, a single-project host or
///         anything else. Only when it is unset or unusable do the fields fall back to the default:
///         a path on `gatewayBase`. The collection surface has no project behind it, and links to
///         `gatewayBase` itself.
///
/// @dev    THE BINDING CONSTRAINT IS THE SAME AS THE CARD'S: ABX `staticcall`s this with no try/catch,
///         so a revert here bricks the whole `tokenURI`. Reading the param is therefore a raw
///         `staticcall` with a hand-decoded result: a typed call to a no-code address succeeds with
///         empty returndata and then reverts decoding it, uncatchably. Anything short, malformed,
///         oversized or unusable reads as "unset". The call has no gas or returndata cap (unlike
///         `OrgMeta`'s reads): the only callee ABX ever passes is the org itself. The value is accepted
///         only up to a fixed cap and checked in place, one pass, with no copy.
///
///         A usable value is `https://` followed by visible ASCII, at most 512 bytes, with none of
///         `"` `&` `'` `<` `>` `\` `` ` `` (they could end the JSON string the value is placed in, close a
///         quoted HTML attribute, start an entity or open markup), `{` `}` `|` `^` (RFC 3986 does not allow
///         them in a URI at all, `{`/`}` delimit CSS blocks and `|` Markdown tables) or `(` `)` `[` `]`
///         (they end a Markdown link or an unquoted CSS `url()`). The token owner writes this param, so it
///         is attacker-controlled input flowing into a URL a marketplace will dereference or embed, in
///         contexts this contract cannot see and can never be changed to follow. `https` only (never
///         `javascript:` or `data:`). Every refused character can still be written percent-encoded, which
///         is why `%` stays: a `%xx` means nothing to JSON, HTML, CSS or Markdown. The at sign stays too:
///         it is special to none of them, and a URL with a user part leads where its owner could link anyway.
///
///         The default base is fixed at deployment and cannot change: this contract is frozen into
///         every org the factory makes. It is a fallback, so an owner who does not want to depend on
///         it sets `abxfs.view`. It must be a domain ABX FS controls for as long as any org's tokens
///         exist; what is served at the default paths is off-chain configuration (a redirect into a
///         per-project host, for example) and changes no token.
contract ProjectLinks is IAbxFieldRenderer {
    using LibString for uint256;

    string internal constant _CONTENT_TYPE = "text/uri-list";
    bytes32 internal constant _FIELD_ANIMATION_URL = "animation_url";
    bytes32 internal constant _FIELD_EXTERNAL_URL = "external_url";
    bytes32 internal constant _KEY_VIEW = "abxfs.view";
    uint256 internal constant _COLLECTION_SENTINEL = type(uint256).max;
    /// @dev Bit `c` is set for every byte `c` a usable view may not contain: every control byte and the space
    ///      (0x00..0x20), DEL and every non-ASCII byte (0x7f..0xff), and the characters listed in the contract notes.
    uint256 internal constant _REFUSED = ((1 << 0x21) - 1) | (type(uint256).max << 0x7f) | (1 << 0x22) | (1 << 0x26)
        | (1 << 0x27) | (1 << 0x28) | (1 << 0x29) | (1 << 0x3c) | (1 << 0x3e) | (1 << 0x5b) | (1 << 0x5c) | (1 << 0x5d)
        | (1 << 0x5e) | (1 << 0x60) | (1 << 0x7b) | (1 << 0x7c) | (1 << 0x7d);
    /// @dev Matches the hook's `MAX_VIEW_BYTES`. Anything longer is not accepted, and reads as unset.
    uint256 internal constant _MAX_VIEW_BYTES = 512;

    /// @notice e.g. `https://fs.abx.io`, with no trailing slash.
    string public gatewayBase;

    constructor(string memory gatewayBase_) {
        gatewayBase = gatewayBase_;
    }

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        // The collection surface has no project behind it; the site itself is the honest answer for both
        // fields. (The org's own page is reachable by direct link only, and is linked from nowhere.)
        if (tokenId == _COLLECTION_SENTINEL) return (_CONTENT_TYPE, bytes(gatewayBase));

        if (field != _FIELD_ANIMATION_URL && field != _FIELD_EXTERNAL_URL) return (_CONTENT_TYPE, "");

        data = _view(token, tokenId);
        if (data.length != 0) return (_CONTENT_TYPE, data);

        string memory chain = block.chainid.toString();
        string memory org = LibString.toHexString(token);
        string memory id = tokenId.toString();
        if (field == _FIELD_ANIMATION_URL) {
            return (_CONTENT_TYPE, bytes(string.concat(gatewayBase, "/g/p/", chain, "/", org, "/", id, "/latest/")));
        }
        return (_CONTENT_TYPE, bytes(string.concat(gatewayBase, "/projects/", chain, "/", org, "/", id)));
    }

    /// @dev The token's `abxfs.view`, or empty when it is unset, malformed or not a usable URL. A usable value is
    ///      returned in place: `ret` already holds it as a length word followed by the bytes.
    function _view(address token, uint256 tokenId) internal view returns (bytes memory out) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IAbxParams.tokenParamData.selector, tokenId, _KEY_VIEW)
        );
        if (!ok || ret.length < 64) return "";

        uint256 offset;
        uint256 declared;
        assembly ("memory-safe") {
            offset := mload(add(ret, 0x20))
            declared := mload(add(ret, 0x40))
        }
        // Canonical ABI `bytes` only, no longer than the cap (a longer value is refused rather than truncated,
        // because a truncated URL points somewhere the owner never chose), and "https://" plus at least one byte.
        if (offset != 0x20 || declared > ret.length - 64 || declared > _MAX_VIEW_BYTES || declared < 9) return "";

        // One refused byte refuses the whole value.
        uint256 refused = _REFUSED;
        uint256 bad;
        assembly ("memory-safe") {
            let p := add(ret, 0x60)
            for { let end := add(p, declared) } lt(p, end) { p := add(p, 1) } {
                bad := or(bad, and(shr(byte(0, mload(p)), refused), 1))
            }
            out := add(ret, 0x40)
        }
        // Compared case-sensitively: `HTTPS://` or any other casing is refused.
        if (bad != 0 || bytes8(out) != "https://") return "";
    }
}
