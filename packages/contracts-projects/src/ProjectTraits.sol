// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "./interfaces/IAbxFieldRenderer.sol";
import {IAbxParams} from "./interfaces/IAbxParams.sol";
import {IProjectHook} from "./interfaces/IProjectHook.sol";

/// @title ProjectTraits
/// @notice The `attributes` field for an ABX FS project token, computed on-chain.
///
///         An org's renderers are set and locked at creation, so this field is fixed for the life of
///         the org.
///
///         The traits are deliberately facts a collector can verify against chain state rather than
///         decorative rarity: whether the project has published, whether its root is a directory or
///         a single file, how many versions it has, whether it has a name the token's `name` shows, and
///         whether its preferred IPFS gateway is set. Status, Root Kind and Versions are read from the
///         same places a gateway reads, so metadata cannot disagree with resolution.
///
/// @dev    Same binding constraint as `ProjectCard`: the ABX metadata renderer `staticcall`s
///         this with NO try/catch, so a revert bricks the entire `tokenURI` rather than degrading one
///         field. Every external read is therefore a raw `staticcall` with hand-decoding —
///         `try/catch` is NOT sufficient, because a staticcall to a no-code address succeeds with
///         empty returndata and the resulting decode failure is uncatchable, as is Solidity's `bool`
///         decoder rejecting a word outside {0,1}.
///
///         The decode helpers are duplicated from `ProjectCard` rather than shared, so each renderer
///         can be read and verified on its own.
///
///         The reads have no gas or returndata cap (unlike `OrgMeta`'s): a token that burns all the gas it is
///         given would starve the render. That is outside the model, because the only token ABX ever passes is
///         the org itself, and the hook is this factory's own.
contract ProjectTraits is IAbxFieldRenderer {
    using LibString for uint256;

    /// @dev Wiring this to a field it does not compute is a deploy-time mistake, not a runtime path.
    error UnsupportedField(bytes32 field);

    string internal constant _CONTENT_TYPE = "application/json";
    bytes32 internal constant _FIELD_ATTRIBUTES = "attributes";

    bytes32 internal constant _KEY_CID = "abxfs.cid";
    bytes32 internal constant _KEY_NAME = "abxfs.name";
    bytes32 internal constant _KEY_GATEWAY = "abxfs.gateway";

    uint256 internal constant _COLLECTION_SENTINEL = type(uint256).max;
    /// @dev The hook's cap on `abxfs.name`, and the longest name `OrgMeta` shows as a token's `name`.
    uint256 internal constant _MAX_PROJECT_NAME = 128;

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
        if (field != _FIELD_ATTRIBUTES) revert UnsupportedField(field);

        // The collection surface (`contractURI`) has no token behind it. An empty array is the
        // correct answer, and it must be a well-formed one — not a revert.
        if (tokenId == _COLLECTION_SENTINEL) {
            return (_CONTENT_TYPE, bytes("[]"));
        }

        bool published = _cid(token, tokenId) != bytes32(0);
        uint256 versions = _versionCount(token, tokenId);
        string memory kind = _kindLabel(token, tokenId);
        bool hasGateway = _hasGateway(token, tokenId);
        bool named = _named(token, tokenId);

        // `display_type: number` on Versions so a marketplace sorts and filters it numerically
        // rather than lexically — the difference between v2 < v10 and "10" < "2".
        return (
            _CONTENT_TYPE,
            bytes(
                string.concat(
                    "[",
                    _stringTrait("Status", published ? "Published" : "Unpublished"),
                    ",",
                    _stringTrait("Root Kind", kind),
                    ",",
                    _numberTrait("Versions", versions),
                    ",",
                    _stringTrait("Named", named ? "Yes" : "No"),
                    ",",
                    _stringTrait("Preferred IPFS Gateway", hasGateway ? "Set" : "None"),
                    "]"
                )
            )
        );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Reads — every one tolerates an unset value, a hostile callee, or no code
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev A true `valueIsHash` means the key was declared `String`/`Bytes`, so the bytes32 is a
    ///      keccak commitment rather than a CID. Treat that as unpublished instead of reporting a
    ///      project as published on the strength of a hash.
    function _cid(address token, uint256 tokenId) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IAbxParams.tokenParam.selector, tokenId, _KEY_CID)
        );
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

    /// @dev Mirrors `IProjectHook.ContentKind`: 0 = Unset (reported as "None"), 1 = Directory,
    ///      2 = File. Any other value also reads as "None"; a failed or short call reads as "Unknown".
    function _kindLabel(address token, uint256 tokenId) internal view returns (string memory) {
        (bool ok, bytes memory ret) = address(hook).staticcall(
            abi.encodeWithSelector(IProjectHook.kindOf.selector, token, tokenId)
        );
        if (!ok || ret.length < 32) return "Unknown";
        uint256 kind;
        assembly {
            kind := mload(add(ret, 0x20))
        }
        if (kind == 1) return "Directory";
        if (kind == 2) return "File";
        return "None";
    }

    /// @dev Whether `abxfs.gateway` is set: a non-empty payload other than `-`, the SDK's "cleared" marker (ABX
    ///      refuses an empty value, so a cleared string param reads `-`). Only presence is reported — the values are
    ///      owner-controlled text, and putting them in `attributes` would make every trait an injection surface for
    ///      no benefit.
    function _hasGateway(address token, uint256 tokenId) internal view returns (bool) {
        bytes memory value = _data(token, tokenId, _KEY_GATEWAY);
        return value.length != 0 && !(value.length == 1 && value[0] == "-");
    }

    /// @dev Whether the project has a name `OrgMeta` would show as the token's `name`: 1..128 bytes of printable
    ///      ASCII, not only spaces, not `-`. Any other value is "No", like no value, so this trait, the card and the
    ///      token's `name` agree.
    function _named(address token, uint256 tokenId) internal view returns (bool visible) {
        bytes memory b = _data(token, tokenId, _KEY_NAME);
        if (b.length > _MAX_PROJECT_NAME || (b.length == 1 && b[0] == "-")) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7e) return false;
            if (c != 0x20) visible = true;
        }
    }

    /// @dev A `String`/`Bytes` param's payload, in place in the returndata (no copy), or empty when the call fails
    ///      or answers anything but a canonical ABI `bytes` that fits its buffer.
    function _data(address token, uint256 tokenId, bytes32 key) internal view returns (bytes memory out) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IAbxParams.tokenParamData.selector, tokenId, key)
        );
        if (!ok || ret.length < 64) return "";

        uint256 offset;
        uint256 declared;
        assembly {
            offset := mload(add(ret, 0x20))
            declared := mload(add(ret, 0x40))
        }
        if (offset != 0x20 || declared > ret.length - 64) return "";
        assembly ("memory-safe") {
            out := add(ret, 0x40)
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // JSON
    // ──────────────────────────────────────────────────────────────────────────
    //
    // Every value emitted here is a constant from this contract or a decimal number — never
    // owner-controlled text — so no escaping is needed and none is implied. That is a deliberate
    // constraint on which traits exist, not an oversight: admitting a free-text trait would require
    // a JSON escaper on a path that must never revert.

    function _stringTrait(string memory name, string memory value)
        internal
        pure
        returns (string memory)
    {
        return string.concat('{"trait_type":"', name, '","value":"', value, '"}');
    }

    function _numberTrait(string memory name, uint256 value) internal pure returns (string memory) {
        return string.concat(
            '{"trait_type":"', name, '","display_type":"number","value":', value.toString(), "}"
        );
    }
}
