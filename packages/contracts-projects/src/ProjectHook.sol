// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";

import {IAbxConfigureHook} from "./interfaces/IAbxConfigureHook.sol";
import {IProjectHook} from "./interfaces/IProjectHook.sol";
import {IOrgFactory} from "./interfaces/IOrgFactory.sol";

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title ProjectHook
/// @notice The integrity layer for ABX FS projects on ABX. A project's current root CID lives in the
///         `abxfs.cid` PostParam, whose `TokenOwner` auth is enforced by the ABX contract itself —
///         this hook adds nothing to the param's authorization and holds no power over who may publish. What it
///         does is veto writes that would corrupt the protocol's invariants, and record the history
///         those writes produce. Identity, authorization and ownership belong to the NFT; only the
///         invariants needed a home.
///
/// @dev    MUST be deployed as an **immutable** contract. A proxy would make
///         `paramHooksLocked() == true` mean "these addresses can never change" while the behavior
///         behind them still could — and this contract's whole value is that a reader can verify
///         what enforces the invariants. There is no owner, no admin, and no upgrade path here by
///         construction.
///
///         There is one hook per factory, one of its components: the factory computes this
///         contract's CREATE2 address from its creation code and constructor arguments, which name
///         the factory, so `factory` is an immutable with no deploy-order cycle and no initializer.
///         It is used for exactly one thing: deciding whether a publish also lands in the global
///         ledger. The global ledger is the one shared structure, which is why it admits only
///         registered orgs.
///
///         `msg.sender` inside `onParamConfigured` is whatever contract calls it, and a caller can
///         only write under its own address, so one deployment serves every collection wired to it.
///         Read functions take the collection address explicitly; an org's history is in the hook of
///         the factory that created it.
contract ProjectHook is IAbxConfigureHook, IProjectHook {
    // ─── Param keys (short ASCII packed into bytes32, matching ABX's key encoding) ───

    bytes32 public constant KEY_CID = "abxfs.cid";
    bytes32 public constant KEY_GATEWAY = "abxfs.gateway";
    bytes32 public constant KEY_NAME = "abxfs.name";
    /// @dev The owner's own URL for the live project: what the token's `animation_url` and
    ///      `external_url` point at. The hook polices only its size; `ProjectLinks` decides whether
    ///      the value is a URL it will emit, and falls back to the default when it is not.
    bytes32 public constant KEY_VIEW = "abxfs.view";
    /// @dev Reserved for forward-compatible per-client metadata, e.g. a JSON blob. This hook polices
    ///      only its size and attaches no meaning to its content.
    bytes32 public constant KEY_META = "abxfs.meta";

    /// @dev Caps on the `String` keys this hook knows about. `dataLength` exists on the hook
    ///      interface precisely so a project polices its own blobs — ABX deliberately imposes no
    ///      on-chain size budget, and an unbounded `TokenOwner`-writable `String` lets an owner push
    ///      their own token's `tokenURI` past what common RPCs will serve.
    uint256 public constant MAX_NAME_BYTES = 128;
    uint256 public constant MAX_GATEWAY_BYTES = 512;
    uint256 public constant MAX_VIEW_BYTES = 512;
    uint256 public constant MAX_META_BYTES = 4096;

    uint256 internal constant _MAX_TAG_BYTES = 64;
    /// @dev `keccak256("latest")`.
    bytes32 internal constant _RESERVED_TAG_LATEST_HASH =
        0x5d7c83ff6d08efb2f110018d8b6814a4719a93273a3ea09ced5cfe0d5db1d001;
    /// @dev The ABX collection surface (`contractURI`), not a real token.
    uint256 internal constant _COLLECTION_SENTINEL = type(uint256).max;

    IDirectoryStore public immutable directoryStore;
    IFileStore public immutable fileStore;
    /// @inheritdoc IProjectHook
    address public immutable factory;

    struct TagRecord {
        uint32 version;
        bool exists;
    }

    /// @dev A {Version} as stored, with the project's kind in the spare bytes of its second slot (`publishedAt` and
    ///      `publisher` leave 56 bits free). Every version of a project carries the kind its first publish locked,
    ///      so the lock costs no slot of its own.
    struct StoredVersion {
        bytes32 cid;
        uint40 publishedAt;
        address publisher;
        ContentKind kind;
    }

    mapping(address => mapping(uint256 => StoredVersion[])) internal _versions;

    /// @dev collection => every publish it has ever recorded, in publish order, one slot each:
    ///      `tokenId << 32 | version`. The rest of the record (cid, publisher, time) is that version in
    ///      `_versions`, written in the same call, so nothing is duplicated.
    ///
    ///      Append-only and never mutated: republishing appends, and there is no unpublish. That is
    ///      what makes it a ledger rather than a cache — index N means the same thing forever, so a
    ///      client can page from a stored cursor without re-reading what it already has.
    ///
    ///      It exists because `_versions` is keyed by token and therefore cannot answer "what did
    ///      this collection publish most recently?" without reading every token. This can, in one
    ///      `eth_call` against state — no logs, so no provider retention window to outlive.
    mapping(address => uint256[]) internal _publishLog;

    /// @dev Every publish across every registered org, in publish order. One slot per entry: the org
    ///      address in the high 160 bits and the index of the entry in that org's own `_publishLog` in
    ///      the low 96. Nothing is duplicated, so a crawler follows one cursor here instead of walking
    ///      every org, at the cost of one new storage slot per publish.
    ///
    ///      Unlike everything else in this contract it is NOT namespaced by caller, so it admits only
    ///      collections the factory has registered. Otherwise any contract could append garbage to
    ///      every crawler's feed.
    bytes32[] internal _globalLog;

    mapping(address => mapping(uint256 => mapping(bytes32 => TagRecord))) internal _tagRecords;
    mapping(address => mapping(uint256 => string[])) internal _tagList;
    mapping(address => mapping(uint256 => mapping(bytes32 => uint256))) internal _tagIndexPlusOne;

    constructor(address directoryStore_, address fileStore_, address factory_) {
        directoryStore = IDirectoryStore(directoryStore_);
        fileStore = IFileStore(fileStore_);
        factory = factory_;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The hook
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IAbxConfigureHook
    /// @dev **Unknown keys are ignored, never rejected.** This is the single most important line in
    ///      the contract. Hooks are frozen by `lockParamHooks` and unreachable after the collection
    ///      renounces ownership, while `setParamSchema` can still add a key up until that point — so
    ///      a hook that reverted on anything it did not recognize would permanently forbid every key
    ///      declared after it was armed. Ignoring is also correct on its own terms: this hook's remit
    ///      is the five ABX FS keys, and a key it has no opinion about needs no opinion.
    function onParamConfigured(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        address updatedBy,
        uint256 dataLength,
        address /* dataBlobAddress */
    ) external {
        // The collection surface carries no project. Ignore rather than revert — a write there is
        // legitimate, just not ours.
        if (tokenId == _COLLECTION_SENTINEL) return;

        if (key == KEY_CID) {
            _recordVersion(msg.sender, tokenId, value, updatedBy);
        } else if (key == KEY_NAME) {
            if (dataLength > MAX_NAME_BYTES) revert BlobTooLarge(key, dataLength, MAX_NAME_BYTES);
        } else if (key == KEY_GATEWAY) {
            if (dataLength > MAX_GATEWAY_BYTES) revert BlobTooLarge(key, dataLength, MAX_GATEWAY_BYTES);
        } else if (key == KEY_VIEW) {
            if (dataLength > MAX_VIEW_BYTES) revert BlobTooLarge(key, dataLength, MAX_VIEW_BYTES);
        } else if (key == KEY_META) {
            if (dataLength > MAX_META_BYTES) revert BlobTooLarge(key, dataLength, MAX_META_BYTES);
        }
        // else: not an ABX FS key. See the note above.
    }

    /// @dev Runs before the param persists, so every revert path here is a veto on the publish: `RootNotFound`,
    ///      then `RootKindLocked`, then `SameRoot`.
    function _recordVersion(address token, uint256 tokenId, bytes32 cid, address publisher) internal {
        StoredVersion[] storage history = _versions[token][tokenId];
        uint256 count = history.length;

        ContentKind kind;
        if (count == 0) {
            kind = _deriveKind(cid, false);
        } else {
            ContentKind locked = history[0].kind;
            kind = _deriveKind(cid, locked == ContentKind.File);
            if (kind != locked) revert RootKindLocked(locked, kind);
            if (history[count - 1].cid == cid) revert SameRoot(cid);
        }

        uint256 version = count + 1;
        history.push(StoredVersion({cid: cid, publishedAt: uint40(block.timestamp), publisher: publisher, kind: kind}));

        // The ledgers, appended in the same call that appends the per-token history, so they can never disagree
        // about what was published or when. An entry is `tokenId << 32 | version`, which holds a token id below
        // 2^224 and a version below 2^32. An org's ids are below its supply cap, and a version of 2^32 would take
        // 4.29 billion paid publishes of one token, so only a caller that is not an org can reach either limit. Its
        // publish is then left out of the ledgers (the history above still has it) rather than reverting, which
        // would veto it, or recording an entry that reads back as another token's.
        if ((tokenId >> 224) | (version >> 32) == 0) {
            uint256[] storage log = _publishLog[token];
            log.push((tokenId << 32) | version);

            // The cross-org ledger. Skipped, never reverted, for a caller that is not a registered org:
            // this is a veto, and refusing a legitimate write because of an unrelated registry would be
            // worse than leaving it out of a feed.
            if (_isOrg(token)) {
                _globalLog.push(bytes32((uint256(uint160(token)) << 96) | uint96(log.length - 1)));
            }
        }

        emit ProjectVersionPublished(token, tokenId, version, cid, kind, publisher);
    }

    /// @dev An ABX FS CID is a plain keccak256 hash and carries no type discriminator, so the only way
    ///      to learn whether it addresses a file or a directory is to ask the store that owns it. The
    ///      two stores domain-separate their preimages (`FileStore` prefixes 0x31, `DirectoryStore`
    ///      0x32), so under collision resistance a CID can land in at most one of them, and the order
    ///      they are asked in changes only the gas: a project locked to File asks the file store first,
    ///      every other publish the directory store first. Both calls go to the immutable content stores
    ///      only; nothing here ever calls a storage backend. The empty directory exists without being
    ///      created and an empty file once created, so an empty root publishes like any other.
    function _deriveKind(bytes32 cid, bool fileFirst) internal view returns (ContentKind) {
        if (fileFirst && fileStore.fileExists(cid)) return ContentKind.File;
        if (directoryStore.directoryExists(cid)) return ContentKind.Directory;
        if (!fileFirst && fileStore.fileExists(cid)) return ContentKind.File;
        revert RootNotFound(cid);
    }

    /// @dev Ledger entry `entry` of `token`, as the record it stands for.
    function _record(address token, uint256 entry) internal view returns (PublishRecord memory) {
        uint256 tokenId = entry >> 32;
        uint32 version = uint32(entry);
        StoredVersion storage v = _versions[token][tokenId][version - 1];
        return PublishRecord({
            cid: v.cid, publisher: v.publisher, publishedAt: v.publishedAt, version: version, tokenId: tokenId
        });
    }

    function _version(StoredVersion storage v) internal view returns (Version memory) {
        return Version({cid: v.cid, publishedAt: v.publishedAt, publisher: v.publisher});
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The global publish ledger
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IProjectHook
    function globalPublishCount() external view returns (uint256) {
        return _globalLog.length;
    }

    /// @inheritdoc IProjectHook
    function globalPublishAt(uint256 index) external view returns (address org, uint256 orgIndex) {
        if (index >= _globalLog.length) revert IndexOutOfRange(index, _globalLog.length);
        return _unpack(_globalLog[index]);
    }

    /// @inheritdoc IProjectHook
    function globalPublishRange(uint256 start, uint256 count)
        external
        view
        returns (address[] memory orgs, uint256[] memory orgIndexes)
    {
        uint256 len = _globalLog.length;
        if (start >= len) return (new address[](0), new uint256[](0));
        uint256 end = count > len - start ? len : start + count; // clamps; no overflow for any `count`

        orgs = new address[](end - start);
        orgIndexes = new uint256[](end - start);
        for (uint256 i = start; i < end; ++i) {
            (orgs[i - start], orgIndexes[i - start]) = _unpack(_globalLog[i]);
        }
    }

    function _unpack(bytes32 packed) internal pure returns (address org, uint256 orgIndex) {
        org = address(uint160(uint256(packed) >> 96));
        orgIndex = uint256(uint96(uint256(packed)));
    }

    /// @dev Whether the factory has registered `token`. A raw `staticcall` with a hand-decoded result,
    ///      like the renderers: a call to an address with no code (`address(0)` included) succeeds with
    ///      empty returndata, and a typed decode failure is uncatchable. A veto must not gain a revert
    ///      path from an unrelated contract, so anything other than exactly one canonical `true` word
    ///      reads as "not an org". At most 32 bytes of returndata are copied, whatever the callee returns.
    function _isOrg(address token) internal view returns (bool yes) {
        address f = factory;
        bytes4 selector = IOrgFactory.isOrg.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, shr(96, shl(96, token)))
            let ok := staticcall(gas(), f, 0x00, 0x24, 0x00, 0x20)
            yes := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), 1))
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Tags
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IProjectHook
    function setTag(address token, uint256 tokenId, string calldata tag, uint256 version) external {
        _requireProjectOwner(token, tokenId);
        _validateTag(tag);
        if (_isReservedTag(tag)) revert ReservedTag(tag);

        uint256 count = _versions[token][tokenId].length;
        if (version == 0 || version > count) revert InvalidVersion(version, count);

        bytes32 tagKey = keccak256(bytes(tag));
        TagRecord storage rec = _tagRecords[token][tokenId][tagKey];

        if (rec.exists) {
            uint256 fromVersion = rec.version;
            rec.version = uint32(version);
            emit ProjectTagMoved(token, tokenId, tag, fromVersion, version);
        } else {
            rec.version = uint32(version);
            rec.exists = true;
            _tagList[token][tokenId].push(tag);
            _tagIndexPlusOne[token][tokenId][tagKey] = _tagList[token][tokenId].length;
            emit ProjectTagSet(token, tokenId, tag, version);
        }
    }

    /// @inheritdoc IProjectHook
    function removeTag(address token, uint256 tokenId, string calldata tag) external {
        _requireProjectOwner(token, tokenId);
        _validateTag(tag);
        if (_isReservedTag(tag)) revert ReservedTag(tag);

        bytes32 tagKey = keccak256(bytes(tag));
        TagRecord storage rec = _tagRecords[token][tokenId][tagKey];
        if (!rec.exists) revert TagNotFound(token, tokenId, tag);

        string[] storage list = _tagList[token][tokenId];
        uint256 indexPlusOne = _tagIndexPlusOne[token][tokenId][tagKey];
        uint256 idx = indexPlusOne - 1;
        uint256 lastIndex = list.length - 1;
        if (idx != lastIndex) {
            string memory lastTag = list[lastIndex];
            list[idx] = lastTag;
            _tagIndexPlusOne[token][tokenId][keccak256(bytes(lastTag))] = indexPlusOne;
        }
        list.pop();

        delete _tagIndexPlusOne[token][tokenId][tagKey];
        delete _tagRecords[token][tokenId][tagKey];

        emit ProjectTagRemoved(token, tokenId, tag);
    }

    /// @inheritdoc IProjectHook
    function getTag(address token, uint256 tokenId, string calldata tag)
        external
        view
        returns (uint256 version, bytes32 cid)
    {
        if (_isReservedTag(tag)) return _latest(token, tokenId);

        TagRecord storage rec = _tagRecords[token][tokenId][keccak256(bytes(tag))];
        if (!rec.exists) revert TagNotFound(token, tokenId, tag);
        version = rec.version;
        cid = _versions[token][tokenId][version - 1].cid;
    }

    /// @inheritdoc IProjectHook
    function listTags(address token, uint256 tokenId) external view returns (string[] memory tags) {
        return _tagList[token][tokenId];
    }

    /// @inheritdoc IProjectHook
    function tagCount(address token, uint256 tokenId) external view returns (uint256 count) {
        return _tagList[token][tokenId].length;
    }

    /// @inheritdoc IProjectHook
    function getTagAt(address token, uint256 tokenId, uint256 index)
        external
        view
        returns (string memory tag)
    {
        string[] storage list = _tagList[token][tokenId];
        if (index >= list.length) revert IndexOutOfRange(index, list.length);
        return list[index];
    }

    /// @inheritdoc IProjectHook
    function getTagsRange(address token, uint256 tokenId, uint256 start, uint256 end)
        external
        view
        returns (string[] memory tags)
    {
        string[] storage list = _tagList[token][tokenId];
        uint256 count = list.length;
        if (start > end || end > count) revert RangeOutOfBounds(start, end, count);

        tags = new string[](end - start);
        for (uint256 i = 0; i < tags.length;) {
            tags[i] = list[start + i];
            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // History
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IProjectHook
    function versionCount(address token, uint256 tokenId) external view returns (uint256 count) {
        return _versions[token][tokenId].length;
    }

    /// @inheritdoc IProjectHook
    function versionAt(address token, uint256 tokenId, uint256 version)
        external
        view
        returns (Version memory record)
    {
        uint256 count = _versions[token][tokenId].length;
        if (version == 0 || version > count) revert InvalidVersion(version, count);
        return _version(_versions[token][tokenId][version - 1]);
    }

    /// @inheritdoc IProjectHook
    function versionsRange(address token, uint256 tokenId, uint256 start, uint256 end)
        external
        view
        returns (Version[] memory records)
    {
        StoredVersion[] storage history = _versions[token][tokenId];
        uint256 count = history.length;
        if (start > end || end > count) revert RangeOutOfBounds(start, end, count);

        records = new Version[](end - start);
        for (uint256 i = 0; i < records.length;) {
            records[i] = _version(history[start + i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IProjectHook
    function latestVersion(address token, uint256 tokenId)
        external
        view
        returns (uint256 version, bytes32 cid)
    {
        return _latest(token, tokenId);
    }

    /// @inheritdoc IProjectHook
    function kindOf(address token, uint256 tokenId) external view returns (ContentKind kind) {
        StoredVersion[] storage history = _versions[token][tokenId];
        return history.length == 0 ? ContentKind.Unset : history[0].kind;
    }

    function _latest(address token, uint256 tokenId) internal view returns (uint256 version, bytes32 cid) {
        StoredVersion[] storage history = _versions[token][tokenId];
        uint256 count = history.length;
        if (count == 0) revert NoVersions(token, tokenId);
        return (count, history[count - 1].cid);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev Tags are the one surface this contract authorizes itself, because they are its own state
    ///      rather than an ABX param. `ownerOf` reverting for a nonexistent token propagates, which
    ///      is the right answer. ERC-721 only — an ERC-1155 edition id has many holders and no single
    ///      owner to check, so a shared tag map there would mean "whoever wrote most recently".
    function _requireProjectOwner(address token, uint256 tokenId) internal view {
        if (IERC721Owner(token).ownerOf(tokenId) != msg.sender) {
            revert NotProjectOwner(token, tokenId, msg.sender);
        }
    }

    /// @dev `^[a-z0-9][a-z0-9._-]{0,63}$`. `.` is allowed so semver-shaped tags (`v1.2.3`,
    ///      `v1.2.3-rc.1`) work. Uppercase is rejected so case-folding cannot produce two tags that
    ///      look identical to a human but address differently.
    function _validateTag(string calldata tag) internal pure {
        bytes memory b = bytes(tag);
        uint256 len = b.length;
        if (len == 0 || len > _MAX_TAG_BYTES) revert InvalidTagName(tag);
        if (!_isLowerAlnum(b[0])) revert InvalidTagName(tag);

        for (uint256 i = 1; i < len;) {
            bytes1 c = b[i];
            if (!(_isLowerAlnum(c) || c == "-" || c == "_" || c == ".")) revert InvalidTagName(tag);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev `"latest"` is reserved and virtual: it always resolves to the head, has no storage, and
    ///      cannot be set or removed. That keeps `latest` defined even for a project with no tags.
    function _isReservedTag(string calldata tag) internal pure returns (bool) {
        return keccak256(bytes(tag)) == _RESERVED_TAG_LATEST_HASH;
    }

    function _isLowerAlnum(bytes1 c) internal pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The publish ledger
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IProjectHook
    function publishCount(address token) external view returns (uint256) {
        return _publishLog[token].length;
    }

    /// @inheritdoc IProjectHook
    function publishAt(address token, uint256 index) external view returns (PublishRecord memory) {
        return _record(token, _publishLog[token][index]);
    }

    /// @inheritdoc IProjectHook
    function publishRange(address token, uint256 start, uint256 count)
        external
        view
        returns (PublishRecord[] memory window)
    {
        uint256[] storage log = _publishLog[token];
        uint256 len = log.length;
        if (start >= len) return new PublishRecord[](0);

        // `count` is compared with what is left before it is added to `start`: `type(uint256).max` is a
        // reasonable "give me everything" sentinel, and checked `start + count` would panic on it for any
        // `start > 0`.
        uint256 end = count > len - start ? len : start + count;

        window = new PublishRecord[](end - start);
        for (uint256 i = start; i < end; ++i) {
            window[i - start] = _record(token, log[i]);
        }
    }

    /// @inheritdoc IProjectHook
    function recentPublishes(address token, uint256 count)
        external
        view
        returns (PublishRecord[] memory)
    {
        return _recentBefore(token, _publishLog[token].length, count);
    }

    /// @inheritdoc IProjectHook
    function recentPublishesBefore(address token, uint256 beforeIndex, uint256 count)
        external
        view
        returns (PublishRecord[] memory)
    {
        return _recentBefore(token, beforeIndex, count);
    }

    /// @dev Walks backward from `beforeIndex` (exclusive), newest first.
    ///
    ///      Returning newest-first is the whole point: a feed wants the tip, and reversing a
    ///      thousand-record window client-side to get it would be the caller paying for a decision
    ///      this function can make for free.
    function _recentBefore(address token, uint256 beforeIndex, uint256 count)
        internal
        view
        returns (PublishRecord[] memory window)
    {
        uint256[] storage log = _publishLog[token];
        uint256 len = log.length;
        uint256 end = beforeIndex > len ? len : beforeIndex;
        if (end == 0 || count == 0) return new PublishRecord[](0);

        uint256 n = count > end ? end : count;
        window = new PublishRecord[](n);
        for (uint256 i; i < n; ++i) {
            window[i] = _record(token, log[end - 1 - i]);
        }
    }
}
