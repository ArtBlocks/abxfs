// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrgFactory} from "./interfaces/IOrgFactory.sol";
import {IProjectHook} from "./interfaces/IProjectHook.sol";

interface ILensOrg {
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenParam(uint256 tokenId, bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet);
    function tokenParamData(uint256 tokenId, bytes32 key) external view returns (bytes memory);
}

/// @title Lens
/// @notice Read-only convenience over a factory and its hook: the questions a gateway or crawler asks,
///         each answered in one `eth_call`. It holds no state and no authority, so it can be
///         redeployed or replaced without touching anything an org depends on. Nothing on-chain
///         should call it.
contract Lens {
    bytes32 internal constant _KEY_CID = "abxfs.cid";
    bytes32 internal constant _KEY_GATEWAY = "abxfs.gateway";

    IOrgFactory public immutable factory;
    IProjectHook public immutable hook;

    /// @param registered the factory knows `org`. Everything else is zero when this is false, and
    ///        `org` is never called in that case: an unregistered address is not trusted to answer.
    struct Resolution {
        bool registered;
        IProjectHook.ContentKind kind;
        bytes32 cid;
        address owner;
        bytes gateway;
    }

    struct Published {
        address org;
        IProjectHook.PublishRecord record;
    }

    constructor(address factory_, address hook_) {
        factory = IOrgFactory(factory_);
        hook = IProjectHook(hook_);
    }

    /// @notice Everything a gateway needs to serve project `tokenId` of `org`: whether this factory
    ///         registered the org, the project's kind and current root, its owner, and its `abxfs.gateway`.
    /// @dev Reverts (in `ownerOf`) for a token that does not exist in a registered org.
    function resolve(address org, uint256 tokenId) external view returns (Resolution memory r) {
        if (!factory.isOrg(org)) return r;
        r.registered = true;
        r.kind = hook.kindOf(org, tokenId);
        r.owner = ILensOrg(org).ownerOf(tokenId);
        (bytes32 value, bool valueIsHash, bool isSet) = ILensOrg(org).tokenParam(tokenId, _KEY_CID);
        if (isSet && !valueIsHash) r.cid = value;
        r.gateway = ILensOrg(org).tokenParamData(tokenId, _KEY_GATEWAY);
    }

    /// @notice A window of this hook's cross-org publish ledger, each record resolved. A crawler keeps
    ///         the next index to read and asks from there; `hook.globalPublishCount()` is the end. Clamps at
    ///         the end.
    function publishRange(uint256 start, uint256 count) external view returns (Published[] memory out) {
        (address[] memory orgs, uint256[] memory orgIndexes) = hook.globalPublishRange(start, count);
        out = new Published[](orgs.length);
        for (uint256 i; i < orgs.length; ++i) {
            out[i] = Published({org: orgs[i], record: hook.publishAt(orgs[i], orgIndexes[i])});
        }
    }
}
