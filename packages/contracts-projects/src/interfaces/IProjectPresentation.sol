// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAbxFieldRenderer} from "./IAbxFieldRenderer.sol";

/// @notice Owner-controlled presentation, separate from a project's append-only publishing history.
interface IProjectPresentation is IAbxFieldRenderer {
    enum Method {
        ChainGateway,
        Embedded,
        Ipfs
    }
    enum Selection {
        Latest,
        Version,
        Tag
    }
    enum Status {
        Ready,
        Unpublished,
        InvalidTarget,
        UnsupportedMime,
        ReadFailed,
        IpfsFailed,
        UnsupportedCodec,
        OverBudget
    }

    struct Config {
        Selection selection;
        Method method;
        uint8 locks;
        uint32 version;
        bytes32 frozenRoot;
        string tag;
        string path;
        string chainBase;
        string ipfsBase;
    }

    error NotProjectOwner();
    error InvalidOrg();
    error Locked(uint8 dimension);
    error InvalidConfiguration();
    error StaleCommitment(bytes32 expected, bytes32 actual);

    event TargetChanged(address indexed org, uint256 indexed tokenId);
    event MethodChanged(address indexed org, uint256 indexed tokenId, Method method);
    event EndpointsChanged(address indexed org, uint256 indexed tokenId);
    event PresentationLocked(address indexed org, uint256 indexed tokenId, uint8 locks, bytes32 frozenRoot);

    function setTarget(
        address org,
        uint256 tokenId,
        Selection selection,
        uint32 version,
        string calldata tag,
        string calldata path
    ) external;
    function setMethod(address org, uint256 tokenId, Method method) external;
    function setEndpoints(address org, uint256 tokenId, string calldata chainBase, string calldata ipfsBase) external;
    /// @notice Commit only the dimensions in mask; already locked dimensions use their frozen values.
    function lockCommitment(address org, uint256 tokenId, uint8 mask) external view returns (bytes32);
    /// @notice Irreversibly freeze reviewed dimensions. Repeating a lock is idempotent with its unchanged commitment.
    function lock(address org, uint256 tokenId, uint8 mask, bytes32 expectedCommitment) external;
    function config(address org, uint256 tokenId) external view returns (Config memory);
    function target(address org, uint256 tokenId) external view returns (bytes32 root, string memory path);
    function preview(address org, uint256 tokenId)
        external
        view
        returns (Status status, string memory contentType, bytes memory data);
}
