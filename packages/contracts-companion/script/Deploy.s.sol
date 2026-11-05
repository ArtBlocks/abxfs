// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";
import {LocalChain} from "@abxfs/core-script/LocalChain.sol";

/// @title Deploy — the ABX FS IPFS CID resolver (see `specs/abx-fs.md` §8)
/// @notice One `IpfsCidResolver` over the content layer's `FileStore` and `DirectoryStore`, through Foundry's keyless
///         CREATE2 deployer with a fixed salt. Its only constructor arguments are the two store addresses, which are
///         the same on every chain, so any key deploys it at the same address everywhere; re-running is a no-op.
///         On any chain but a local one (whose RPC answers 31337), nothing is broadcast unless the resolver lands at
///         `pinned()`: a changed source, library, remapping or store address is refused rather than deployed.
///
/// @dev    The store addresses default to the content layer's prediction from contracts-core's own build
///         (`DeployFromArtifacts`, which reads `../contracts-core/out`: build contracts-core first);
///         `FILE_STORE` / `DIRECTORY_STORE` override it. Either way the resolver's constructor
///         refuses a directory store that is not bound to the file store, and the script refuses addresses with no code.
///
///         The resolver is a companion, not part of the protocol: no contract stores its address and the SDK takes it
///         as optional configuration, so a successor (for example one that derives HAMT-sharded directories) is a new
///         contract at a new address, with no other redeploy.
contract Deploy is LocalChain {
    error UnexpectedAddress(address got, address expected);

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("abx-fs/ipfs-cid-resolver");

    function run() external returns (address resolver) {
        (address fileStore, address directoryStore) = stores();
        return runWith(fileStore, directoryStore);
    }

    /// @notice Deploy over explicit store addresses (what `run` does after reading `stores()`).
    function runWith(address fileStore, address directoryStore) public returns (address resolver) {
        require(fileStore.code.length != 0, "no FileStore at that address");
        require(directoryStore.code.length != 0, "no DirectoryStore at that address");
        bytes memory initCode = _initCode(fileStore, directoryStore);
        resolver = predict(fileStore, directoryStore);
        if (!_isLocal()) requirePinned(resolver);

        vm.startBroadcast();
        if (resolver.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && resolver.code.length != 0, "CREATE2 deployment failed");
        }
        vm.stopBroadcast();

        require(address(IpfsCidResolver(resolver).fileStore()) == fileStore, "resolver wiring");
        require(address(IpfsCidResolver(resolver).directoryStore()) == directoryStore, "resolver wiring");
        console2.log("IpfsCidResolver", resolver);
    }

    /// @notice Where the pinned build lands over the pinned content layer (`CoreDeploy.pinned()`).
    ///         `test/DeployPin.t.sol` fails when the prediction drifts from this, and `runWith` refuses to broadcast.
    ///         The content layer's addresses are constructor arguments, so a re-pinned content layer moves this too.
    ///         Re-pin deliberately, and only before a deployment.
    function pinned() public pure returns (address) {
        return 0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d;
    }

    /// @notice Reverts `UnexpectedAddress` unless `resolver` is `pinned()`.
    function requirePinned(address resolver) public pure {
        if (resolver != pinned()) revert UnexpectedAddress(resolver, pinned());
    }

    /// @notice The store addresses: `FILE_STORE` / `DIRECTORY_STORE` when set, else the content layer's prediction.
    function stores() public returns (address fileStore, address directoryStore) {
        CoreDeploy.Addresses memory core = new DeployFromArtifacts().predict();
        fileStore = vm.envOr("FILE_STORE", core.fileStore);
        directoryStore = vm.envOr("DIRECTORY_STORE", core.directoryStore);
    }

    /// @notice Where the resolver for these stores lands. A function of the creation code, the stores and the salt.
    function predict(address fileStore, address directoryStore) public view returns (address) {
        bytes32 h = keccak256(_initCode(fileStore, directoryStore));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, h)))));
    }

    function _initCode(address fileStore, address directoryStore) internal view virtual returns (bytes memory) {
        return abi.encodePacked(type(IpfsCidResolver).creationCode, abi.encode(fileStore, directoryStore));
    }
}
