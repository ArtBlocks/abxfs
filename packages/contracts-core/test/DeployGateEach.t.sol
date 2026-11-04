// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DriftedDeploy} from "./Deploy.t.sol";

/// Each of the five pins on its own. A drift in one contract is refused naming that contract,
/// and the pins are compared here field by field, not only through the `requirePinned` the gate itself uses.
contract DeployGateEachTest is Test {
    function test_predictedEqualsPinnedFieldByField() public {
        Deploy s = new Deploy();
        Deploy.Addresses memory a = s.predict();
        Deploy.Addresses memory p = s.pinned();
        assertEq(a.chunkStore, p.chunkStore);
        assertEq(a.sstore2Backend, p.sstore2Backend);
        assertEq(a.fastLzSstore2Backend, p.fastLzSstore2Backend);
        assertEq(a.fileStore, p.fileStore);
        assertEq(a.directoryStore, p.directoryStore);
    }

    function test_eachDriftIsRefusedByName() public {
        string[5] memory names = ["ChunkStore", "Sstore2Backend", "FastLzSstore2Backend", "FileStore", "DirectoryStore"];
        vm.chainId(8453);
        for (uint256 c; c < 5; c++) {
            Deploy d = new DriftedDeploy(Deploy.Contract(c), false);
            Deploy.Addresses memory a = d.predict();
            address[5] memory got = [a.chunkStore, a.sstore2Backend, a.fastLzSstore2Backend, a.fileStore, a.directoryStore];
            Deploy.Addresses memory p = d.pinned();
            address[5] memory want = [p.chunkStore, p.sstore2Backend, p.fastLzSstore2Backend, p.fileStore, p.directoryStore];
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnexpectedAddress.selector, names[c], got[c], want[c]));
            d.run();
        }
    }
}
