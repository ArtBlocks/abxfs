// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Shared pre-broadcast checks for the independently deployed presentation and its dependencies.
library PresentationChecks {
    error BadGatewayBase(string reason);
    error MissingAddress(string name);
    error NoCode(string name, address at);
    error WiringMismatch(string what);
    error ProbeFailed(string what, address at);

    function gatewayBase(string memory base) internal pure {
        bytes memory b = bytes(base);
        if (b.length > 128) revert BadGatewayBase("longer than 128 bytes");
        if (b.length < 9) revert BadGatewayBase("must be https:// followed by a host");
        bytes memory scheme = "https://";
        for (uint256 i; i < 8; ++i) {
            if (b[i] != scheme[i]) revert BadGatewayBase("must start with https://");
        }
        if (b[8] == "/") revert BadGatewayBase("empty host");
        if (b[b.length - 1] == "/") revert BadGatewayBase("trailing slash");
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c <= 0x20 || c >= 0x7f) revert BadGatewayBase("whitespace, control or non-ASCII byte");
            if (
                c == 0x22 || c == 0x26 || c == 0x27 || c == 0x28 || c == 0x29 || c == 0x3c || c == 0x3e || c == 0x5b
                    || c == 0x5c || c == 0x5d || c == 0x5e || c == 0x60 || c == 0x7b || c == 0x7c || c == 0x7d
            ) {
                revert BadGatewayBase("character that breaks JSON or markup");
            }
        }
    }

    function code(string memory name, address at) internal view {
        if (at == address(0)) revert MissingAddress(name);
        if (at.code.length == 0) revert NoCode(name, at);
    }

    function addressWord(address at, string memory getter) internal view returns (address value) {
        (bool ok, bytes memory ret) = at.staticcall(abi.encodeWithSignature(getter));
        uint256 word;
        if (ret.length == 32) assembly { word := mload(add(ret, 32)) }
        if (!ok || ret.length != 32 || word == 0 || word >> 160 != 0) revert ProbeFailed(getter, at);
        value = address(uint160(word));
    }

    function stores(address at, address directoryStore, address fileStore, string memory name) internal view {
        if (addressWord(at, "directoryStore()") != directoryStore) {
            revert WiringMismatch(string.concat(name, ".directoryStore"));
        }
        if (addressWord(at, "fileStore()") != fileStore) revert WiringMismatch(string.concat(name, ".fileStore"));
    }

    function dependencies(address reader, address resolver, address directoryStore, address fileStore) internal view {
        code("ABXFS_CONTENT_READER", reader);
        code("ABXFS_IPFS_CID_RESOLVER", resolver);
        code("ABXFS_DIRECTORY_STORE", directoryStore);
        code("ABXFS_FILE_STORE", fileStore);
        stores(reader, directoryStore, fileStore, "reader");
        stores(resolver, directoryStore, fileStore, "resolver");
    }

    function presentation(address at, address directoryStore, address fileStore, string memory gateway) internal view {
        code("ABXFS_PRESENTATION", at);
        stores(at, directoryStore, fileStore, "presentation");
        (bool versionOk, bytes memory versionData) = at.staticcall(abi.encodeWithSignature("presentationVersion()"));
        if (!versionOk || versionData.length != 32 || abi.decode(versionData, (uint256)) != 2) {
            revert ProbeFailed("presentationVersion()", at);
        }
        address reader = addressWord(at, "reader()");
        address resolver = addressWord(at, "ipfsResolver()");
        dependencies(reader, resolver, directoryStore, fileStore);
        (bool ok, bytes memory ret) = at.staticcall(abi.encodeWithSignature("defaultChainBase()"));
        if (!ok || ret.length < 64) revert ProbeFailed("defaultChainBase()", at);
        uint256 offset;
        uint256 length;
        assembly {
            offset := mload(add(ret, 32))
            length := mload(add(ret, 64))
        }
        if (offset != 32 || length > 128 || length > ret.length - 64) revert ProbeFailed("defaultChainBase()", at);
        bytes32 actual;
        assembly { actual := keccak256(add(ret, 96), length) }
        if (actual != keccak256(bytes(gateway))) revert WiringMismatch("presentation.defaultChainBase");
    }
}
