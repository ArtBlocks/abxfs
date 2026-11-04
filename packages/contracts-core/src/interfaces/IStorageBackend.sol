// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStorageBackend
/// @notice Where an ABX FS chunk's bytes live. Anyone can deploy a backend and use it at once: nothing registers
///         backends, and a backend's address is part of every chunk id stored through it, so no backend can affect
///         content stored through another.
///
/// @dev    Backends are never trusted for integrity. `ChunkStore` checks a readable backend's bytes when a chunk is
///         written and on every read; a reader checks any other backend's bytes against the chunk record. A backend
///         may compress, keep bytes in contract code, in logs, in blobs or anywhere else, and may change behaviour at
///         any time: availability is the backend's, integrity is not. Of the ABX FS contracts, only `ChunkStore` calls a backend. See
///         `specs/abx-fs.md` §3.
interface IStorageBackend {
    /// @notice Thrown by `retrieve` when the backend is not EVM-readable.
    error NotEvmReadable();

    /// @notice Store `input` and return an opaque pointer this backend resolves later. May revert to refuse.
    /// @param  caller The account that called `ChunkStore.write`, so a backend can bill, meter or gate writers (a
    ///         deposit it holds, an allowance it pulls). Anyone can call a backend directly with any `caller`, so a
    ///         backend that acts on it must first check that `msg.sender` is the `ChunkStore` it serves. Writes of an
    ///         existing chunk never reach the backend.
    function store(bytes calldata input, address caller) external returns (bytes32 pointer);

    /// @notice Whether `retrieve` returns a chunk's bytes from chain state.
    function readable() external view returns (bool);

    /// @notice The chunk's bytes, after any decoding this backend performs (for example FastLZ inflation).
    ///         MUST revert `NotEvmReadable()` when `readable()` is false.
    function retrieve(bytes32 pointer) external view returns (bytes memory data);

    /// @notice A best-effort, untrusted description of how to fetch this backend's bytes off chain. `scheme` is a
    ///         lowercase ASCII token, left-aligned and zero-padded (an SDK convention, for example "evm").
    function retrieval() external view returns (bytes32 scheme, string memory instructions);

    /// @notice The largest `input` that `store` accepts. For planners only: `ChunkStore` does not call it.
    function maxInputSize() external view returns (uint256);
}
