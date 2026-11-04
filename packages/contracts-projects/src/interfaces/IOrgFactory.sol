// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOrgFactory — the canonical entry point for ABX FS orgs
/// @notice An **org** is its own ABX collection, deployed by this factory, and projects are tokens in
///         it. The factory renounces ABX ownership of every org at creation, so nobody but a
///         project's owner (`ownerOf`) — not ABX FS, not the org's admin — holds any power over that
///         project. The admin is a record here, not an ABX owner, and its powers are exactly three:
///         mint into the org, open or close it (while open, anyone may mint), and hand the role on.
///
/// @dev    Org admin and project owner are different things. A project is governed by `ownerOf` and
///         nothing else; the admin only decides who can *create* projects in the org.
interface IOrgFactory {
    error InvalidName();
    error InvalidDescription();
    /// @dev `predictOrg(bytes32(0))`: a zero salt is a plain deploy, which has no predictable address.
    error NoDeterministicAddress();
    error SaltSenderMismatch();
    error NotAdmin(address org, address caller);
    error NotOrg(address org);
    error NotPendingAdmin(address org, address caller);
    /// @notice `createOrg` before all five components (hook, enumeration hook, minter, card, traits renderer) have been
    ///         deployed at the addresses this factory names. Anyone can deploy them; see `componentsDeployed`.
    error ComponentsNotDeployed();

    event OrgCreated(
        address indexed org, address indexed admin, uint256 indexed index, string name, uint64 createdBlock
    );
    event AdminTransferStarted(address indexed org, address indexed from, address indexed to);
    event AdminTransferred(address indexed org, address indexed from, address indexed to);
    event OpenSet(address indexed org, bool open);

    // ─── Creation ─────────────────────────────────────────────────────────────

    /// @notice Create an org administered by `msg.sender`, and mint its first project to them.
    /// @param name_ Display name: printable ASCII only (bytes 0x20 to 0x7e), 1-64 bytes, with at least one
    ///              non-space character, else `InvalidName`. Immutable: it becomes the ABX collection name.
    /// @param description_ The collection description marketplaces show: 0-1000 bytes of printable ASCII
    ///              (0x20 to 0x7e) and newlines (0x0a), not only whitespace unless empty, else
    ///              `InvalidDescription`. Immutable. Empty means none, and the collection document then
    ///              carries a standard text. It is also every project token's fallback `description`.
    /// @param salt  `bytes32(0)` for a plain deploy. Otherwise a deterministic address, and the first 20
    ///              bytes must be zero (anyone may use it) or `msg.sender` (only they may), else
    ///              `SaltSenderMismatch`.
    ///
    ///              SQUATTING: a zero-prefix salt is open to everyone, so anyone who sees your salt can
    ///              create an org at that address first, as its admin. A prefix-bound salt (the first 20
    ///              bytes equal your address) binds the org address to you only on chains where you
    ///              control your own address. The same salt names the same org address on every chain;
    ///              an EOA's key controls it everywhere, but a smart account (a Safe, say) exists only
    ///              where it was deployed, and on another chain that address may be unclaimed or someone
    ///              else's, who can then take the org address there. Only announce or pre-share a
    ///              predicted address for a prefix-bound salt, and only for chains where your address is
    ///              yours; a zero-prefix address is safe to rely on only once the org exists and
    ///              `adminOf` is you.
    function createOrg(string calldata name_, string calldata description_, bytes32 salt)
        external
        returns (address org);

    /// @notice The address `createOrg(_, _, salt)` would produce, if the salt is usable. Reverts with
    ///         `NoDeterministicAddress` for `bytes32(0)`: that is a plain deploy, with no predictable
    ///         address. It does not check the salt's creator prefix, so a prefix-bound salt of someone
    ///         else yields an address you cannot deploy to. See `createOrg` on squatting.
    function predictOrg(bytes32 salt) external view returns (address);

    /// @notice Whether every component exists at the address this factory computed for it. Each is deployed through
    ///         the keyless CREATE2 deployer with the factory's `COMPONENT_SALT` and its creation code with the
    ///         constructor arguments the factory used (both stores and this factory for the hook, this factory for the
    ///         enumeration hook and the minter, the hook for the card and the traits renderer), so only that exact
    ///         code can be there.
    function componentsDeployed() external view returns (bool);

    // ─── The registry ─────────────────────────────────────────────────────────

    function isOrg(address org) external view returns (bool);
    function orgCount() external view returns (uint256);
    /// @notice Org `index` in creation order. Append-only. Reverts with an array-bounds panic past the end.
    function orgAt(uint256 index) external view returns (address);
    /// @notice Orgs `start .. start + count` in creation order, clamped to the end (an overrun is a shorter or empty
    ///         window, never a revert).
    function orgsSlice(uint256 start, uint256 count) external view returns (address[] memory);
    function createdBlockOf(address org) external view returns (uint64);

    // ─── Admin ────────────────────────────────────────────────────────────────

    function adminOf(address org) external view returns (address);
    function pendingAdminOf(address org) external view returns (address);
    /// @notice Orgs `admin` currently administers. Order is not stable across transfers. Unbounded: use
    ///         {orgsAdministeredSlice} to page.
    function orgsAdministered(address admin) external view returns (address[] memory);
    function orgsAdministeredCount(address admin) external view returns (uint256);
    /// @notice A window of {orgsAdministered}, `start .. start + count`, clamped like {orgsSlice}. The order is not
    ///         stable across handovers, so a pager should read at one block.
    function orgsAdministeredSlice(address admin, uint256 start, uint256 count)
        external
        view
        returns (address[] memory);

    /// @notice Offer the admin role to `to`. Nothing changes until they accept.
    function transferAdmin(address org, address to) external;
    /// @notice Take the role offered to you (`NotOrg`; `NotPendingAdmin` unless an offer to you is pending). This also
    ///         closes the org: a handover is how an org recovers from a compromised admin key, and an open door the
    ///         old admin left must not outlive the old admin. The new admin reopens deliberately.
    function acceptAdmin(address org) external;

    // ─── Mint rules ───────────────────────────────────────────────────────────

    function isOpen(address org) external view returns (bool);
    /// @notice Whether `caller` may mint into `org` through the minter: true for a registered org when
    ///         `caller` is this factory (how `createOrg` mints the first project), the org's admin, or
    ///         anyone while the org is open; false for any address that is not an org.
    function mayMint(address org, address caller) external view returns (bool);
    /// @notice Open (`true`: anyone may mint) or close `org`. Admin only (`NotOrg`, `NotAdmin`).
    function setOpen(address org, bool open_) external;
}
