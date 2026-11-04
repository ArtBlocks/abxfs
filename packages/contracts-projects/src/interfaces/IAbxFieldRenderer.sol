// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAbxFieldRenderer — computes one field of an ABX token's on-chain metadata
/// @notice A field renderer returns ONE metadata field's value, COMPUTED from chain state
///         (the token's seed + PostParams, its owner, anything readable on-chain). The ABX
///         metadata renderer staticcalls it to build `tokenURI` — e.g. an `image` renderer's
///         SVG becomes `data:image/svg+xml;base64,…`.
///
/// @dev THE FIVE INVARIANTS (a reverting or malformed renderer bricks the WHOLE tokenURI —
///      the metadata renderer staticcalls you with NO try/catch):
///        1. NEVER revert for any (token, tokenId) on a field you render — including the collection
///           surface `tokenId == type(uint256).max` (used by `contractURI`). Return a neutral value.
///        2. Return the correct `contentType` (`image/svg+xml` for an image; `application/json`
///           for an `attributes` array).
///        3. Guard `field`: revert only a truly unsupported field (a deploy-time miswiring), but
///           still never revert on the fields you DO render.
///        4. `view` + deterministic: same chain state → same bytes.
///        5. Bounded output, so `tokenURI` stays a cheap single eth_call.
interface IAbxFieldRenderer {
    /// @param token   the ABX collection contract (read its params via {IAbxParams}).
    /// @param tokenId the token, or `type(uint256).max` for the collection surface.
    /// @param field   which field to compute (e.g. `"image"`, `"attributes"`).
    /// @return contentType MIME of `data` (e.g. `image/svg+xml`, `application/json`).
    /// @return data        the field's finished bytes.
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data);
}
