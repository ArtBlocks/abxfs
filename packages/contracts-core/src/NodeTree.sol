// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {CodeStore} from "./utils/CodeStore.sol";

/// @title NodeTree
/// @notice Shared mechanics of the ABX FS file and directory stores: an append-only forest of immutable nodes, each
///         identified by `keccak256(prefix ‖ blob)` and kept as contract code by the store itself (never through a
///         storage backend), so the index is always readable on chain. See `specs/abx-fs.md` §5.
///
/// @dev A node is a leaf (`level 0`, data defined by the concrete store) or a branch
///      (`level k`, 1 ≤ k ≤ 3: `k ‖ n:2 ‖ (childId:32 ‖ cumulativeCount:4 [‖ cumulativeBytes:6]) × n`, 2 ≤ n ≤ 128) over
///      children one level lower. `cumulativeBytes` is present only in stores that track bytes (files). The store
///      writes the blob itself, so a node id can only map to the bytes that hash to it. There is no owner, no
///      builder state and no deletion; creating an existing node is a no-op.
abstract contract NodeTree {
    error NodeEmpty();
    error NodeTooLarge(uint256 size);
    error BadNode();
    error NodeMissing(bytes32 nodeId);
    error LevelMismatch(bytes32 nodeId, uint8 expected, uint8 actual);
    error CountMismatch(uint256 index);
    error BytesMismatch(uint256 index);
    error IndexOutOfRange(uint256 index, uint256 count);
    error OffsetOutOfRange(uint256 offset, uint256 size);

    uint256 internal constant _MAX_NODE_BYTES = CodeStore.MAX_DATA;
    uint256 internal constant _MAX_LEVEL = 3;
    uint256 internal constant _MAX_BRANCH = 128;
    uint256 internal constant _BRANCH_HEADER = 3;

    /// @dev One storage slot: pointer (160) | level (8) | count (32) | bytes (48, zero where bytes are not tracked).
    struct Node {
        address pointer;
        uint8 level;
        uint32 count;
        uint48 bytes_;
    }

    mapping(bytes32 => Node) internal _nodes;

    event NodeCreated(bytes32 indexed nodeId, uint8 level, uint32 count, uint48 size);

    /// @dev Validate a leaf's blob and return its item count and byte total. Must revert on any malformed blob.
    function _validateLeaf(bytes calldata blob) internal view virtual returns (uint32 count, uint48 bytes_);

    /// @dev Whether branches carry `cumulativeBytes` (and nodes a byte total).
    function _tracksBytes() internal pure virtual returns (bool);

    function _branchStride() internal pure returns (uint256) {
        return _tracksBytes() ? 42 : 36;
    }

    /// @dev Called for each adjacent pair of branch children; concrete stores may enforce ordering.
    function _checkBoundary(bytes32 left, bytes32 right) internal view virtual {}

    function _putNode(bytes1 prefix, bytes calldata blob) internal returns (bytes32 id) {
        uint256 len = blob.length;
        if (len == 0) revert NodeEmpty();
        if (len > _MAX_NODE_BYTES) revert NodeTooLarge(len);
        id = keccak256(abi.encodePacked(prefix, blob));
        if (_nodes[id].pointer != address(0)) return id;

        uint8 level = uint8(blob[0]);
        uint32 count;
        uint48 total;
        if (level == 0) {
            (count, total) = _validateLeaf(blob);
        } else {
            (count, total) = _validateBranch(level, blob);
        }

        address ptr = CodeStore.place(blob);
        _nodes[id] = Node({pointer: ptr, level: level, count: count, bytes_: total});
        emit NodeCreated(id, level, count, total);
    }

    function _validateBranch(uint8 level, bytes calldata blob) private view returns (uint32, uint48) {
        if (level > _MAX_LEVEL || blob.length < _BRANCH_HEADER) revert BadNode();
        uint256 n = uint16(bytes2(blob[1:3]));
        uint256 stride = _branchStride();
        if (n < 2 || n > _MAX_BRANCH || blob.length != _BRANCH_HEADER + n * stride) revert BadNode();

        uint256 running;
        uint256 runningBytes;
        bytes32 prev;
        for (uint256 i = 0; i < n;) {
            bytes32 childId;
            (childId, running, runningBytes) =
                _checkChild(level, blob, i, _BRANCH_HEADER + i * stride, running, runningBytes);
            if (i != 0) _checkBoundary(prev, childId);
            prev = childId;
            unchecked {
                ++i;
            }
        }
        // Both fit: each running total was matched against a 4-byte count and a 6-byte byte field above.
        return (uint32(running), uint48(runningBytes));
    }

    /// @dev One branch child at offset `o`: it exists one level lower and the cumulative fields match its totals.
    function _checkChild(uint8 level, bytes calldata blob, uint256 i, uint256 o, uint256 running, uint256 runningBytes)
        private
        view
        returns (bytes32 childId, uint256, uint256)
    {
        childId = bytes32(blob[o:o + 32]);
        Node memory child = _nodes[childId];
        if (child.pointer == address(0)) revert NodeMissing(childId);
        if (child.level != level - 1) revert LevelMismatch(childId, level - 1, child.level);
        running += child.count;
        if (uint32(bytes4(blob[o + 32:o + 36])) != running) revert CountMismatch(i);
        if (_tracksBytes()) {
            runningBytes += child.bytes_;
            if (uint48(bytes6(blob[o + 36:o + 42])) != runningBytes) revert BytesMismatch(i);
        }
        return (childId, running, runningBytes);
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function _node(bytes32 id) internal view returns (Node memory node) {
        node = _nodes[id];
        if (node.pointer == address(0)) revert NodeMissing(id);
    }

    function _read(address ptr, uint256 start, uint256 len) internal view returns (bytes memory) {
        return SSTORE2.read(ptr, start, start + len);
    }

    /// @dev Big-endian integer of `len` (at most 32) data bytes at `start`, copied into scratch space with no
    ///      allocation. Data byte `k` is code byte `k + 1`, after SSTORE2's STOP byte.
    function _readUint(address ptr, uint256 start, uint256 len) internal view returns (uint256 v) {
        assembly ("memory-safe") {
            mstore(0x00, 0)
            extcodecopy(ptr, 0x00, add(start, 1), len)
            v := shr(shl(3, sub(0x20, len)), mload(0x00))
        }
    }

    function _branchChildren(Node memory node) internal view returns (uint256) {
        return _readUint(node.pointer, 1, 2);
    }

    function _branchChild(Node memory node, uint256 i) internal view returns (bytes32 id) {
        id = bytes32(_readUint(node.pointer, _BRANCH_HEADER + i * _branchStride(), 32));
    }

    function _branchCumulative(Node memory node, uint256 i) internal view returns (uint256) {
        return _readUint(node.pointer, _BRANCH_HEADER + i * _branchStride() + 32, 4);
    }

    function _branchCumulativeBytes(Node memory node, uint256 i) internal view returns (uint256) {
        return _readUint(node.pointer, _BRANCH_HEADER + i * _branchStride() + 36, 6);
    }

    /// @dev Descend from `root` to the leaf holding item `index`. Returns the leaf and the index within it.
    function _locate(bytes32 root, uint256 index) internal view returns (Node memory leaf, uint256 local) {
        Node memory node = _node(root);
        if (index >= node.count) revert IndexOutOfRange(index, node.count);
        local = index;
        while (node.level != 0) {
            uint256 n = _branchChildren(node);
            uint256 lo = 0;
            uint256 hi = n - 1;
            while (lo < hi) {
                uint256 mid = (lo + hi) / 2;
                if (_branchCumulative(node, mid) > local) hi = mid;
                else lo = mid + 1;
            }
            if (lo != 0) local -= _branchCumulative(node, lo - 1);
            node = _node(_branchChild(node, lo));
        }
        leaf = node;
    }

    /// @dev Descend from `root` to the leaf holding byte `offset` (stores that track bytes only). Returns the leaf, the
    ///      offset within it, and the index of its first item in the whole tree.
    function _locateByte(bytes32 root, uint256 offset)
        internal
        view
        returns (Node memory leaf, uint256 local, uint256 firstItem)
    {
        Node memory node = _node(root);
        if (offset >= node.bytes_) revert OffsetOutOfRange(offset, node.bytes_);
        local = offset;
        while (node.level != 0) {
            uint256 n = _branchChildren(node);
            uint256 lo = 0;
            uint256 hi = n - 1;
            while (lo < hi) {
                uint256 mid = (lo + hi) / 2;
                if (_branchCumulativeBytes(node, mid) > local) hi = mid;
                else lo = mid + 1;
            }
            if (lo != 0) {
                local -= _branchCumulativeBytes(node, lo - 1);
                firstItem += _branchCumulative(node, lo - 1);
            }
            node = _node(_branchChild(node, lo));
        }
        leaf = node;
    }

    /// @notice The stored node (for tooling and mirrors): its blob, shape and byte total (zero for directory nodes).
    function getNode(bytes32 nodeId) external view returns (bytes memory blob, uint8 level, uint32 count, uint48 size) {
        Node memory node = _node(nodeId);
        return (SSTORE2.read(node.pointer), node.level, node.count, node.bytes_);
    }

    function nodeExists(bytes32 nodeId) external view returns (bool) {
        return _nodes[nodeId].pointer != address(0);
    }
}
