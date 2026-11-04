// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAbxTransferHook — the ownership-change lifecycle callback on an ABX code collection
/// @notice Mirrors ABX's `IAbxTransferHook`. Declared locally because the collection calls it by
///         signature, and vendoring ABX's whole contract tree to compile against one interface would
///         couple this build to theirs.
///
/// @dev    Called from `SeriesCode._afterTokenTransfer`, so the move has ALREADY been applied when
///         the hook runs — `ownerOf(tokenId)` returns `to` during this call, not `from`.
///
///         **This is a VETO.** ABX calls it plainly: no try/catch, no gas cap, no swallowed
///         returndata. A revert here bubbles and fails the transfer — and because a mint is a
///         transfer from `address(0)`, a reverting hook also stops minting, through any minter. Any
///         revert path is therefore a liveness risk for the entire collection, which is why
///         `ProjectEnumeration` treats inconsistency as something to repair rather than something to
///         assert against.
///
///         **`msg.sender` is the collection**, and it is not passed as an argument. That is what
///         lets one deployment serve many collections safely: state keyed by `msg.sender` cannot be
///         written on another collection's behalf. This callback is otherwise an ordinary external
///         function — anyone may call it with forged arguments — so an implementation that keys
///         state by anything OTHER than `msg.sender` must authenticate the caller another way: pin the
///         token in its constructor, or ask a registry (as `ProjectEnumeration` asks the factory's
///         `isOrg`).
///
///         **On ERC-721, self-transfers ARE delivered.** `SeriesCode._notifyTransferHook` has no
///         `from == to` guard; only the ERC-1155 path filters self-transfers and zero amounts. A
///         hook that cares about ownership-set changes must skip that case itself.
interface IAbxTransferHook {
    /// @param tokenId  the ERC-721 token that moved.
    /// @param from     the previous owner. `address(0)` on mint.
    /// @param to       the new owner. `address(0)` on burn.
    /// @param operator the caller that initiated the move — the holder, an approved operator, or a
    ///                 minter. On ERC-721 `SeriesCode` passes `msg.sender`.
    /// @param amount   copies moved. Always 1 on ERC-721.
    function onTokenTransfer(
        uint256 tokenId,
        address from,
        address to,
        address operator,
        uint256 amount
    ) external;
}
