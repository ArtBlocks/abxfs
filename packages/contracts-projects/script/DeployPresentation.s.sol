// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {LocalChain} from "@abxfs/core-script/LocalChain.sol";
import {PresentationChecks} from "./PresentationChecks.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";

/// @notice Deploy the immutable presentation companion before the new org factory.
///         This does not change any earlier org, content store, or backend.
contract DeployPresentation is LocalChain {
    address internal constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("abx-fs/project-presentation");
    error UnexpectedAddress(address got, address expected);
    error DeploymentFailed();
    error WiringMismatch();

    function run() external returns (address) {
        return runWith(
            vm.envAddress("ABXFS_CONTENT_READER"),
            vm.envAddress("ABXFS_IPFS_CID_RESOLVER"),
            vm.envString("ABXFS_GATEWAY_BASE")
        );
    }

    function predict(address reader, address resolver, string memory gateway) public pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), DEPLOYER, SALT, keccak256(_initCode(reader, resolver, gateway)))
                    )
                )
            )
        );
    }

    function runWith(address reader, address resolver, string memory gateway) public returns (address at) {
        preflight(reader, resolver, gateway);
        at = predict(reader, resolver, gateway);
        // No chain broadcast can use a development build. Qualification supplies the frozen pin.
        if (!_isLocal()) {
            address approved = pinned();
            if (at != approved) revert UnexpectedAddress(at, approved);
        }
        vm.startBroadcast();
        if (at.code.length == 0) {
            (bool ok,) = DEPLOYER.call(abi.encodePacked(SALT, _initCode(reader, resolver, gateway)));
            if (!ok || at.code.length == 0) revert DeploymentFailed();
        }
        vm.stopBroadcast();
        ProjectPresentation p = ProjectPresentation(at);
        if (
            address(p.reader()) != reader || address(p.ipfsResolver()) != resolver
                || keccak256(bytes(p.defaultChainBase())) != keccak256(bytes(gateway))
        ) revert WiringMismatch();
        PresentationChecks.presentation(at, p.directoryStore(), p.fileStore(), gateway);
        console2.log("ProjectPresentation", at);
    }

    function pinned() public pure returns (address) {
        return 0x1C136Aa2E8cD9d46d8242FE69cEDC70835f5fe86;
    }

    function preflight(address reader, address resolver, string memory gateway) public view {
        PresentationChecks.gatewayBase(gateway);
        PresentationChecks.code("ABXFS_CONTENT_READER", reader);
        address directoryStore = PresentationChecks.addressWord(reader, "directoryStore()");
        address fileStore = PresentationChecks.addressWord(reader, "fileStore()");
        PresentationChecks.dependencies(reader, resolver, directoryStore, fileStore);
    }

    function _initCode(address reader, address resolver, string memory gateway) private pure returns (bytes memory) {
        return abi.encodePacked(type(ProjectPresentation).creationCode, abi.encode(reader, resolver, gateway));
    }
}
