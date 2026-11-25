// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployDataReader} from "../script/DeployDataReader.s.sol";
import {FileDataReader} from "../src/FileDataReader.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";

/// @dev Pins the file-data reader's creation code and its predicted address over the pinned content layer, as
///      `DeployReader.t.sol` does for `ContentReader`. Its constructor arguments are the two stores and the raw SSTORE2
///      backend, so a re-pinned content layer moves the address too. Re-pin deliberately, and only before a deployment.
contract DeployDataReaderTest is Test {
    bytes32 constant CREATION_CODE_HASH = 0x68df31a65b1c9e6feb0abbba9c2d0c28c9950204113890ad69aa22e0823599a8;

    function test_dataReaderCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(FileDataReader).creationCode), CREATION_CODE_HASH);
    }

    function test_dataReaderPredictionIsPinnedOverTheOriginalStores() public {
        DeployDataReader script = new DeployDataReader();
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        assertEq(script.predict(core.fileStore, core.directoryStore, core.sstore2Backend), script.pinned());
    }

    function test_defaultStoresAreThePinnedOnes() public {
        (address f, address d, address b) = new DeployDataReader().stores();
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        assertEq(f, core.fileStore);
        assertEq(d, core.directoryStore);
        assertEq(b, core.sstore2Backend);
    }

    function test_dataReaderDeploysAndReusesPinnedAddressOffLocal() public {
        vm.chainId(8453);
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DeployDataReader script = new DeployDataReader();
        address at = script.runWith(core.fileStore, core.directoryStore, core.sstore2Backend);
        assertEq(at, script.pinned());
        FileDataReader r = FileDataReader(at);
        assertEq(address(r.fileStore()), core.fileStore);
        assertEq(address(r.directoryStore()), core.directoryStore);
        assertEq(address(r.chunkStore()), core.chunkStore);
        assertEq(r.sstore2Backend(), core.sstore2Backend);
        assertEq(script.runWith(core.fileStore, core.directoryStore, core.sstore2Backend), at);
    }

    function test_dataReaderDeployFitsInitcodeRuntimeAndGasBounds() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        bytes memory initCode = abi.encodePacked(
            type(FileDataReader).creationCode, abi.encode(core.directoryStore, core.fileStore, core.sstore2Backend)
        );
        assertLt(initCode.length, 49_152);
        vm.startStateDiffRecording();
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = address(0x4e59b44847b379578588920cA78FbF26c0B4956C)
            .call(abi.encodePacked(keccak256("data-reader-deploy-gas"), initCode));
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
        // The same two-dimensional schedule as `DeployReader.t.sol`: one account and its code, no storage writes.
        uint256 execution8037 = total - (accounts * 32_000 + codeBytes * 200) + accounts * 12_000;
        uint256 state8037 = accounts * 183_600 + codeBytes * 1530;
        emit log_named_uint("data reader legacy total", total);
        emit log_named_uint("data reader 8037 execution", execution8037);
        emit log_named_uint("data reader 8037 state", state8037);
        assertLt(total, 16_777_216);
        assertLt(execution8037, 16_777_216);
        assertLt(execution8037 + state8037, 60_000_000);
    }

    function test_dataReaderRefusesMissingOrMismatchedAddressesBeforeDeploy() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DeployDataReader script = new DeployDataReader();
        vm.expectRevert("no FileStore at that address");
        script.runWith(address(0), core.directoryStore, core.sstore2Backend);
        vm.expectRevert("no DirectoryStore at that address");
        script.runWith(core.fileStore, address(0), core.sstore2Backend);
        vm.expectRevert("no Sstore2Backend at that address");
        script.runWith(core.fileStore, core.directoryStore, address(0));
        vm.expectRevert("store pair mismatch");
        script.runWith(core.chunkStore, core.directoryStore, core.sstore2Backend);
    }

    function test_dataReaderRefusesUnpinnedBuildOffLocal() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DriftedDataReaderDeploy script = new DriftedDataReaderDeploy();
        vm.chainId(8453);
        address at = script.predict(core.fileStore, core.directoryStore, core.sstore2Backend);
        address pin = script.pinned();
        vm.expectRevert(abi.encodeWithSelector(DeployDataReader.UnexpectedAddress.selector, at, pin));
        script.runWith(core.fileStore, core.directoryStore, core.sstore2Backend);
        assertEq(at.code.length, 0);
    }

    /// Another raw backend is another constructor argument, so another address: refused off a local chain.
    function test_dataReaderOverAnotherBackendIsRefusedOffLocal() public {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().run();
        DeployDataReader script = new DeployDataReader();
        vm.chainId(8453);
        address at = script.predict(core.fileStore, core.directoryStore, core.fastLzSstore2Backend);
        vm.expectRevert(abi.encodeWithSelector(DeployDataReader.UnexpectedAddress.selector, at, script.pinned()));
        script.runWith(core.fileStore, core.directoryStore, core.fastLzSstore2Backend);
    }
}

contract DriftedDataReaderDeploy is DeployDataReader {
    function _initCode(address fileStore, address directoryStore, address sstore2Backend)
        internal
        view
        override
        returns (bytes memory)
    {
        return bytes.concat(super._initCode(fileStore, directoryStore, sstore2Backend), hex"00");
    }
}
