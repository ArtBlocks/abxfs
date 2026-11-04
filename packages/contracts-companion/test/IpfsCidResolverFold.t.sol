// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ChunkStore} from "@abxfs/core/ChunkStore.sol";
import {FileStore} from "@abxfs/core/FileStore.sol";
import {DirectoryStore} from "@abxfs/core/DirectoryStore.sol";
import {IpfsCidResolverHarness} from "./mocks/IpfsCidResolverHarness.sol";

/// @notice The balanced-DAG fold at three levels (more than 174^2 = 30,276 blocks, about 7.9 GB of uniform content),
///         over synthetic leaves: `test/fixtures/fold-three-levels.json`, from `generate-fold-three-levels.mjs`.
///
///         Leaf i of case c has the digest sha256(uint256(i) ‖ c) and 262,144 bytes, or for a mixed case 1 + (its first
///         four digest bytes) mod 262,144. Expectations come from `ipfs-unixfs-importer`'s own layout and from an
///         independent fold, which agree wherever the importer's UnixFS encoder is sound. In the mixed three-level
///         cases a level-2 node's filesize falls in [2^31, 2^32), which `ipfs-unixfs` 12 writes as a signed 32-bit
///         varint (not valid protobuf), so there the independent fold is the expectation (`importerUnusable`).
contract IpfsCidResolverFoldTest is Test {
    IpfsCidResolverHarness internal harness;
    string internal json;

    function setUp() public {
        ChunkStore chunks = new ChunkStore();
        FileStore files = new FileStore(address(chunks));
        harness = new IpfsCidResolverHarness(address(files), address(new DirectoryStore(address(files))));
        json = vm.readFile("./test/fixtures/fold-three-levels.json");
    }

    /// Exactly 174^2 leaves: two full levels, the most two levels hold.
    function test_twoFullLevels() public view {
        _case(0, false);
    }

    /// One leaf more: a third level, whose second child is a chain of one-link nodes over the last leaf.
    function test_threeLevels() public view {
        _case(1, false);
    }

    function test_threeLevelsMixedSizes() public view {
        _case(2, true);
    }

    function test_threeLevelsMixedSizesOneChain() public view {
        _case(3, true);
    }

    function test_twoLevelsMixedSizes() public view {
        _case(4, false);
    }

    /// Two leaves: one node, the smallest fold.
    function test_oneNodeMixedSizes() public view {
        _case(5, false);
    }

    function _case(uint256 k, bool importerUnusable) internal view {
        string memory at = string.concat(".[", vm.toString(k), "]");
        assertEq(vm.parseJsonBool(json, string.concat(at, ".importerUnusable")), importerUnusable, "fixture");
        uint256 c = vm.parseJsonUint(json, string.concat(at, ".c"));
        uint256 n = vm.parseJsonUint(json, string.concat(at, ".n"));
        bool mixed = vm.parseJsonBool(json, string.concat(at, ".mixed"));
        bytes32[] memory shas = new bytes32[](n);
        uint256[] memory sizes = new uint256[](n);
        for (uint256 i; i < n; i++) {
            shas[i] = sha256(abi.encodePacked(i, uint8(c)));
            sizes[i] = mixed ? 1 + uint256(uint32(bytes4(shas[i]))) % 262_144 : 262_144;
        }
        (string memory cid,,, uint256 tsize) = harness.foldToRootCid(shas, sizes);
        assertEq(cid, vm.parseJsonString(json, string.concat(at, ".cid")), "root CID");
        assertEq(tsize, vm.parseJsonUint(json, string.concat(at, ".tsize")), "root Tsize");
    }
}
