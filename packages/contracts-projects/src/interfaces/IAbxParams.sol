// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAbxParams — read the token's on-chain params (seed + collector PostParams)
/// @notice A renderer reads live state through this. Each value is a `bytes32`; `isSet` tells
///         you whether it exists (fall back to a default if not — see invariant 1 in
///         {IAbxFieldRenderer}). `valueIsHash` is true when the value is the keccak256 of a
///         `String`/`Bytes` payload held on chain (read it with `tokenParamData`); a literal scalar
///         param like a `seed` or a `HexColor` palette is NOT a hash — check `!valueIsHash`.
///
///         The tokenData merge rule: a token-scope value overrides the contract-scope one. The
///         common pattern is `tokenParam` first, then `contractParam` as a fallback.
///
///         TWO READERS, PICK BY TYPE. Scalar types (`Bool`, `Select`, the ranges, `HexColor`,
///         `Timestamp`) live entirely in the `bytes32` — read them with `tokenParam` /
///         `contractParam`. The two payload types, **`Bytes` and `String`**, do NOT: their
///         `bytes32` is a keccak COMMITMENT (`valueIsHash == true`) and the content is fetched with
///         `tokenParamData` / `contractParamData` below. Reading a `Bytes` param with `tokenParam`
///         hands you a hash, not the work — that is the tell you want the data reader.
interface IAbxParams {
    /// Returns the token-scope param: its bytes32 `value`, `valueIsHash` (true if it is the keccak256
    /// of a `String`/`Bytes` payload — a literal scalar like a seed/HexColor is false), and `isSet`
    /// (does it exist).
    function tokenParam(uint256 tokenId, bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet);

    /// @notice The contract-scope (collection-wide) value — the fallback when a token has none.
    function contractParam(bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet);

    /// @notice A `Bytes`/`String` token param's FULL content — the payload types' real reader.
    ///         Returns empty bytes for a literal scalar or an unset key, so an empty return is your
    ///         "fall back to a default" signal. When non-empty, `keccak256(returned bytes)` equals
    ///         the `value` that `tokenParam` reports — verify it if you want the commitment proof.
    ///         One SSTORE2 blob per key, so at most the EVM's contract code-size limit.
    function tokenParamData(uint256 tokenId, bytes32 key) external view returns (bytes memory);

    /// @notice The contract-scope (collection-wide) blob — the fallback when a token has none.
    function contractParamData(bytes32 key) external view returns (bytes memory);
}
