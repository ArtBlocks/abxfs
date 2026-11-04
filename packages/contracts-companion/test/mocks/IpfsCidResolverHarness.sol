// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IpfsCidResolver} from "../../src/IpfsCidResolver.sol";
import {CID} from "@abxfs/protobuf/CID.sol";

/// @notice Exposes the balanced-DAG fold so multi-level shapes can be checked against synthetic leaves (fixtures from
///         `ipfs-unixfs-importer`) without writing gigabytes of content, and the sharding check so its decision can be
///         driven over any entry list.
contract IpfsCidResolverHarness is IpfsCidResolver {
    constructor(address f, address d) IpfsCidResolver(f, d) {}

    /// @notice Reverts `DirectoryNeedsSharding` exactly where `computeIpfsCid` would, before deriving any child.
    function refuseSharded(bytes32 cid, uint256 count) external view {
        _refuseSharded(cid, count);
    }

    /// @param leafShas sha2-256 digests of raw leaves, in order.
    /// @param leafSizes each leaf's byte length (its block size and, for a raw leaf, its cumulative size).
    function foldToRootCid(bytes32[] calldata leafShas, uint256[] calldata leafSizes)
        external
        view
        returns (string memory cidStr, bytes32 sha, uint256 rootLen, uint256 rootCumulative)
    {
        uint256 n = leafShas.length;
        Layer memory layer = Layer(new bytes32[](n), new uint256[](n), new uint256[](n));
        for (uint256 i; i < n; i++) {
            layer.shas[i] = leafShas[i];
            layer.totals[i] = leafSizes[i];
            layer.cums[i] = leafSizes[i];
        }
        (sha, rootCumulative, rootLen) = _fold(layer, n);
        cidStr = CID.encode(CID.CODEC_DAG_PB, sha);
    }
}
