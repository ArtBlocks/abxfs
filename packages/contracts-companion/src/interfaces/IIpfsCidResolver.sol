// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIpfsCidResolver
/// @notice Same-chain, view-only IPFS CIDv1 derivation for ABX FS files and directories, from content on chain.
/// @dev Profile (`specs/abx-fs.md` §8): CIDv1, sha2-256, raw (0x55) leaves and single-block files, dag-pb (0x70)
///      multi-block file roots and directories, 256 KiB blocks, balanced DAG of at most 174 links per node, directory
///      links in unsigned byte order of name, and every link's `Tsize` the cumulative serialized size of its subtree.
///      A directory `ipfs add -r` would shard into a HAMT is refused, not derived (`DirectoryNeedsSharding`).
interface IIpfsCidResolver {
    error FileNotFound(bytes32 cid);
    error DirectoryNotFound(bytes32 cid);
    /// @notice The file carries an off-chain file codec, which the chain cannot decode; derive its CID off chain.
    error CodecNotSupported(bytes32 codec);
    /// @notice `ipfs add -r` would shard this directory into a HAMT, which is not derived: its link estimate (each
    ///         entry's name bytes plus its 36 CID bytes, summed) passes 262,144 bytes. `estimate` is the sum where
    ///         counting stopped, already past 262,144: at the first entry, in name order, that takes it past, or
    ///         `entryCount × 37` when the count alone does (every name is at least one byte). The whole directory's
    ///         sum is at least this.
    error DirectoryNeedsSharding(bytes32 cid, uint256 estimate);
    error StoreMismatch();
    /// @notice A store answered in a shape it never produces (defensive; the stores are immutable).
    error BadReturn();
    error SizeMismatch(bytes32 cid, uint256 expected, uint256 read);

    /// @notice The IPFS CIDv1 of an ABX FS directory ("bafybei…").
    function computeIpfsCid(bytes32 directoryCid) external view returns (string memory ipfsCid);

    /// @notice The IPFS CIDv1 of an ABX FS file: raw for at most 256 KiB of content, dag-pb above.
    function computeFileCid(bytes32 fileCid) external view returns (string memory ipfsCid);

    /// @notice What a parent dag-pb node links to for this file: the CID's codec (0x55 or 0x70), the sha2-256 digest,
    ///         and the cumulative serialized size of the file's DAG (the parent link's `Tsize`).
    function fileLink(bytes32 fileCid) external view returns (uint256 codec, bytes32 digest, uint256 tsize);

    /// @notice The same for a directory (codec is always 0x70).
    function directoryLink(bytes32 directoryCid) external view returns (uint256 codec, bytes32 digest, uint256 tsize);
}
