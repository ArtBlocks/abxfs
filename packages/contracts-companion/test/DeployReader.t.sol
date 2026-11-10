// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployReader} from "../script/DeployReader.s.sol";
import {ContentReader} from "../src/ContentReader.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";

contract DeployReaderTest is Test {
    bytes32 constant CREATION_CODE_HASH = 0x3428109e8162b70e16ba3da92215196527056f9d56c37f03e45780309a95c3cd;

    function test_readerCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(ContentReader).creationCode), CREATION_CODE_HASH);
    }

    function test_readerPredictionIsPinnedOverTheOriginalStores() public {
        DeployReader script = new DeployReader();
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        assertEq(script.predict(core.fileStore, core.directoryStore), script.pinned());
    }

    function test_readerDeploysAndReusesPinnedAddressOffLocal() public {
        vm.chainId(8453);
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DeployReader script = new DeployReader();
        address at = script.runWith(core.fileStore, core.directoryStore);
        assertEq(at, script.pinned());
        assertEq(address(ContentReader(at).fileStore()), core.fileStore);
        assertEq(address(ContentReader(at).directoryStore()), core.directoryStore);
        assertEq(script.runWith(core.fileStore, core.directoryStore), at);
    }

    function test_readerDeployFitsInitcodeRuntimeAndGasBounds() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        bytes memory initCode =
            abi.encodePacked(type(ContentReader).creationCode, abi.encode(core.directoryStore, core.fileStore));
        assertLt(initCode.length, 49_152);
        vm.startStateDiffRecording();
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = address(0x4e59b44847b379578588920cA78FbF26c0B4956C)
            .call(abi.encodePacked(keccak256("reader-deploy-gas"), initCode));
        uint256 used = beforeGas - gasleft();
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 codeBytes;
        uint256 accounts;
        for (uint256 i; i < accesses.length; ++i) {
            if (!accesses[i].reverted && accesses[i].kind == VmSafe.AccountAccessKind.Create) {
                ++accounts;
                codeBytes += accesses[i].deployedCode.length;
            }
            for (uint256 j; j < accesses[i].storageAccesses.length; ++j) {
                assertFalse(accesses[i].storageAccesses[j].isWrite, "immutable reader unexpectedly writes storage");
            }
        }
        assertEq(accounts, 1);
        require(ok && ret.length == 20, "reader deploy failed");
        address at = address(bytes20(ret));
        assertLt(at.code.length, 24_576);
        uint256 total = vm.lastCallGas().gasTotalUsed;
        if (total < used) total = used;
        // Same two-dimensional schedule used by the projects package's GasModel: this immutable
        // reader creates one account and code, with no zero-to-nonzero storage writes.
        uint256 execution8037 = total - (accounts * 32_000 + codeBytes * 200) + accounts * 12_000;
        uint256 state8037 = accounts * 183_600 + codeBytes * 1530;
        emit log_named_uint("reader legacy total", total);
        emit log_named_uint("reader 8037 execution", execution8037);
        emit log_named_uint("reader 8037 state", state8037);
        assertLt(total, 16_777_216);
        assertLt(execution8037, 16_777_216);
        assertLt(execution8037 + state8037, 60_000_000);
    }

    function test_readerRefusesMissingOrMismatchedStorePairBeforeDeploy() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DeployReader script = new DeployReader();
        vm.expectRevert("no FileStore at that address");
        script.runWith(address(0), core.directoryStore);
        vm.expectRevert("no DirectoryStore at that address");
        script.runWith(core.fileStore, address(0));
        vm.expectRevert("store pair mismatch");
        script.runWith(core.chunkStore, core.directoryStore);
    }

    function test_readerRefusesUnpinnedBuildOffLocal() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DriftedReaderDeploy script = new DriftedReaderDeploy();
        vm.chainId(8453);
        address at = script.predict(core.fileStore, core.directoryStore);
        address pin = script.pinned();
        vm.expectRevert(abi.encodeWithSelector(DeployReader.UnexpectedAddress.selector, at, pin));
        script.runWith(core.fileStore, core.directoryStore);
        assertEq(at.code.length, 0);
    }
}

contract DriftedReaderDeploy is DeployReader {
    function _initCode(address fileStore, address directoryStore) internal view override returns (bytes memory) {
        return bytes.concat(super._initCode(fileStore, directoryStore), hex"00");
    }
}
