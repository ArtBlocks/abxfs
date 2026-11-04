// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AbxInitParams,
    AbxContractField,
    IAbxSeriesCodeFactory,
    IAbxOrgCollection
} from "./interfaces/IAbxOrgDeploy.sol";
import {IOrgFactory} from "./interfaces/IOrgFactory.sol";
import {ProjectHook} from "./ProjectHook.sol";
import {ProjectEnumeration} from "./ProjectEnumeration.sol";
import {ProjectCard} from "./ProjectCard.sol";
import {ProjectTraits} from "./ProjectTraits.sol";
import {ProjectLinks} from "./ProjectLinks.sol";
import {OrgMinter} from "./OrgMinter.sol";
import {OrgMeta} from "./OrgMeta.sol";

/// @title OrgFactory
/// @notice The canonical entry point for ABX FS orgs. `createOrg` deploys an ABX `SeriesCode`
///         collection, registers it as an org, declares its param schema, wires and locks everything
///         an ABX FS project depends on, renounces ABX ownership, and mints its first project to the
///         caller through the minter — one transaction, no way to land halfway.
///
///         After `createOrg` nobody can change the org's schema, hooks, renderers, URIs, minter,
///         supply cap, royalty, transfer validator or pause state. That includes ABX FS and the
///         org's admin. A project is governed by `ownerOf` and nothing else; the admin only decides
///         who may create projects in the org. A fix is a new factory version, not an upgrade.
///
/// @dev    Five components are deployed beside the factory, not by it: the hook, the enumeration hook,
///         the minter, the card and the traits renderer. Each needs the factory's address (the hooks
///         ask it whether a collection is a registered org, the minter asks it who may mint) or the
///         hook's (the card and the traits renderer read history from it), and the factory needs
///         each of theirs (to wire an org). The constructor breaks that cycle without an initializer:
///         it computes every component's address as the keyless CREATE2 deployer would place it
///         (`COMPONENT_SALT`, the component's creation code and its constructor arguments: both stores
///         and this factory for the hook, this factory for the enumeration hook and the minter, the
///         hook for the card and the traits renderer) and keeps them as immutables. Anyone may then deploy each component
///         through that deployer, in any order and in its own transaction; only that exact code can
///         land at each address, and `createOrg` refuses until all five exist (`componentsDeployed`).
///         Deploying them in this constructor instead would put about 43 KB of code (theirs and the
///         factory's) into one transaction: about 68M gas under EIP-8037, over Ethereum's 60M block
///         gas limit at the time of writing.
///
///         `orgMeta` (collection document and token names) and the links renderer it deploys need
///         neither address, so `orgMeta` is deployed first (deploying the links renderer itself) and
///         passed in; the factory reads `links` from it.
///
///         There is no owner, no admin of the factory itself and no upgrade path. Nothing here can
///         pause `createOrg` or remove an org from the registry.
contract OrgFactory is IOrgFactory {
    // ─── ABX parameter encodings ─────────────────────────────────────────────

    bytes32 internal constant _KEY_CID = "abxfs.cid";
    bytes32 internal constant _KEY_GATEWAY = "abxfs.gateway";
    bytes32 internal constant _KEY_NAME = "abxfs.name";
    bytes32 internal constant _KEY_VIEW = "abxfs.view";
    bytes32 internal constant _KEY_META = "abxfs.meta";

    /// @dev ABX's `ParamType` (`Uint256Range` = 2, `String` = 7) and `ParamAuth` (`TokenOwner` = 1) enum
    ///      positions.
    uint8 internal constant _TYPE_UINT256_RANGE = 2;
    uint8 internal constant _TYPE_STRING = 7;
    uint8 internal constant _AUTH_TOKEN_OWNER = 1;

    bytes32 internal constant _FIELD_IMAGE = "image";
    bytes32 internal constant _FIELD_ATTRIBUTES = "attributes";
    bytes32 internal constant _FIELD_ANIMATION_URL = "animation_url";
    bytes32 internal constant _FIELD_EXTERNAL_URL = "external_url";
    bytes32 internal constant _FIELD_NAME = "name";
    bytes32 internal constant _FIELD_DESCRIPTION = "description";
    bytes32 internal constant _REPRESENTATION_RENDERER = "renderer";
    bytes32 internal constant _REPRESENTATION_INLINE = "inline";

    string internal constant _SYMBOL = "ABXFS";

    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_DESCRIPTION_BYTES = 1000;
    /// @dev Per org, not shared. Lowering is the only direction ABX allows, so this is set once at
    ///      the ceiling we would want rather than a number we might outgrow.
    uint256 public constant MAX_PROJECTS = 1_000_000;

    /// @notice The keyless CREATE2 deployer every component is deployed through.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @notice The salt every component is deployed with. One serves all five: their init code differs.
    bytes32 public constant COMPONENT_SALT = keccak256("abx-fs/org-components");

    // ─── Wiring (all immutable) ──────────────────────────────────────────────

    IAbxSeriesCodeFactory public immutable abx;
    address public immutable metadataRenderer;
    address public immutable seedSource;
    /// @notice The org's collection document (`contractURI`) and every token's `name`. Deployed separately.
    address public immutable orgMeta;

    ProjectHook public immutable hook;
    ProjectEnumeration public immutable enumeration;
    OrgMinter public immutable minter;
    ProjectCard public immutable card;
    ProjectTraits public immutable traits;
    ProjectLinks public immutable links;

    // ─── Registry ────────────────────────────────────────────────────────────

    /// @dev One slot per org. `admin` is never zero for a registered org, so it doubles as "exists": `acceptAdmin`
    ///      sets it only to a pending admin, which is never zero, and `createOrg` to `msg.sender` (a zero caller cannot
    ///      occur on chain, and would make `createOrg` revert at its final mint, since a zero admin reads as no org).
    ///      `administeredIndexPlusOne` is the org's 1-based position in `_administered[admin]`, for swap-and-pop on a
    ///      handover; it is never zero for a registered org either. `createdBlock` fits 40 bits for any block number a
    ///      chain will reach.
    struct Org {
        address admin;
        uint40 createdBlock;
        bool open;
        uint48 administeredIndexPlusOne;
    }

    mapping(address => Org) internal _orgs;
    address[] internal _orgList;
    mapping(address => address) public pendingAdminOf;

    /// @dev admin => orgs they administer.
    mapping(address => address[]) internal _administered;

    constructor(
        address abx_,
        address metadataRenderer_,
        address seedSource_,
        address directoryStore_,
        address fileStore_,
        address orgMeta_
    ) {
        orgMeta = orgMeta_;
        abx = IAbxSeriesCodeFactory(abx_);
        metadataRenderer = metadataRenderer_;
        seedSource = seedSource_;

        address hook_ = _component(
            abi.encodePacked(type(ProjectHook).creationCode, abi.encode(directoryStore_, fileStore_, address(this)))
        );
        hook = ProjectHook(hook_);
        enumeration =
            ProjectEnumeration(_component(abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(address(this)))));
        minter = OrgMinter(_component(abi.encodePacked(type(OrgMinter).creationCode, abi.encode(address(this)))));
        card = ProjectCard(_component(abi.encodePacked(type(ProjectCard).creationCode, abi.encode(hook_))));
        traits = ProjectTraits(_component(abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(hook_))));
        // The links renderer is deployed by `orgMeta`, with the same gateway base, not here, to keep this
        // initcode under EIP-3860's limit. A typed call, so an `orgMeta` with no code reverts the deploy.
        links = OrgMeta(orgMeta_).links();
    }

    /// @dev Where the keyless deployer places `initCode` under `COMPONENT_SALT`.
    function _component(bytes memory initCode) private pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, COMPONENT_SALT, keccak256(initCode)))))
        );
    }

    /// @inheritdoc IOrgFactory
    function componentsDeployed() public view returns (bool) {
        return address(hook).code.length != 0 && address(enumeration).code.length != 0
            && address(minter).code.length != 0 && address(card).code.length != 0 && address(traits).code.length != 0;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Creation
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrgFactory
    function createOrg(string calldata name_, string calldata description_, bytes32 salt)
        external
        returns (address org)
    {
        if (!componentsDeployed()) revert ComponentsNotDeployed();
        if (!_isText(bytes(name_), 1, MAX_NAME_BYTES, false)) revert InvalidName();
        if (!_isText(bytes(description_), 0, MAX_DESCRIPTION_BYTES, true)) revert InvalidDescription();

        AbxInitParams memory p = _initParams(name_, description_);

        if (salt == bytes32(0)) {
            org = abx.deploy(p);
        } else {
            address guard = address(bytes20(salt));
            if (guard != address(0) && guard != msg.sender) revert SaltSenderMismatch();
            org = abx.deployDeterministic(p, _abxSalt(salt));
        }

        // Register BEFORE wiring, so neither hook is ever called for this org while it is unregistered:
        // both gate a cross-org structure on `isOrg`.
        uint256 index = _orgList.length;
        _orgList.push(org);
        _register(org, msg.sender, uint40(block.number));

        IAbxOrgCollection c = IAbxOrgCollection(org);
        string[] memory none = new string[](0);
        c.setParamSchema(_KEY_CID, _TYPE_UINT256_RANGE, _AUTH_TOKEN_OWNER, address(0), 0, bytes32(0), bytes32(0), none);
        c.setParamSchema(_KEY_GATEWAY, _TYPE_STRING, _AUTH_TOKEN_OWNER, address(0), 0, bytes32(0), bytes32(0), none);
        c.setParamSchema(_KEY_NAME, _TYPE_STRING, _AUTH_TOKEN_OWNER, address(0), 0, bytes32(0), bytes32(0), none);
        c.setParamSchema(_KEY_VIEW, _TYPE_STRING, _AUTH_TOKEN_OWNER, address(0), 0, bytes32(0), bytes32(0), none);
        c.setParamSchema(_KEY_META, _TYPE_STRING, _AUTH_TOKEN_OWNER, address(0), 0, bytes32(0), bytes32(0), none);

        c.setParamHooks(address(hook), address(0), address(enumeration));

        // Every collection-level lock, then renounce. Renouncing alone makes each of these unreachable, but ABX's own
        // tooling reads an unlocked flag as "still mutable". Lock them so the chain says what is true.
        c.lockParamHooks();
        c.lockTokenURI();
        c.lockContractURI();
        c.lockScript();
        c.lockDependencies();
        // Every metadata field set at creation, the same way: renouncing already freezes them, but an
        // unlocked flag reads as "still mutable" to anything that asks the collection.
        for (uint256 i; i < p.contractFields.length; ++i) {
            c.lockContractField(p.contractFields[i].field);
        }
        c.renounceOwnership();

        emit OrgCreated(org, msg.sender, index, name_, uint64(block.number));

        // Last, and through the minter: the hooks are wired and the org is registered, so the
        // enumeration hook sees this mint. ABX's own `mintTo` would land inside the deploy, before the hooks were wired.
        minter.mint(org, msg.sender);
    }

    /// @inheritdoc IOrgFactory
    function predictOrg(bytes32 salt) external view returns (address) {
        if (salt == bytes32(0)) revert NoDeterministicAddress();
        return abx.predictDeterministicAddress(_abxSalt(salt));
    }

    /// @dev The name and the description are frozen into the ABX collection and rendered into JSON (and
    ///      the name into SVG: the card, the logo and the banner), so they are printable ASCII only
    ///      (0x20..0x7e), plus `\n` in a description, `min` to `max` bytes, and, unless empty, not only
    ///      spaces and newlines. Every other byte (NUL, tab, CR, other controls, DEL, any non-ASCII byte) is
    ///      refused. One loop for both, for initcode headroom.
    function _isText(bytes calldata b, uint256 min, uint256 max, bool newline) internal pure returns (bool) {
        uint256 n = b.length;
        if (n < min || n > max) return false;
        if (n == 0) return true;
        bool visible;
        for (uint256 i; i < n; ++i) {
            uint8 c = uint8(b[i]);
            if (c == 0x0a && newline) continue;
            if (c < 0x20 || c > 0x7e) return false;
            if (c != 0x20) visible = true;
        }
        return visible;
    }

    /// @dev ABX only accepts a salt whose first 20 bytes are zero or the caller, and here the caller is
    ///      this factory. So a hash of the user's salt fills the low 12 bytes (`createOrg` vets the
    ///      creator prefix first; `predictOrg` does not). Hashing the whole salt, creator prefix included, keeps one creator's salts from
    ///      colliding with another's, and a prefix-bound salt can only be requested by its creator.
    function _abxSalt(bytes32 salt) internal view returns (bytes32) {
        bytes32 h = keccak256(abi.encode(salt));
        return bytes32(bytes20(address(this))) | bytes32(uint256(h) >> 160);
    }

    function _initParams(string calldata name_, string calldata description_)
        internal
        view
        returns (AbxInitParams memory p)
    {
        p.owner = address(this);
        p.name = name_;
        p.symbol = _SYMBOL;
        p.tokenURIRenderer = metadataRenderer;
        // The collection document is ours: ABX's renderer emits `name` alone at that surface, and an org
        // has no owner left to fill a marketplace's collection page in by hand.
        p.contractURIRenderer = orgMeta;
        // No royalty, and a cap of zero so it can never rise. ABX rejects a zero receiver, so the
        // factory is named; it can receive nothing, because the rate is zero.
        p.royaltyReceiver = address(this);
        p.royaltyBps = 0;
        p.maxRoyaltyBps = 0;
        p.burnable = false;
        p.transferValidator = address(0);
        p.maxInvocations = MAX_PROJECTS;
        p.primaryPayee = address(this);
        p.minter = address(minter);
        p.paused = false;
        p.seedSource = seedSource;
        // delegate.xyz delegates must not act as token owner: `ownerOf` is the whole authorization
        // model. ABX's `setDelegateRegistry` is owner-only and the org renounces below, so nobody can turn
        // it back on.
        p.disableTokenOwnerDelegation = true;
        // `mintTo` / `mintCount` stay zero on purpose; see the end of `createOrg`.

        bool described = bytes(description_).length != 0;
        p.contractFields = new AbxContractField[](described ? 6 : 5);
        p.contractFields[0] = AbxContractField({
            field: _FIELD_IMAGE,
            representation: _REPRESENTATION_RENDERER,
            value: abi.encode(address(card))
        });
        p.contractFields[1] = AbxContractField({
            field: _FIELD_ATTRIBUTES,
            representation: _REPRESENTATION_RENDERER,
            value: abi.encode(address(traits))
        });
        // The live project, for marketplaces that embed `animation_url`, and a link to its page for
        // those that show `external_url`. Both are computed, so they never go stale.
        p.contractFields[2] = AbxContractField({
            field: _FIELD_ANIMATION_URL,
            representation: _REPRESENTATION_RENDERER,
            value: abi.encode(address(links))
        });
        p.contractFields[3] = AbxContractField({
            field: _FIELD_EXTERNAL_URL,
            representation: _REPRESENTATION_RENDERER,
            value: abi.encode(address(links))
        });
        // Every token's `name`: the project's own `abxfs.name` when usable, else "<org name> #<id>".
        p.contractFields[4] = AbxContractField({
            field: _FIELD_NAME,
            representation: _REPRESENTATION_RENDERER,
            value: abi.encode(orgMeta)
        });
        // ABX refuses an empty field value, so an org with no description has no field: the collection
        // document then carries a standard text. A contract field is also every token's fallback, so this
        // is each project's `description` too.
        if (described) {
            p.contractFields[5] = AbxContractField({
                field: _FIELD_DESCRIPTION,
                representation: _REPRESENTATION_INLINE,
                value: bytes(description_)
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The registry
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrgFactory
    function isOrg(address org) external view returns (bool) {
        return _orgs[org].admin != address(0);
    }

    /// @inheritdoc IOrgFactory
    function orgCount() external view returns (uint256) {
        return _orgList.length;
    }

    /// @inheritdoc IOrgFactory
    function orgAt(uint256 index) external view returns (address) {
        return _orgList[index];
    }

    /// @inheritdoc IOrgFactory
    function orgsSlice(uint256 start, uint256 count) external view returns (address[] memory) {
        return _slice(_orgList, start, count);
    }

    /// @dev `src[start .. start + count)`, clamped to the end: an overrun is an empty or shorter window, never a revert.
    function _slice(address[] storage src, uint256 start, uint256 count) internal view returns (address[] memory window) {
        uint256 len = src.length;
        if (start >= len) return new address[](0);
        uint256 end = count > len - start ? len : start + count; // clamps; no overflow for any `count`
        window = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            window[i - start] = src[i];
        }
    }

    /// @inheritdoc IOrgFactory
    function createdBlockOf(address org) external view returns (uint64) {
        return _orgs[org].createdBlock;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrgFactory
    function adminOf(address org) external view returns (address) {
        return _orgs[org].admin;
    }

    /// @inheritdoc IOrgFactory
    function orgsAdministered(address admin) external view returns (address[] memory) {
        return _administered[admin];
    }

    /// @inheritdoc IOrgFactory
    function orgsAdministeredCount(address admin) external view returns (uint256) {
        return _administered[admin].length;
    }

    /// @inheritdoc IOrgFactory
    function orgsAdministeredSlice(address admin, uint256 start, uint256 count) external view returns (address[] memory) {
        return _slice(_administered[admin], start, count);
    }

    /// @inheritdoc IOrgFactory
    /// @dev Two steps, so a mistyped address cannot strand an org. Offering to `address(0)` is how
    ///      an offer is withdrawn. There is deliberately no way to renounce: an org with no admin could
    ///      never change its mint rule again, and nothing is gained by making that reachable by accident.
    function transferAdmin(address org, address to) external {
        _requireAdmin(org);
        pendingAdminOf[org] = to;
        emit AdminTransferStarted(org, msg.sender, to);
    }

    /// @inheritdoc IOrgFactory
    /// @dev With no offer pending, `pendingAdminOf` is zero, which is refused outright rather than compared with the
    ///      caller: a zero caller cannot occur on chain, but this keeps a zero admin, which would read as "not an org",
    ///      unreachable by construction.
    function acceptAdmin(address org) external {
        Org storage o = _orgs[org];
        address from = o.admin;
        if (from == address(0)) revert NotOrg(org);
        address pending = pendingAdminOf[org];
        if (pending == address(0) || pending != msg.sender) revert NotPendingAdmin(org, msg.sender);

        delete pendingAdminOf[org];
        bool wasOpen = o.open;

        // Out of the old admin's list (swap-and-pop), into the new one's, and the org's slot rewritten once.
        address[] storage list = _administered[from];
        uint256 i = o.administeredIndexPlusOne - 1;
        uint256 last = list.length - 1;
        if (i != last) {
            address moved = list[last];
            list[i] = moved;
            _orgs[moved].administeredIndexPlusOne = uint48(i + 1);
        }
        list.pop();

        // A handover is how an org recovers from a compromised admin key, so it must also undo what
        // that key could have done to the mint rules: an org the old admin opened would otherwise
        // keep minting after the role moved. The new admin starts closed and opens deliberately.
        _register(org, msg.sender, o.createdBlock);
        if (wasOpen) emit OpenSet(org, false);

        emit AdminTransferred(org, from, msg.sender);
    }

    /// @dev `org`, administered by `admin` (appended to their list), closed.
    function _register(address org, address admin, uint40 createdBlock) internal {
        address[] storage list = _administered[admin];
        list.push(org);
        _orgs[org] = Org({
            admin: admin, createdBlock: createdBlock, open: false, administeredIndexPlusOne: uint48(list.length)
        });
    }

    function _requireAdmin(address org) internal view {
        address admin = _orgs[org].admin;
        if (admin == address(0)) revert NotOrg(org);
        if (admin != msg.sender) revert NotAdmin(org, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Mint rules
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrgFactory
    function isOpen(address org) external view returns (bool) {
        return _orgs[org].open;
    }

    /// @inheritdoc IOrgFactory
    function mayMint(address org, address caller) external view returns (bool) {
        Org storage o = _orgs[org];
        address admin = o.admin;
        if (admin == address(0)) return false;
        return caller == address(this) || caller == admin || o.open;
    }

    /// @inheritdoc IOrgFactory
    function setOpen(address org, bool open_) external {
        _requireAdmin(org);
        _orgs[org].open = open_;
        emit OpenSet(org, open_);
    }
}
