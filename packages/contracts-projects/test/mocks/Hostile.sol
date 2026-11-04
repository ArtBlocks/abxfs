// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A callee whose answer to each selector is scripted: the raw returndata verbatim (no ABI wrapping, so a test
///      can hand back any length or any malformed shape), a revert, or, by default, an empty success, which is what a
///      `staticcall` to an address with no code looks like. Used as the "token" or the "hook" behind a renderer, or as
///      the "factory" behind a hook, to drive the hostile inputs the never-revert paths promise to survive.
contract RawStub {
    mapping(bytes4 => bytes) internal _data;
    mapping(bytes4 => bool) internal _reverts;
    mapping(bytes4 => bytes) internal _revertData;

    /// @dev Answer `sel` with exactly these bytes (an empty `data` is an empty success).
    function ret(bytes4 sel, bytes calldata data) external {
        _data[sel] = data;
        _reverts[sel] = false;
    }

    /// @dev Make `sel` revert with `Error("RawStub")`.
    function boom(bytes4 sel) external {
        _reverts[sel] = true;
        delete _revertData[sel];
    }

    /// @dev Make `sel` revert with exactly these bytes as its revert data. A reader that decoded the data of a failed
    ///      call as though it were an answer would take well formed bytes here for a value.
    function boomWith(bytes4 sel, bytes calldata revertData) external {
        _reverts[sel] = true;
        _revertData[sel] = revertData;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        if (_reverts[msg.sig]) {
            bytes memory r = _revertData[msg.sig];
            if (r.length == 0) revert("RawStub");
            assembly {
                revert(add(r, 0x20), mload(r))
            }
        }
        return _data[msg.sig];
    }
}

/// @dev Burns every unit of gas it is given.
contract GasBurner {
    fallback() external {
        uint256 x;
        while (true) {
            ++x;
        }
    }
}

/// @dev Answers every call with `size` bytes of returndata (a returndata bomb when large).
contract ReturnBomb {
    uint256 internal immutable _size;

    constructor(uint256 size) {
        _size = size;
    }

    fallback() external {
        uint256 n = _size;
        assembly {
            return(0, n)
        }
    }
}

/// @dev Records every call it receives, in order, with who made it, and answers each with an empty success except
///      `mint(address)`, which answers a token id. Stands in for an ABX collection so a test can read back exactly what
///      a factory asked of it, and in what order.
contract CallRecorder {
    bytes[] internal _calls;
    address[] internal _callers;

    function count() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (bytes memory) {
        return _calls[i];
    }

    function callerAt(uint256 i) external view returns (address) {
        return _callers[i];
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        _calls.push(data);
        _callers.push(msg.sender);
        if (msg.sig == bytes4(keccak256("mint(address)"))) return abi.encode(uint256(0));
        return "";
    }
}
