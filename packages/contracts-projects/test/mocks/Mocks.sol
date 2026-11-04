// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAbxConfigureHook} from "../../src/interfaces/IAbxConfigureHook.sol";

/// @dev Minimal `directoryExists` / `fileExists` stands-in. The hook's entire contract with the
///      stores is those two predicates, so a set-membership mock exercises it faithfully; the real
///      store behavior is covered by contracts-core's own suite. Deliberately does NOT inherit
///      `IDirectoryStore`/`IFileStore` — implementing ~10 unused functions would add surface without
///      adding coverage, and the hook only ever holds an address cast.
contract MockStore {
    mapping(bytes32 => bool) public has;

    function add(bytes32 cid) external {
        has[cid] = true;
    }

    function directoryExists(bytes32 cid) external view returns (bool) {
        return has[cid];
    }

    function fileExists(bytes32 cid) external view returns (bool) {
        return has[cid];
    }
}

/// @dev Stands in for an ABX collection: drives the hook as the token would, and answers the
///      `IAbxParams` + `ownerOf` reads the card makes. `msg.sender` seen by the hook is this
///      contract, which is what the hook's per-collection namespacing keys on.
contract MockAbxToken {
    struct Param {
        bytes32 value;
        bool valueIsHash;
        bool isSet;
    }

    IAbxConfigureHook public hook;
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => mapping(bytes32 => Param)) internal _tokenParams;
    mapping(uint256 => mapping(bytes32 => bytes)) internal _tokenData;

    constructor(address hook_) {
        hook = IAbxConfigureHook(hook_);
    }

    function setOwner(uint256 tokenId, address owner) external {
        _owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "nonexistent token");
        return o;
    }

    /// @dev Mirrors ABX's governed write order: call the hook FIRST (it may veto), then persist.
    function configure(uint256 tokenId, bytes32 key, bytes32 value) external {
        hook.onParamConfigured(tokenId, key, value, msg.sender, 0, address(0));
        _tokenParams[tokenId][key] = Param({value: value, valueIsHash: false, isSet: true});
    }

    /// @dev The `String`/`Bytes` path: the evented bytes32 is a keccak commitment, and `dataLength`
    ///      carries the payload size the hook polices.
    function configureData(uint256 tokenId, bytes32 key, bytes calldata payload) external {
        hook.onParamConfigured(
            tokenId, key, keccak256(payload), msg.sender, payload.length, address(this)
        );
        _tokenParams[tokenId][key] =
            Param({value: keccak256(payload), valueIsHash: true, isSet: true});
        _tokenData[tokenId][key] = payload;
    }

    function tokenParam(uint256 tokenId, bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet)
    {
        Param storage p = _tokenParams[tokenId][key];
        return (p.value, p.valueIsHash, p.isSet);
    }

    function contractParam(bytes32) external pure returns (bytes32, bool, bool) {
        return (bytes32(0), false, false);
    }

    function tokenParamData(uint256 tokenId, bytes32 key) external view returns (bytes memory) {
        return _tokenData[tokenId][key];
    }

    function contractParamData(bytes32) external pure returns (bytes memory) {
        return "";
    }

    /// @dev Escape hatch for the card's "name was written without the hook armed" case.
    function forceData(uint256 tokenId, bytes32 key, bytes calldata payload) external {
        _tokenData[tokenId][key] = payload;
    }

    function forceParam(uint256 tokenId, bytes32 key, bytes32 value, bool valueIsHash) external {
        _tokenParams[tokenId][key] = Param({value: value, valueIsHash: valueIsHash, isSet: true});
    }
}

/// @dev A collection whose every param read reverts. The card must still render — invariant #1 says
///      a revert inside the renderer bricks the whole `tokenURI`, so a hostile or half-deployed
///      token must not be able to reach that.
contract RevertingAbxToken {
    function tokenParam(uint256, bytes32) external pure returns (bytes32, bool, bool) {
        revert("nope");
    }

    function tokenParamData(uint256, bytes32) external pure returns (bytes memory) {
        revert("nope");
    }

    function ownerOf(uint256) external pure returns (address) {
        revert("nope");
    }
}
