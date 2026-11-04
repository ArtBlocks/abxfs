// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The slice of ABX's `SeriesCode` factory and collection that `OrgFactory` and `OrgMinter` call.
///      Mirrors ABX's own signatures.
struct AbxTokenField {
    uint256 tokenId;
    bytes32 field;
    bytes32 representation;
    bytes value;
}

struct AbxContractField {
    bytes32 field;
    bytes32 representation;
    bytes value;
}

struct AbxInitParams {
    address owner;
    string name;
    string symbol;
    string tokenURIBase;
    address tokenURIRenderer;
    string contractURIBase;
    address contractURIRenderer;
    address royaltyReceiver;
    uint16 royaltyBps;
    uint16 maxRoyaltyBps;
    bool burnable;
    address transferValidator;
    uint256 maxInvocations;
    address primaryPayee;
    address minter;
    bool paused;
    address seedSource;
    bool disableTokenOwnerDelegation;
    address mintTo;
    uint256 mintCount;
    AbxTokenField[] tokenFields;
    AbxContractField[] contractFields;
}

interface IAbxSeriesCodeFactory {
    function deploy(AbxInitParams calldata params) external returns (address clone);
    function deployDeterministic(AbxInitParams calldata params, bytes32 salt)
        external
        returns (address clone);
    function predictDeterministicAddress(bytes32 salt) external view returns (address);
}

interface IAbxOrgCollection {
    function setParamSchema(
        bytes32 key,
        uint8 paramType,
        uint8 auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] calldata selectOptions
    ) external;
    function setParamHooks(address configure, address augment, address transfer) external;
    function lockParamHooks() external;
    function lockTokenURI() external;
    function lockContractURI() external;
    function lockScript() external;
    function lockDependencies() external;
    function lockContractField(bytes32 field) external;
    function renounceOwnership() external payable;
    function mint(address to) external returns (uint256 tokenId);
}
