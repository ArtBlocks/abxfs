// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAbxOrgCollection} from "./interfaces/IAbxOrgDeploy.sol";
import {IOrgFactory} from "./interfaces/IOrgFactory.sol";

/// @title OrgMinter
/// @notice The minter every org is deployed with. ABX's reference minter authorizes configuration
///         through the collection's `owner()`, which is `address(0)` once an org is renounced, so
///         this one asks the factory instead (`mayMint`): the factory itself, the org's admin, or
///         anyone at all if the org is open; never for an address the factory did not register.
///
/// @dev    No state of its own, no owner, no price. All policy lives in the factory, so changing who
///         may mint never needs a change here. One of the factory's components: the factory computes
///         this contract's CREATE2 address from its creation code and the factory's own address, so
///         `factory` is an immutable with no deploy-order cycle and no initializer.
contract OrgMinter {
    error NotAllowed(address org, address caller);

    IOrgFactory public immutable factory;

    constructor(address factory_) {
        factory = IOrgFactory(factory_);
    }

    /// @notice Mint the next project in `org` to `to`. `to` becomes its owner. Reverts `NotAllowed` unless
    ///         the factory's `mayMint(org, msg.sender)`.
    function mint(address org, address to) external returns (uint256 tokenId) {
        if (!factory.mayMint(org, msg.sender)) revert NotAllowed(org, msg.sender);
        return IAbxOrgCollection(org).mint(to);
    }
}
