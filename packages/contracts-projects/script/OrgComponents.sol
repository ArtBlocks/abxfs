// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrgFactory} from "../src/OrgFactory.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {OrgMeta} from "../src/OrgMeta.sol";

/// @title OrgComponents — deploy the five components an `OrgFactory` names
/// @notice The factory computes where its hook, enumeration hook, minter, card and traits renderer will be and leaves
///         deploying them to anyone (see `OrgFactory`). This deploys each through the keyless CREATE2 deployer with the
///         factory's `COMPONENT_SALT` and the constructor arguments the factory used, skips any that already exist, and
///         checks each lands where the factory said. Used by the deploy script and by tests.
library OrgComponents {
    error ComponentDeployFailed(string name, address expected);

    /// @notice Deploy `factory`'s components. `directoryStore` and `fileStore` are the stores the factory was built with.
    function deploy(OrgFactory factory, address directoryStore, address fileStore) internal {
        address f = address(factory);
        address hook = address(factory.hook());
        bytes32 salt = factory.COMPONENT_SALT();
        address deployer = factory.CREATE2_DEPLOYER();
        _deploy(
            deployer,
            salt,
            "hook",
            abi.encodePacked(type(ProjectHook).creationCode, abi.encode(directoryStore, fileStore, f)),
            hook
        );
        _deploy(
            deployer,
            salt,
            "enumeration",
            abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(f)),
            address(factory.enumeration())
        );
        _deploy(deployer, salt, "minter", abi.encodePacked(type(OrgMinter).creationCode, abi.encode(f)), address(factory.minter()));
        _deploy(deployer, salt, "card", abi.encodePacked(type(ProjectCard).creationCode, abi.encode(hook)), address(factory.card()));
        _deploy(
            deployer, salt, "traits", abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(hook)), address(factory.traits())
        );
    }

    /// @notice A factory with its components deployed: what every org needs before `createOrg`.
    function create(address abx, address renderer, address seed, address directoryStore, address fileStore, address orgMeta)
        internal
        returns (OrgFactory factory)
    {
        return create(abx, renderer, seed, directoryStore, fileStore, orgMeta, address(OrgMeta(orgMeta).links()));
    }

    /// @notice Construct a factory with an explicit, already deployed animation renderer.
    function create(
        address abx, address renderer, address seed, address directoryStore, address fileStore,
        address orgMeta, address presentation
    ) internal returns (OrgFactory factory) {
        factory = new OrgFactory(abx, renderer, seed, directoryStore, fileStore, orgMeta, presentation);
        deploy(factory, directoryStore, fileStore);
    }

    function _deploy(address deployer, bytes32 salt, string memory name, bytes memory initCode, address expected) private {
        if (expected.code.length != 0) return;
        (bool ok,) = deployer.call(abi.encodePacked(salt, initCode));
        if (!ok || expected.code.length == 0) revert ComponentDeployFailed(name, expected);
    }
}
