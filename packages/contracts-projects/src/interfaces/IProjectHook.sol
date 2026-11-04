// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IProjectHook — ABX FS project integrity + history, as an ABX configure hook
/// @notice An ABX FS project is an ABX NFT. Its current root CID lives in the `abxfs.cid` PostParam,
///         so authorization is the schema's `TokenOwner` rule and needs nothing from this contract.
///         What the param layer alone cannot give is *integrity* and *queryable history*, and this
///         hook supplies both, vetoing bad writes and recording good ones at the moment they happen.
///
/// @dev    State is namespaced by the calling collection (`msg.sender` inside the hook), so one
///         deployment serves every collection wired to it, each in its own namespace; only the
///         global publish ledger is shared, and it admits registered orgs only. Each factory has its
///         own hook: read an org through the hook of the factory that created it. Every read here
///         takes the collection address explicitly.
///
///         The history below lives in contract storage, which is never pruned, so any reader gets
///         it with `eth_call`s and no log scan. ABX's own `TokenParamConfigured` events carry the
///         same writes for anyone who indexes logs; both are written in the same transaction, so
///         they cannot disagree.
interface IProjectHook {
    /// @notice What a project's root CID resolves to.
    /// @dev    `Unset` is 0 so "this token has never published" is distinguishable from
    ///         "this token's root is a directory".
    enum ContentKind {
        Unset,
        Directory,
        File
    }

    /// @param cid         the root CID published.
    /// @param publishedAt block timestamp of the publishing transaction.
    /// @param publisher   the address that satisfied the param's auth: the token owner (every org
    ///                    disables token-owner delegation).
    struct Version {
        bytes32 cid;
        uint40 publishedAt;
        address publisher;
    }

    /// @notice One entry in a collection's append-only publish ledger.
    ///
    /// @dev A {Version} answers "what did project N publish, in order?" — it is per token, so
    ///      answering "what did this whole collection publish most recently?" from it means reading
    ///      every token. This record answers the second question directly: one ordered sequence for
    ///      the entire collection, appended to on every publish and never mutated or removed.
    ///
    ///      Ordering is append order, which is block order, which is publish order. Index 0 is the
    ///      collection's first publish ever; the last index is its most recent.
    ///
    ///      The ledger stores only which token and which version (one slot per entry); the rest of the
    ///      record is read from that token's history, which is append-only too, so the two never disagree.
    ///      A token id above `2^224 - 1` does not fit the entry and is left out of both ledgers (its history
    ///      is still kept): an org's ids are below its supply cap, so only a caller that is not an org can
    ///      have one.
    struct PublishRecord {
        bytes32 cid;
        address publisher;
        uint40 publishedAt;
        /// @dev The token's own version number for this publish — 1-based, matching {versionAt}.
        uint32 version;
        uint256 tokenId;
    }

    // ─── Errors ───────────────────────────────────────────────────────────────

    /// @notice The published CID is in neither `DirectoryStore` nor `FileStore`.
    /// @dev    This is the guarantee that a project cannot point at nothing.
    error RootNotFound(bytes32 cid);
    /// @notice A project's root kind is fixed by its first publish and cannot change.
    error RootKindLocked(ContentKind expected, ContentKind actual);
    /// @notice Republishing the current head. Rejected so history holds no no-op entries.
    error SameRoot(bytes32 cid);
    /// @notice A `String`/`Bytes` payload exceeded this hook's cap for that key.
    error BlobTooLarge(bytes32 key, uint256 length, uint256 max);

    error NotProjectOwner(address token, uint256 tokenId, address caller);
    error InvalidTagName(string tag);
    error ReservedTag(string tag);
    error TagNotFound(address token, uint256 tokenId, string tag);
    error NoVersions(address token, uint256 tokenId);
    error InvalidVersion(uint256 version, uint256 versionCount);
    error IndexOutOfRange(uint256 index, uint256 count);
    error RangeOutOfBounds(uint256 start, uint256 end, uint256 count);

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @dev `cid` is indexed so a root's publishes can be filtered for. The ledgers above, not this event, are the
    ///      source of truth: providers prune logs.
    event ProjectVersionPublished(
        address indexed token,
        uint256 indexed tokenId,
        uint256 version,
        bytes32 indexed cid,
        ContentKind kind,
        address publisher
    );
    event ProjectTagSet(address indexed token, uint256 indexed tokenId, string tag, uint256 version);
    event ProjectTagMoved(
        address indexed token, uint256 indexed tokenId, string tag, uint256 fromVersion, uint256 toVersion
    );
    event ProjectTagRemoved(address indexed token, uint256 indexed tokenId, string tag);

    // ─── The global publish ledger ────────────────────────────────────────────

    /// @notice The factory whose registered orgs are admitted to the global publish ledger. Fixed at
    ///         deployment.
    function factory() external view returns (address);

    /// @notice Publishes recorded across every registered org.
    function globalPublishCount() external view returns (uint256);

    /// @notice Entry `index`: which org, and the index of the full {PublishRecord} in that org's own
    ///         ledger (read it with {publishAt}). Append-only: an index means the same thing forever.
    function globalPublishAt(uint256 index) external view returns (address org, uint256 orgIndex);

    /// @notice A window of {globalPublishAt}. Clamps instead of reverting on an overrun.
    function globalPublishRange(uint256 start, uint256 count)
        external
        view
        returns (address[] memory orgs, uint256[] memory orgIndexes);

    // ─── Tags ─────────────────────────────────────────────────────────────────

    /// @notice Point `tag` at `version`. Caller MUST be the current token owner. `tag` must match
    ///         `^[a-z0-9][a-z0-9._-]{0,63}$` (`InvalidTagName`); `version` must be 1..`versionCount`
    ///         (`InvalidVersion`).
    /// @dev    Upsert: setting an existing tag moves it. `"latest"` is reserved and virtual.
    ///         ERC-721 only — an ERC-1155 edition id has no single owner to authorize against.
    function setTag(address token, uint256 tokenId, string calldata tag, uint256 version) external;

    /// @notice Remove a tag. Caller MUST be the current token owner.
    function removeTag(address token, uint256 tokenId, string calldata tag) external;

    /// @notice Resolve a tag to its version and CID. `"latest"` resolves to the current head.
    function getTag(address token, uint256 tokenId, string calldata tag)
        external
        view
        returns (uint256 version, bytes32 cid);

    /// @notice Every tag set on a project. Excludes the virtual `"latest"`.
    function listTags(address token, uint256 tokenId) external view returns (string[] memory tags);

    function tagCount(address token, uint256 tokenId) external view returns (uint256 count);

    /// @dev The tag list uses swap-and-pop on removal, so a removal can move the last tag into the
    ///      removed one's position. Snapshot at a block height when walking.
    function getTagAt(address token, uint256 tokenId, uint256 index) external view returns (string memory tag);

    function getTagsRange(address token, uint256 tokenId, uint256 start, uint256 end)
        external
        view
        returns (string[] memory tags);

    // ─── History ──────────────────────────────────────────────────────────────

    function versionCount(address token, uint256 tokenId) external view returns (uint256 count);

    /// @notice The record for a 1-indexed version number.
    function versionAt(address token, uint256 tokenId, uint256 version)
        external
        view
        returns (Version memory record);

    /// @notice A contiguous window of history, half-open `[start, end)` over 0-based indices
    ///         (index `i` is version `i + 1`). Append-only, so any unchanged window is stable forever.
    function versionsRange(address token, uint256 tokenId, uint256 start, uint256 end)
        external
        view
        returns (Version[] memory records);

    /// @notice The current head.
    function latestVersion(address token, uint256 tokenId)
        external
        view
        returns (uint256 version, bytes32 cid);

    /// @notice A project's locked root kind, or `Unset` if it has never published.
    function kindOf(address token, uint256 tokenId) external view returns (ContentKind kind);

    // ─── The publish ledger ───────────────────────────────────────────────────

    /// @notice How many publishes `token` has recorded, across every project in it.
    function publishCount(address token) external view returns (uint256);

    /// @notice The publish at `index` in `token`'s ledger. Index 0 is the oldest. Reverts with an
    ///         array-bounds panic past the end.
    function publishAt(address token, uint256 index) external view returns (PublishRecord memory);

    /// @notice A window of `token`'s ledger in publish order, oldest first.
    /// @dev Clamps to the end rather than reverting, so a pager walking off the end gets an empty
    ///      tail instead of an error to special-case.
    function publishRange(address token, uint256 start, uint256 count)
        external
        view
        returns (PublishRecord[] memory);

    /// @notice The most recent `count` publishes, newest first.
    /// @dev This is the feed query. It is a single `eth_call` against contract state, which is what
    ///      makes it immune to log pruning and flat in cost as the chain ages.
    function recentPublishes(address token, uint256 count)
        external
        view
        returns (PublishRecord[] memory);

    /// @notice The `count` publishes immediately older than `beforeIndex`, newest first.
    /// @dev The paging cursor for {recentPublishes}. Pass the index of the oldest record you have
    ///      seen; pass {publishCount} to start from the newest.
    function recentPublishesBefore(address token, uint256 beforeIndex, uint256 count)
        external
        view
        returns (PublishRecord[] memory);
}
