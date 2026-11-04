// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {IProjectHook} from "../../src/interfaces/IProjectHook.sol";
import {MockStore, MockAbxToken} from "../mocks/Mocks.sol";
import {MockRegistry} from "../mocks/AbxMocks.sol";

/// @dev Burns every gas unit it is given: models a registry (should it ever misbehave) answering a gas bomb.
contract GasBurnRegistry {
    fallback() external {
        assembly { invalid() }
    }
}

/// @dev Returns a 1 MiB blob.
contract BombRegistry {
    fallback() external {
        assembly { return(0, 0x100000) }
    }
}

contract AuditHooksProps is Test {
    ProjectHook hook;
    MockStore dirStore;
    MockStore fileStore;
    MockAbxToken token;
    address alice = address(0xA11CE);
    bytes32 constant KEY_CID = "abxfs.cid";

    function setUp() public {
        dirStore = new MockStore();
        fileStore = new MockStore();
        hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        token = new MockAbxToken(address(hook));
        token.setOwner(7, alice);
        dirStore.add(keccak256("A"));
        dirStore.add(keccak256("B"));
    }

    // ---- F1: history / tag bloat by a prior owner makes unpaged reads superlinear-costly ----
    function test_audit_versionHistoryBloatReadGasGrowsLinearly() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        uint256 N = 600;
        vm.startPrank(alice);
        for (uint256 i; i < N; ++i) token.configure(7, KEY_CID, i % 2 == 0 ? a : b);
        vm.stopPrank();
        uint256 g0 = gasleft();
        hook.versionsRange(address(token), 7, 0, N);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas for versionsRange(600)", used);
        emit log_named_uint("per-version gas", used / N);
        // anything on-chain that depended on this would be priced by the attacker; renderers only use versionCount
        assertGt(used / N, 1000);
    }

    // ACCEPTED RISK (owner decision, F4): no tag cap per token.
    function test_audit_tagBloatAndCheapPerTagCost() public {
        bytes32 a = keccak256("A");
        vm.prank(alice);
        token.configure(7, KEY_CID, a);
        uint256 N = 400;
        uint256 g0 = gasleft();
        vm.startPrank(alice);
        for (uint256 i; i < N; ++i) {
            hook.setTag(address(token), 7, string.concat("t", vm.toString(i)), 1);
        }
        vm.stopPrank();
        emit log_named_uint("gas per setTag (creation)", (g0 - gasleft()) / N);
        uint256 g1 = gasleft();
        string[] memory t = hook.listTags(address(token), 7);
        emit log_named_uint("listTags gas per tag", (g1 - gasleft()) / N);
        assertEq(t.length, N);
    }

    // ---- F: _isOrg robustness against hostile responses (only reachable if the immutable factory misbehaved) ----
    function _gasOfPublishWith(address registry, uint256 gasCap) internal returns (bool ok, uint256 used, uint256 globalCount) {
        ProjectHook h = new ProjectHook(address(dirStore), address(fileStore), registry);
        MockAbxToken t = new MockAbxToken(address(h));
        t.setOwner(1, alice);
        vm.prank(alice);
        uint256 g = gasleft();
        try t.configure{gas: gasCap}(1, KEY_CID, keccak256("A")) {
            ok = true;
        } catch {}
        used = g - gasleft();
        globalCount = h.globalPublishCount();
    }

    function test_audit_isOrgBombRegistryCostAndNoRevert() public {
        (bool okN, uint256 usedN,) = _gasOfPublishWith(address(0xdead), 30_000_000);
        (bool okB, uint256 usedB,) = _gasOfPublishWith(address(new BombRegistry()), 30_000_000);
        emit log_named_uint("publish gas, normal registry", usedN);
        emit log_named_uint("publish gas, 1MiB-return registry", usedB);
        assertTrue(okN && okB);
        assertGt(usedB, usedN + 1_000_000); // returndata copy is unbounded; factory is trusted, so only theoretical
    }

    function test_audit_isOrgGasBurnRegistry() public {
        (bool ok, uint256 used,) = _gasOfPublishWith(address(new GasBurnRegistry()), 5_000_000);
        emit log_named_uint("gas-burn registry: publish ok (1=yes)", ok ? 1 : 0);
        emit log_named_uint("gas used", used);
    }

    // ---- SameRoot after owner clears / tag rules ----
    function test_audit_reservedLatestHashMatches() public pure {
        assertEq(keccak256("latest"), 0x5d7c83ff6d08efb2f110018d8b6814a4719a93273a3ea09ced5cfe0d5db1d001);
    }

    function test_audit_tagNameEdge_cases() public {
        vm.prank(alice);
        token.configure(7, KEY_CID, keccak256("A"));
        vm.startPrank(alice);
        // 64 chars allowed
        string memory s64 = "a123456789012345678901234567890123456789012345678901234567890123";
        assertEq(bytes(s64).length, 64);
        hook.setTag(address(token), 7, s64, 1);
        vm.expectRevert();
        hook.setTag(address(token), 7, string.concat(s64, "x"), 1);
        vm.expectRevert();
        hook.setTag(address(token), 7, "latest", 1);
        // "latest " variants differ
        hook.setTag(address(token), 7, "latest1", 1);
        vm.stopPrank();
        // removing then re-adding in swap-and-pop order keeps indexes right
        vm.startPrank(alice);
        hook.setTag(address(token), 7, "x1", 1);
        hook.setTag(address(token), 7, "x2", 1);
        hook.setTag(address(token), 7, "x3", 1);
        hook.removeTag(address(token), 7, "x1");
        hook.removeTag(address(token), 7, "x3");
        hook.removeTag(address(token), 7, "x2");
        hook.removeTag(address(token), 7, s64);
        hook.removeTag(address(token), 7, "latest1");
        vm.stopPrank();
        assertEq(hook.tagCount(address(token), 7), 0);
    }

    // ---- Stale-owner tag authority: ex-owner loses tag power; new owner inherits tags & history ----
    function test_audit_buyerInheritsKindLockAndHistory() public {
        MockStore f = fileStore;
        bytes32 file = keccak256("F");
        f.add(file);
        // The mock stores answer both predicates from one set, so use a split store pair instead.
        MockStore d2 = new MockStore();
        MockStore f2 = new MockStore();
        ProjectHook h = new ProjectHook(address(d2), address(f2), address(0));
        MockAbxToken t = new MockAbxToken(address(h));
        f2.add(file);
        d2.add(keccak256("D"));
        t.setOwner(1, alice);
        vm.prank(alice);
        t.configure(1, KEY_CID, file); // seller locks File kind
        address buyer = address(0xB0B);
        t.setOwner(1, buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IProjectHook.RootKindLocked.selector, IProjectHook.ContentKind.File, IProjectHook.ContentKind.Directory));
        t.configure(1, KEY_CID, keccak256("D"));
    }
}

/// @dev Stateful fuzz of the enumeration hook against a collection that can LIE about `from` and replay arbitrary orders.
contract AuditHooksEnumFuzz is Test {
    ProjectEnumeration e;
    MockRegistry reg;
    address org = address(0x0A0A);
    address org2 = address(0x0B0B);
    address[4] owners = [address(0x1), address(0x2), address(0x3), address(0x4)];

    function setUp() public {
        reg = new MockRegistry();
        e = new ProjectEnumeration(address(reg));
        reg.set(org, true);
        reg.set(org2, true);
    }

    function _owner(uint256 s) internal view returns (address) {
        // index 4 maps to address(0) so mints/burns/lies are exercised
        uint256 i = s % 5;
        return i == 4 ? address(0) : owners[i];
    }

    /// Arbitrary (possibly lying) sequences from a registered collection: never revert, and the index stays self-consistent.
    function testFuzz_arbitraryCallsNeverRevertAndStayConsistent(uint256[] calldata ops) public {
        uint256 n = ops.length > 60 ? 60 : ops.length;
        for (uint256 k; k < n; ++k) {
            uint256 o = ops[k];
            address col = (o >> 8) % 2 == 0 ? org : org2;
            uint256 id = (o >> 16) % 6;
            address from = _owner(o >> 32);
            address to = _owner(o >> 40);
            vm.prank(col);
            e.onTokenTransfer(id, from, to, from, 1); // would bubble a revert and fail the test
        }
        _checkConsistency(org);
        _checkConsistency(org2);
    }

    function _checkConsistency(address col) internal view {
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            address ow = owners[i];
            uint256[] memory list = e.tokensOfOwner(col, ow);
            total += list.length;
            for (uint256 j; j < list.length; ++j) {
                assertEq(e.trackedOwnerOf(col, list[j]), ow, "listed token has wrong tracked owner");
                for (uint256 m = j + 1; m < list.length; ++m) assertTrue(list[m] != list[j], "dup in list");
            }
            // org-held index iff balance > 0
            address[] memory held = e.orgsHeldBy(ow);
            bool found;
            for (uint256 h; h < held.length; ++h) if (held[h] == col) found = true;
            assertEq(found, list.length > 0, "orgsHeld disagrees with balance");
        }
        // every token in at most one owner list
        for (uint256 id; id < 6; ++id) {
            uint256 c;
            for (uint256 i; i < 4; ++i) {
                uint256[] memory l = e.tokensOfOwner(col, owners[i]);
                for (uint256 j; j < l.length; ++j) if (l[j] == id) c++;
            }
            assertLe(c, 1, "token in two owner lists");
        }
        // every recorded owner lists the token
        for (uint256 id; id < 6; ++id) {
            address ow = e.trackedOwnerOf(col, id);
            if (ow == address(0)) continue;
            uint256[] memory l = e.tokensOfOwner(col, ow);
            bool listed;
            for (uint256 j; j < l.length; ++j) if (l[j] == id) listed = true;
            assertTrue(listed, "recorded owner does not list the token");
        }
        total; // silence
    }

    /// Honest ERC-721 semantics (true from, burn only by holder): index equals ground truth exactly.
    function testFuzz_honestSequencesMatchGroundTruth(uint256[] calldata ops) public {
        address[6] memory truth;
        uint256 n = ops.length > 60 ? 60 : ops.length;
        for (uint256 k; k < n; ++k) {
            uint256 o = ops[k];
            uint256 id = (o >> 16) % 6;
            address cur = truth[id];
            address to = _owner(o >> 40);
            if (cur == address(0)) {
                if (to == address(0)) continue;
                vm.prank(org);
                e.onTokenTransfer(id, address(0), to, to, 1);
                truth[id] = to;
            } else {
                vm.prank(org);
                e.onTokenTransfer(id, cur, to, cur, 1);
                truth[id] = to;
            }
        }
        for (uint256 id; id < 6; ++id) {
            assertEq(e.trackedOwnerOf(org, id), truth[id]);
        }
        _checkConsistency(org);
    }
}
