// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStorageBackend} from "../../src/interfaces/IStorageBackend.sol";
import {IChunkStore} from "../../src/interfaces/IChunkStore.sol";

/// @dev A backend the EVM cannot read: it keeps nothing, emits the input as an event (a log backend's shape), and
///      returns the input hash as the pointer. Counts `store` calls.
contract LogBackend is IStorageBackend {
    event Stored(bytes32 indexed pointer, bytes data);

    uint256 public stores;

    function store(bytes calldata input, address) external returns (bytes32 pointer) {
        stores++;
        pointer = keccak256(input);
        emit Stored(pointer, input);
    }

    function readable() external pure returns (bool) {
        return false;
    }

    function retrieve(bytes32) external pure returns (bytes memory) {
        revert NotEvmReadable();
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("evm-log", "Stored(bytes32,bytes) at the block of the write.");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @dev A readable backend whose answers are scripted by the test: `data` is what `retrieve` returns, `raw` (when
///      set) replaces the whole ABI-encoded return, and `fail` makes `retrieve` revert.
contract ScriptedBackend is IStorageBackend {
    bytes public data;
    bytes public raw;
    bool public fail;
    bool public isReadable = true;
    uint256 public stores;

    function set(bytes memory data_) external {
        data = data_;
    }

    function setRaw(bytes memory raw_) external {
        raw = raw_;
    }

    function setFail(bool fail_) external {
        fail = fail_;
    }

    function setReadable(bool r) external {
        isReadable = r;
    }

    function store(bytes calldata input, address) external returns (bytes32) {
        stores++;
        if (data.length == 0) data = input;
        return keccak256(input);
    }

    function readable() external view returns (bool) {
        return isReadable;
    }

    function retrieve(bytes32) external view returns (bytes memory) {
        if (fail) revert("scripted failure");
        bytes memory r = raw;
        if (r.length != 0) {
            assembly {
                return(add(r, 0x20), mload(r))
            }
        }
        return data;
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("scripted", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @dev Re-enters `ChunkStore.write` from inside `store`, with the same arguments (`same`) or with other input.
contract ReentrantBackend is IStorageBackend {
    IChunkStore public immutable chunks;
    bool public same;
    uint256 public depth;

    constructor(IChunkStore chunks_) {
        chunks = chunks_;
    }

    function setSame(bool same_) external {
        same = same_;
    }

    function store(bytes calldata input, address) external returns (bytes32) {
        if (depth == 0) {
            depth = 1;
            if (same) {
                chunks.write(address(this), input, keccak256(input), uint48(input.length));
            } else {
                bytes memory other = bytes.concat(input, "!");
                chunks.write(address(this), other, keccak256(other), uint48(other.length));
            }
            depth = 0;
        }
        return keccak256(input);
    }

    function readable() external pure returns (bool) {
        return false;
    }

    function retrieve(bytes32) external pure returns (bytes memory) {
        revert NotEvmReadable();
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("reentrant", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @dev A gated, metered backend of the shape `caller` exists for: it serves one `ChunkStore`, debits each writer's
///      deposit per stored byte and keeps the bytes in a mapping it can read back.
contract MeteredBackend is IStorageBackend {
    error NotChunkStore();
    error InsufficientDeposit(address caller);

    address public immutable chunkStore;
    mapping(address => uint256) public deposits;
    mapping(bytes32 => bytes) internal _data;
    address public lastCaller;

    constructor(address chunkStore_) {
        chunkStore = chunkStore_;
    }

    function deposit(address account, uint256 amount) external {
        deposits[account] += amount;
    }

    function store(bytes calldata input, address caller) external returns (bytes32 pointer) {
        if (msg.sender != chunkStore) revert NotChunkStore();
        if (deposits[caller] < input.length) revert InsufficientDeposit(caller);
        deposits[caller] -= input.length;
        lastCaller = caller;
        pointer = keccak256(input);
        _data[pointer] = input;
    }

    function readable() external pure returns (bool) {
        return true;
    }

    function retrieve(bytes32 pointer) external view returns (bytes memory) {
        return _data[pointer];
    }

    function retrieval() external pure returns (bytes32, string memory) {
        return ("evm", "");
    }

    function maxInputSize() external pure returns (uint256) {
        return type(uint256).max;
    }
}
