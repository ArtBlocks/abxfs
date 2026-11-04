// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AbxInitParams, AbxContractField} from "../../src/interfaces/IAbxOrgDeploy.sol";
import {IAbxConfigureHook} from "../../src/interfaces/IAbxConfigureHook.sol";
import {IAbxTransferHook} from "../../src/interfaces/IAbxTransferHook.sol";

interface IContractURIRenderer {
    function contractURI(address token) external view returns (string memory);
}

/// @dev A collection that behaves like a real ABX `SeriesCode` where it matters to the factory:
///      owner-gated setters that revert `Unauthorized`, a minter/owner-gated `mint`, hook calls on
///      every mint, transfer and configure, and `TokenOwner` auth on `configureTokenParam`. It does
///      NOT try to be ABX; the fork test is what proves the real thing behaves this way.
contract MockOrgCollection {
    error Unauthorized();
    error NotMinterOrOwner();
    error HooksLocked();

    address public owner;
    string public name;
    string public symbol;
    address public minter;
    uint256 public maxInvocations;
    bool public paused;
    uint16 public royaltyBps;
    uint16 public maxRoyaltyBps;
    address public transferValidator;
    address public seedSource;
    address public tokenURIRenderer;
    address public contractURIRenderer;
    AbxContractField[] internal _contractFields;
    mapping(bytes32 => bool) public contractFieldLocked;

    address public configureHook;
    address public transferHook;
    bool public delegationDisabled;
    bool public paramHooksLocked;
    bool public tokenURILocked;
    bool public contractURILocked;
    bool public scriptLocked;
    bool public dependenciesLocked;

    struct Key {
        bytes32 key;
        uint8 paramType;
        uint8 auth;
    }

    Key[] internal _schema;
    uint256 public nextTokenId;
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => mapping(bytes32 => bytes32)) internal _params;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(AbxInitParams memory p) {
        owner = p.owner;
        name = p.name;
        symbol = p.symbol;
        minter = p.minter;
        maxInvocations = p.maxInvocations;
        paused = p.paused;
        royaltyBps = p.royaltyBps;
        maxRoyaltyBps = p.maxRoyaltyBps;
        transferValidator = p.transferValidator;
        seedSource = p.seedSource;
        delegationDisabled = p.disableTokenOwnerDelegation;
        tokenURIRenderer = p.tokenURIRenderer;
        contractURIRenderer = p.contractURIRenderer;
        for (uint256 i; i < p.contractFields.length; ++i) _contractFields.push(p.contractFields[i]);
    }

    // ─── owner-gated ─────────────────────────────────────────────────────────

    function setParamSchema(bytes32 key, uint8 t, uint8 auth, address, uint48, bytes32, bytes32, string[] calldata)
        external
        onlyOwner
    {
        _schema.push(Key(key, t, auth));
    }

    function setParamHooks(address cfg, address, address xfer) external onlyOwner {
        if (paramHooksLocked) revert HooksLocked();
        configureHook = cfg;
        transferHook = xfer;
    }

    function lockParamHooks() external onlyOwner { paramHooksLocked = true; }
    function lockTokenURI() external onlyOwner { tokenURILocked = true; }
    function lockContractURI() external onlyOwner { contractURILocked = true; }
    function lockScript() external onlyOwner { scriptLocked = true; }
    function lockDependencies() external onlyOwner { dependenciesLocked = true; }
    function lockContractField(bytes32 field) external onlyOwner { contractFieldLocked[field] = true; }

    function setMinter(address m) external onlyOwner { minter = m; }

    function renounceOwnership() external payable onlyOwner { owner = address(0); }

    // ─── views the tests read back ───────────────────────────────────────────

    function schemaLength() external view returns (uint256) { return _schema.length; }
    function schemaAt(uint256 i) external view returns (Key memory) { return _schema[i]; }
    function contractFieldCount() external view returns (uint256) { return _contractFields.length; }
    function contractFieldAt(uint256 i) external view returns (AbxContractField memory) { return _contractFields[i]; }

    /// @dev ABX's `IAbxOnChainMetadata.contractField`: `(representation, value)`, both empty when unset.
    function contractField(bytes32 field) external view returns (bytes32, bytes memory) {
        for (uint256 i; i < _contractFields.length; ++i) {
            if (_contractFields[i].field == field) return (_contractFields[i].representation, _contractFields[i].value);
        }
        return (bytes32(0), "");
    }

    /// @dev ABX's `ContractURI.contractURI()` with a renderer set.
    function contractURI() external view returns (string memory) {
        return IContractURIRenderer(contractURIRenderer).contractURI(address(this));
    }

    // ─── tokens ──────────────────────────────────────────────────────────────

    function mint(address to) external returns (uint256 id) {
        if (msg.sender != minter && msg.sender != owner) revert NotMinterOrOwner();
        id = nextTokenId++;
        _owners[id] = to;
        if (transferHook != address(0)) {
            IAbxTransferHook(transferHook).onTokenTransfer(id, address(0), to, msg.sender, 1);
        }
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = _owners[id];
        require(o != address(0), "nonexistent token");
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(_owners[id] == from && msg.sender == from, "not owner");
        _owners[id] = to;
        if (transferHook != address(0)) {
            IAbxTransferHook(transferHook).onTokenTransfer(id, from, to, msg.sender, 1);
        }
    }

    function burn(uint256 id) external {
        address o = _owners[id];
        require(o == msg.sender, "not owner");
        delete _owners[id];
        if (transferHook != address(0)) {
            IAbxTransferHook(transferHook).onTokenTransfer(id, o, address(0), msg.sender, 1);
        }
    }

    /// @dev `TokenOwner` auth, then the configure hook (which may veto), then persist.
    function configureTokenParam(uint256 id, bytes32 key, bytes32 value) external {
        require(_owners[id] == msg.sender, "NotParamAuthorized");
        if (configureHook != address(0)) {
            IAbxConfigureHook(configureHook).onParamConfigured(id, key, value, msg.sender, 0, address(0));
        }
        _params[id][key] = value;
    }

    function tokenParam(uint256 id, bytes32 key) external view returns (bytes32 v, bool isHash, bool isSet) {
        v = _params[id][key];
        return (v, false, v != bytes32(0));
    }

    mapping(uint256 => mapping(bytes32 => bytes)) internal _data;

    function configureTokenParamData(uint256 id, bytes32 key, bytes calldata value) external {
        require(_owners[id] == msg.sender, "NotParamAuthorized");
        if (configureHook != address(0)) {
            IAbxConfigureHook(configureHook).onParamConfigured(id, key, bytes32(0), msg.sender, value.length, address(0));
        }
        _data[id][key] = value;
    }

    function tokenParamData(uint256 id, bytes32 key) external view returns (bytes memory) {
        return _data[id][key];
    }
}

contract MockAbxFactory {
    error SaltSenderMismatch();

    bytes32 public lastSalt;
    address public lastClone;

    function deploy(AbxInitParams calldata p) external returns (address clone) {
        clone = address(new MockOrgCollection(p));
        lastClone = clone;
    }

    function deployDeterministic(AbxInitParams calldata p, bytes32 salt) external returns (address clone) {
        address guard = address(bytes20(salt));
        if (guard != address(0) && guard != msg.sender) revert SaltSenderMismatch();
        lastSalt = salt;
        clone = address(new MockOrgCollection{salt: salt}(p));
        lastClone = clone;
    }

    function predictDeterministicAddress(bytes32) external pure returns (address) {
        return address(0);
    }
}

/// @dev Stand-ins for a registry that misbehaves, to prove the hooks treat every one of them as
///      "not an org" instead of reverting. Each is a different way a staticcall can go wrong.
contract RevertingRegistry {
    function isOrg(address) external pure returns (bool) { revert("boom"); }
}

contract LongReturnRegistry {
    function isOrg(address) external pure returns (bool, bool) { return (true, true); }
}

contract NonBoolRegistry {
    fallback(bytes calldata) external returns (bytes memory) { return abi.encode(uint256(2)); }
}

contract MockRegistry {
    mapping(address => bool) public isOrg;
    function set(address a, bool v) external { isOrg[a] = v; }
}
