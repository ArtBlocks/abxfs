// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {LocalChain} from "./LocalChain.sol";

import {ChunkStore} from "../src/ChunkStore.sol";
import {FileStore} from "../src/FileStore.sol";
import {DirectoryStore} from "../src/DirectoryStore.sol";
import {Sstore2Backend} from "../src/backends/Sstore2Backend.sol";
import {FastLzSstore2Backend} from "../src/backends/FastLzSstore2Backend.sol";

/// @title Deploy — the ABX FS content layer (see `specs/abx-fs.md`)
/// @notice ChunkStore, the two launch backends, FileStore and DirectoryStore, through Foundry's keyless CREATE2
///         deployer with one fixed salt. No constructor argument depends on the sender, so any key deploys every
///         contract at the same address on every chain, and re-running on a chain that has them is a no-op.
///         On any chain but a local one (whose RPC answers 31337), nothing is broadcast unless every predicted
///         address is the pinned one (`pinned()`): a changed source, library or remapping is refused rather than
///         deployed.
contract Deploy is LocalChain {
    error UnexpectedAddress(string name, address got, address expected);

    /// @dev Foundry's CREATE2 deployer (the keyless deterministic deployment proxy).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("abx-fs/content");

    struct Addresses {
        address chunkStore;
        address sstore2Backend;
        address fastLzSstore2Backend;
        address fileStore;
        address directoryStore;
    }

    /// @dev The contracts, in deployment order.
    enum Contract {
        ChunkStore,
        Sstore2Backend,
        FastLzSstore2Backend,
        FileStore,
        DirectoryStore
    }

    function run() external returns (Addresses memory a) {
        a = predict();
        if (!_isLocal()) requirePinned(a);
        vm.startBroadcast();
        _deploy(_creationCode(Contract.ChunkStore), a.chunkStore);
        _deploy(_creationCode(Contract.Sstore2Backend), a.sstore2Backend);
        _deploy(_creationCode(Contract.FastLzSstore2Backend), a.fastLzSstore2Backend);
        _deploy(abi.encodePacked(_creationCode(Contract.FileStore), abi.encode(a.chunkStore)), a.fileStore);
        _deploy(abi.encodePacked(_creationCode(Contract.DirectoryStore), abi.encode(a.fileStore)), a.directoryStore);
        vm.stopBroadcast();

        require(address(FileStore(a.fileStore).chunkStore()) == a.chunkStore, "file store wiring");
        require(address(DirectoryStore(a.directoryStore).fileStore()) == a.fileStore, "directory store wiring");

        console2.log("ChunkStore", a.chunkStore);
        console2.log("Sstore2Backend", a.sstore2Backend);
        console2.log("FastLzSstore2Backend", a.fastLzSstore2Backend);
        console2.log("FileStore", a.fileStore);
        console2.log("DirectoryStore", a.directoryStore);
    }

    /// @notice Where the build under audit lands. `test/Deploy.t.sol` fails when `predict()` drifts from this, and
    ///         `run` refuses to broadcast. Re-pin deliberately, and only before a deployment.
    function pinned() public pure returns (Addresses memory a) {
        a.chunkStore = 0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc;
        a.sstore2Backend = 0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844;
        a.fastLzSstore2Backend = 0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1;
        a.fileStore = 0x8b6077a1d6953D96687005B9408D56A655b4d155;
        a.directoryStore = 0x4273E4E078F47303Ca15b11959eeb61F3FC94c11;
    }

    /// @notice Reverts `UnexpectedAddress` unless `a` is `pinned()`.
    function requirePinned(Addresses memory a) public pure {
        Addresses memory p = pinned();
        _same("ChunkStore", a.chunkStore, p.chunkStore);
        _same("Sstore2Backend", a.sstore2Backend, p.sstore2Backend);
        _same("FastLzSstore2Backend", a.fastLzSstore2Backend, p.fastLzSstore2Backend);
        _same("FileStore", a.fileStore, p.fileStore);
        _same("DirectoryStore", a.directoryStore, p.directoryStore);
    }

    function _same(string memory name, address got, address want) internal pure {
        if (got != want) revert UnexpectedAddress(name, got, want);
    }

    /// @notice Where every contract lands. A function of the creation code and the salt only.
    function predict() public view returns (Addresses memory a) {
        a.chunkStore = _at(_creationCode(Contract.ChunkStore));
        a.sstore2Backend = _at(_creationCode(Contract.Sstore2Backend));
        a.fastLzSstore2Backend = _at(_creationCode(Contract.FastLzSstore2Backend));
        a.fileStore = _at(abi.encodePacked(_creationCode(Contract.FileStore), abi.encode(a.chunkStore)));
        a.directoryStore = _at(abi.encodePacked(_creationCode(Contract.DirectoryStore), abi.encode(a.fileStore)));
    }

    /// @dev This project's own build of each contract, constructor arguments excluded. Another Foundry project that
    ///      imports this script compiles these sources itself, with its own source paths and remappings in each
    ///      contract's metadata hash, so its `type(X).creationCode` is not the canonical code: it uses
    ///      `DeployFromArtifacts`, which overrides this.
    function _creationCode(Contract c) internal view virtual returns (bytes memory) {
        if (c == Contract.ChunkStore) return type(ChunkStore).creationCode;
        if (c == Contract.Sstore2Backend) return type(Sstore2Backend).creationCode;
        if (c == Contract.FastLzSstore2Backend) return type(FastLzSstore2Backend).creationCode;
        if (c == Contract.FileStore) return type(FileStore).creationCode;
        return type(DirectoryStore).creationCode;
    }

    function _at(bytes memory initCode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, keccak256(initCode)))))
        );
    }

    function _deploy(bytes memory initCode, address expected) internal {
        if (expected.code.length != 0) return;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        require(ok && expected.code.length != 0, "CREATE2 deployment failed");
    }
}
