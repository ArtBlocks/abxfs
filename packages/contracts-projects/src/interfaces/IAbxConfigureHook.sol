// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAbxConfigureHook — the write-time validator/veto on an ABX PostParam
/// @notice An ABX code collection (`SeriesCode` / `EditionCode`) may wire up to three param-lifecycle
///         hooks: `configure` (this one), `augment` (read-time derivation), and `transfer`. The
///         collection calls `onParamConfigured` on every write to a schema-governed param (a key with
///         a declared schema), **before the value persists** — so a revert here vetoes the write and
///         nothing is stored.
///
/// @dev    `msg.sender` is the ABX collection contract. It is NOT passed as an argument, which is
///         what makes a single hook safely serve many collections: any state a hook keys by
///         `msg.sender` cannot be written on another collection's behalf, because only that
///         collection can be `msg.sender`. A caller impersonating the interface only ever writes
///         under its own address.
///
///         Setting hooks is owner-only (`setParamHooks`), with no permissionless path in any state —
///         including a renounced (`owner() == 0`) collection. So once hooks are locked or the
///         collection is renounced (every org is both at creation), an armed hook that wrongly
///         reverts is unrecoverable: it freezes every write to the keys it guards, for the life of
///         the collection. Treat every revert path as load-bearing.
interface IAbxConfigureHook {
    /// @param tokenId       the token whose param is being written. `type(uint256).max` is the
    ///                      collection surface, not a real token.
    /// @param key           the param key, short ASCII packed into bytes32 (not hashed).
    /// @param value         for a scalar param, the literal value; for a `String`/`Bytes` param,
    ///                      `keccak256` of the payload.
    /// @param updatedBy     the address that satisfied the schema's auth for this write.
    /// @param dataLength    payload length in bytes for a `String`/`Bytes` param, else 0. Exists so
    ///                      a collection's own hook can bound blob size — ABX deliberately does
    ///                      not cap it.
    /// @param dataBlobAddress the SSTORE2 blob holding a `String`/`Bytes` payload, else `address(0)`.
    function onParamConfigured(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        address updatedBy,
        uint256 dataLength,
        address dataBlobAddress
    ) external;
}
