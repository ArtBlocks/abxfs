// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {MockStore, MockAbxToken} from "./mocks/Mocks.sol";

/// @notice The index is not free — every collector pays for it on every move. Measure it rather
///         than estimate it, so the cost can be disclosed accurately when deciding to arm the hook.
contract EnumGasTest is Test {
    ProjectEnumeration internal hook;
    address internal constant C = address(0xC0113C7104);
    address internal constant A = address(0xA11CE);
    address internal constant B = address(0xB0B0B);

    function setUp() public {
        hook = new ProjectEnumeration(address(0));
    }

    function test_measureLifecycleOverhead() public {
        uint256 g = gasleft();
        vm.prank(C);
        hook.onTokenTransfer(0, address(0), A, C, 1);
        uint256 mintCost = g - gasleft();

        // Warm the second owner's slot with an unrelated token so the number reflects a steady-state
        // move rather than a first-touch of every slot involved.
        vm.prank(C);
        hook.onTokenTransfer(1, address(0), B, C, 1);

        g = gasleft();
        vm.prank(C);
        hook.onTokenTransfer(0, A, B, A, 1);
        uint256 transferCost = g - gasleft();

        g = gasleft();
        vm.prank(C);
        hook.onTokenTransfer(0, B, address(0), B, 1);
        uint256 burnCost = g - gasleft();

        g = gasleft();
        vm.prank(C);
        hook.onTokenTransfer(1, B, B, B, 1);
        uint256 selfCost = g - gasleft();

        console.log("mint     overhead (gas):", mintCost);
        console.log("transfer overhead (gas):", transferCost);
        console.log("burn     overhead (gas):", burnCost);
        console.log("self-xfer overhead(gas):", selfCost);

        // Bounds, not exact values — the point is to catch a regression that changes the cost
        // ENVELOPE (an extra cold slot per move, say), not to re-pin on every opcode repricing.
        // Measured at authoring: mint 125,134 · transfer 27,069 · burn 25,778 · self 1,459.
        assertLt(mintCost, 150_000, "mint overhead grew past its envelope");
        assertLt(transferCost, 40_000, "transfer overhead grew past its envelope");
        assertLt(burnCost, 40_000, "burn overhead grew past its envelope");

        // The self-transfer early return is what keeps a no-op move nearly free. If this regresses
        // it means the `from == to` guard stopped short-circuiting and every self-transfer is now
        // churning storage to arrive back where it started.
        assertLt(selfCost, 5_000, "self-transfer is no longer short-circuiting");
    }

    /// @notice The publish ledger's marginal cost, measured on top of the per-token history that
    ///         was already being written. Publishing content already costs far more than this, but
    ///         the number belongs in the decision rather than an estimate.
    function test_measurePublishLedgerOverhead() public {
        MockStore dirStore = new MockStore();
        MockStore fileStore = new MockStore();
        ProjectHook h = new ProjectHook(address(dirStore), address(fileStore), address(0));
        MockAbxToken tok = new MockAbxToken(address(h));
        tok.setOwner(1, A);

        bytes32 first = keccak256("r1");
        bytes32 second = keccak256("r2");
        dirStore.add(first);
        dirStore.add(second);

        vm.prank(A);
        uint256 g = gasleft();
        tok.configure(1, "abxfs.cid", first);
        uint256 firstPublish = g - gasleft();

        vm.prank(A);
        g = gasleft();
        tok.configure(1, "abxfs.cid", second);
        uint256 republish = g - gasleft();

        console.log("first publish  (total, gas):", firstPublish);
        console.log("republish      (total, gas):", republish);
        assertEq(h.publishCount(address(tok)), 2);
    }
}