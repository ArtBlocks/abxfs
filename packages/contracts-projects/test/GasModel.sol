// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm, VmSafe} from "forge-std/Vm.sol";

/// @dev What a recorded call costs under the two gas schedules the SDK models (`packages/sdk/src/gas-schedule.ts`):
///      legacy (one dimension) and EIP-8037 at CPSB 1,530 (state priced per byte, its own dimension; EIP-8038's
///      access charges as execution). Legacy is measured; EIP-8037 is derived from the state the call created: every
///      new account, every byte of code and every slot written from zero to non-zero.
library GasModel {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant LEGACY_SLOT = 22_100;
    uint256 internal constant LEGACY_ACCOUNT = 32_000;
    uint256 internal constant LEGACY_CODE_BYTE = 200;
    uint256 internal constant STATE_SLOT = 97_920;
    uint256 internal constant STATE_ACCOUNT = 183_600;
    uint256 internal constant STATE_CODE_BYTE = 1_530;
    uint256 internal constant EXEC_SLOT = 12_100;
    uint256 internal constant EXEC_ACCOUNT = 12_000;

    struct Created {
        uint256 accounts;
        uint256 codeBytes;
        uint256 slots;
    }

    struct Cost {
        uint256 legacy;
        uint256 execution8037;
        uint256 state8037;
    }

    /// @notice The state created by the accesses recorded since `vm.startStateDiffRecording()`.
    function created(VmSafe.AccountAccess[] memory acc) internal pure returns (Created memory c) {
        uint256 n;
        for (uint256 i; i < acc.length; ++i) n += acc[i].storageAccesses.length;
        address[] memory accts = new address[](n);
        bytes32[] memory slots = new bytes32[](n);
        bytes32[] memory first = new bytes32[](n);
        bytes32[] memory last = new bytes32[](n);
        uint256 m;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].reverted) continue;
            if (acc[i].kind == VmSafe.AccountAccessKind.Create) {
                ++c.accounts;
                c.codeBytes += acc[i].deployedCode.length;
            }
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = acc[i].storageAccesses[j];
                if (!s.isWrite || s.reverted) continue;
                uint256 k;
                for (; k < m; ++k) {
                    if (accts[k] == s.account && slots[k] == s.slot) break;
                }
                if (k == m) {
                    accts[m] = s.account;
                    slots[m] = s.slot;
                    first[m] = s.previousValue;
                    ++m;
                }
                last[k] = s.newValue;
            }
        }
        for (uint256 k; k < m; ++k) {
            if (first[k] == bytes32(0) && last[k] != bytes32(0)) ++c.slots;
        }
    }

    /// @notice Split a measured legacy total into EIP-8037 execution and state, from the state it created.
    function cost(uint256 legacyTotal, Created memory c) internal pure returns (Cost memory r) {
        r.legacy = legacyTotal;
        uint256 legacyState = c.slots * LEGACY_SLOT + c.accounts * LEGACY_ACCOUNT + c.codeBytes * LEGACY_CODE_BYTE;
        r.execution8037 = legacyTotal - legacyState + c.slots * EXEC_SLOT + c.accounts * EXEC_ACCOUNT;
        r.state8037 = c.slots * STATE_SLOT + c.accounts * STATE_ACCOUNT + c.codeBytes * STATE_CODE_BYTE;
    }
}
