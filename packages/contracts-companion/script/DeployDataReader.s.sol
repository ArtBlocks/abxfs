// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {FileDataReader} from "../src/FileDataReader.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {LocalChain} from "@abxfs/core-script/LocalChain.sol";

/// @title DeployDataReader — the optional file-data reader (stored bytes of any codec)
/// @notice Deploys a `FileDataReader` over the existing stores and raw SSTORE2 backend without changing stored content
///         or CIDs. Non-local broadcasts require the source-frozen address pin; source-verify before publishing.
contract DeployDataReader is LocalChain {
    error UnexpectedAddress(address got, address expected);

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("abx-fs/file-data-reader");

    function run() external returns (address reader) {
        (address fileStore, address directoryStore, address sstore2Backend) = stores();
        return runWith(fileStore, directoryStore, sstore2Backend);
    }

    /// @notice Deploy over explicit addresses (what `run` does after reading `stores()`).
    function runWith(address fileStore, address directoryStore, address sstore2Backend)
        public
        returns (address reader)
    {
        require(fileStore.code.length != 0, "no FileStore at that address");
        require(directoryStore.code.length != 0, "no DirectoryStore at that address");
        require(sstore2Backend.code.length != 0, "no Sstore2Backend at that address");
        require(address(IDirectoryStore(directoryStore).fileStore()) == fileStore, "store pair mismatch");
        bytes memory initCode = _initCode(fileStore, directoryStore, sstore2Backend);
        reader = predict(fileStore, directoryStore, sstore2Backend);
        if (!_isLocal()) requirePinned(reader);

        vm.startBroadcast();
        if (reader.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && reader.code.length != 0, "CREATE2 deployment failed");
        }
        vm.stopBroadcast();

        FileDataReader r = FileDataReader(reader);
        require(address(r.fileStore()) == fileStore, "reader wiring");
        require(address(r.directoryStore()) == directoryStore, "reader wiring");
        require(r.sstore2Backend() == sstore2Backend, "reader wiring");
        console2.log("FileDataReader", reader);
    }

    /// @notice Where the pinned build lands over the pinned content layer (`CoreDeploy.pinned()`).
    ///         `test/DeployDataReader.t.sol` fails when the prediction drifts from this, and `runWith` refuses to
    ///         broadcast. The content layer's addresses are constructor arguments, so a re-pinned content layer moves
    ///         this too. Re-pin deliberately, and only before a deployment.
    function pinned() public pure returns (address) {
        return 0x7B724AbEA53398e71C06BE8560ac87cE5DC9c7DC;
    }

    /// @notice Reverts `UnexpectedAddress` unless `reader` is `pinned()`.
    function requirePinned(address reader) public pure {
        if (reader != pinned()) revert UnexpectedAddress(reader, pinned());
    }

    /// @notice `FILE_STORE` / `DIRECTORY_STORE` / `SSTORE2_BACKEND` when set, else the content layer's prediction.
    function stores() public returns (address fileStore, address directoryStore, address sstore2Backend) {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().predict();
        fileStore = vm.envOr("FILE_STORE", core.fileStore);
        directoryStore = vm.envOr("DIRECTORY_STORE", core.directoryStore);
        sstore2Backend = vm.envOr("SSTORE2_BACKEND", core.sstore2Backend);
    }

    /// @notice Where the reader for these addresses lands. A function of the creation code, the addresses and the salt.
    function predict(address fileStore, address directoryStore, address sstore2Backend) public view returns (address) {
        bytes32 h = keccak256(_initCode(fileStore, directoryStore, sstore2Backend));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, h)))));
    }

    function _initCode(address fileStore, address directoryStore, address sstore2Backend)
        internal
        view
        virtual
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(FileDataReader).creationCode, abi.encode(directoryStore, fileStore, sstore2Backend)
        );
    }
}
