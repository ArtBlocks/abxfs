// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title LocalChain — the one rule the deploy scripts use to tell a local development chain from a real one
/// @notice A deploy script skips its pin check only on a local chain, so this must never call a real chain local.
///         `--chain-id`, `FOUNDRY_CHAIN_ID` or a `chain_id` setting change `block.chainid`, not the chain a broadcast
///         is signed for and sent to, so the RPC itself is asked. It fails closed: an RPC that answers anything but
///         31337, or does not answer, is not local. With no RPC at all (no fork) nothing can be broadcast, so that is.
abstract contract LocalChain is Script {
    /// @dev Anvil's default chain id: local development deploys whatever the working tree builds.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    function _isLocal() internal returns (bool) {
        return _isLocalAsking("eth_chainId");
    }

    /// @dev `_isLocal` with the method named, so a test can make the call fail against a live node.
    function _isLocalAsking(string memory method) internal returns (bool) {
        if (block.chainid != LOCAL_CHAIN_ID) return false;
        try vm.activeFork() returns (uint256) {}
        catch {
            return true;
        }
        try vm.rpc(method, "[]") returns (bytes memory r) {
            return _answersLocal(r);
        } catch {
            return false;
        }
    }

    /// @dev Whether an `eth_chainId` answer, as `vm.rpc` returns it (the quantity's big-endian bytes), is 31337.
    function _answersLocal(bytes memory r) internal pure returns (bool) {
        return r.length != 0 && r.length <= 32 && uint256(bytes32(r)) >> (256 - 8 * r.length) == LOCAL_CHAIN_ID;
    }
}
