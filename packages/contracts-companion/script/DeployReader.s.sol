// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {ContentReader} from "../src/ContentReader.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {LocalChain} from "@abxfs/core-script/LocalChain.sol";

/// @title DeployReader — the optional native ABX FS content reader
/// @notice Deploys a reader over the existing stores without changing stored content or CIDs.
///         Non-local broadcasts require the source-frozen address pin; source-verify before publishing.
contract DeployReader is LocalChain {
    error UnexpectedAddress(address got, address expected);

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("abx-fs/content-reader");

    function run() external returns (address reader) {
        (address fileStore, address directoryStore) = stores();
        return runWith(fileStore, directoryStore);
    }

    /// @notice Deploy over explicit store addresses (what `run` does after reading `stores()`).
    function runWith(address fileStore, address directoryStore) public returns (address reader) {
        require(fileStore.code.length != 0, "no FileStore at that address");
        require(directoryStore.code.length != 0, "no DirectoryStore at that address");
        require(address(IDirectoryStore(directoryStore).fileStore()) == fileStore, "store pair mismatch");
        bytes memory initCode = _initCode(fileStore, directoryStore);
        reader = predict(fileStore, directoryStore);
        if (!_isLocal()) requirePinned(reader);

        vm.startBroadcast();
        if (reader.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && reader.code.length != 0, "CREATE2 deployment failed");
        }
        vm.stopBroadcast();

        require(address(ContentReader(reader).fileStore()) == fileStore, "reader wiring");
        require(address(ContentReader(reader).directoryStore()) == directoryStore, "reader wiring");
        console2.log("ContentReader", reader);
    }

    /// @notice Where the pinned build lands over the pinned content layer (`CoreDeploy.pinned()`).
    ///         `test/DeployReader.t.sol` fails when the prediction drifts from this, and `runWith` refuses to broadcast.
    ///         The content layer's addresses are constructor arguments, so a re-pinned content layer moves this too.
    ///         Re-pin deliberately, and only before a deployment.
    function pinned() public pure returns (address) {
        return 0xe6d62620A284565B7F0B3581A6972BA3Be5C8B13;
    }

    /// @notice Reverts `UnexpectedAddress` unless `reader` is `pinned()`.
    function requirePinned(address reader) public pure {
        if (reader != pinned()) revert UnexpectedAddress(reader, pinned());
    }

    /// @notice The store addresses: `FILE_STORE` / `DIRECTORY_STORE` when set, else the content layer's prediction.
    function stores() public returns (address fileStore, address directoryStore) {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().predict();
        fileStore = vm.envOr("FILE_STORE", core.fileStore);
        directoryStore = vm.envOr("DIRECTORY_STORE", core.directoryStore);
    }

    /// @notice Where the reader for these stores lands. A function of the creation code, the stores and the salt.
    function predict(address fileStore, address directoryStore) public view returns (address) {
        bytes32 h = keccak256(_initCode(fileStore, directoryStore));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, h)))));
    }

    function _initCode(address fileStore, address directoryStore) internal view virtual returns (bytes memory) {
        return abi.encodePacked(type(ContentReader).creationCode, abi.encode(directoryStore, fileStore));
    }
}
