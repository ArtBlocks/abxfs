// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAbxTransferHook} from "./interfaces/IAbxTransferHook.sol";
import {IOrgFactory} from "./interfaces/IOrgFactory.sol";

/// @title ProjectEnumeration — on-chain ownership enumeration for ABX FS project tokens
/// @author ABX FS
///
/// @notice ABX collections are not `ERC721Enumerable`, so without this hook "which projects does this
///         address own?" could only be answered by replaying every inbound `Transfer` log since the
///         collection's deploy block and confirming each candidate with `ownerOf`. Providers prune
///         logs, so that scan eventually fails outright, and its cost grows with chain age.
///
///         This hook moves that index on-chain. Ownership is recorded as it changes, so the question
///         becomes a state read whose cost depends on the size of the answer, never on the chain's
///         age, and which no provider can prune. It is the same move the configure hook makes for
///         version history.
///
///         It does not list a collection's whole token set: an org numbers its tokens `0, 1, 2, …` in
///         mint order and nothing in it can be burned, so its tokens are exactly `0 … nextTokenId() - 1`,
///         which the org itself answers.
///
/// @dev    **One cross-collection index, and it is gated.** Besides the per-collection lists, this
///         contract answers "which orgs does this address hold projects in?" — the one question the
///         per-collection lists cannot, and what lets a wallet find its orgs with no indexer. That
///         list is NOT namespaced by caller, so it admits only collections `factory` has registered;
///         otherwise any contract could write itself into a victim's list. The check is a raw
///         `staticcall` with a hand-decoded result and runs only when the recipient holds no other
///         counted token in the collection, so a transfer to an existing holder pays nothing for it.
///
///         **Everything else is namespaced by `msg.sender`.** One deployment serves every collection, and a
///         forged call can only corrupt the caller's own namespace — the same property
///         `ProjectHook` relies on. That is why this contract is NOT constructor-pinned to a
///         single token: pinning is the alternative ABX documents for hooks that key state some
///         other way, and namespacing is strictly more useful here.
///
///         **This hook must never revert.** It is a veto: ABX calls it from `_afterTokenTransfer`
///         with no try/catch, so a revert fails the transfer — and a mint is a transfer from
///         `address(0)`, so it fails minting too. Worse, `lockParamHooks()` would make that
///         permanent. Every branch below is therefore written to REPAIR a disagreement rather than
///         assert against it. A token leaves whoever the index RECORDS as its owner, whatever `from`
///         says, and a record that does not match the lists is treated as "nowhere to unlink", never
///         indexed blindly; the index converges on the truth and the collection is never stranded.
///
///         Accounting is O(1) per move (swap-and-pop), paid by whoever moves the token. That cost is the
///         price of the query being free and permanent, and it is disclosed rather than hidden.
contract ProjectEnumeration is IAbxTransferHook {
    // ──────────────────────────────────────────────────────────────────────────
    // Storage — namespaced by the calling collection, except the org-held index below
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev What this hook records for one token, in one slot: the owner it believes holds the token and the
    ///      token's 1-based position in that owner's list (`_owned`). Both are set or both are clear when a transfer
    ///      returns.
    ///
    ///      The owner is deliberately not read from the token. The hook runs after the move is applied, so `ownerOf`
    ///      already returns `to`; the pre-image needed for removal exists only here. It is also what makes repair
    ///      possible when a reported `from` disagrees with what was recorded.
    struct Holding {
        address owner;
        uint96 indexPlusOne;
    }

    /// @dev What an owner holds in one registered org, in one slot: how many tokens (counted only for registered
    ///      orgs) and the org's 1-based position in `_orgsHeld[owner]`. A nonzero count implies the org passed the
    ///      registry check when the count left zero, so it is not re-checked while the count stays nonzero.
    struct OrgHolding {
        uint128 count;
        uint128 indexPlusOne;
    }

    /// @notice The factory whose orgs are admitted to the org-held index. Fixed at deployment.
    address public immutable factory;

    /// @dev owner => registered orgs in which they hold at least one counted token.
    mapping(address => address[]) internal _orgsHeld;
    /// @dev owner => org => what they hold there.
    mapping(address => mapping(address => OrgHolding)) internal _orgHolding;

    /// @dev collection => owner => tokens held. Order is not meaningful; swap-and-pop reorders it.
    mapping(address => mapping(address => uint256[])) internal _owned;
    /// @dev collection => tokenId => its record.
    mapping(address => mapping(uint256 => Holding)) internal _holding;

    constructor(address factory_) {
        factory = factory_;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The hook
    // ──────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IAbxTransferHook
    ///
    /// @dev No access-control revert, by design. Authentication here is structural: every write is
    ///      keyed by `msg.sender` except the org-held index, which admits only registered orgs, so a
    ///      forged call writes only into the forger's own namespace and cannot touch a real
    ///      collection's index. Reverting on an unexpected caller would add a revert path to a veto
    ///      for no security benefit.
    function onTokenTransfer(
        uint256 tokenId,
        address from,
        address to,
        address, /* operator */
        uint256 /* amount */
    ) external {
        // A self-transfer changes no ownership set. ABX delivers these on ERC-721 (it filters them only
        // for ERC-1155), and remove-then-add would churn storage to reach the same state.
        if (from == to) return;

        address collection = msg.sender;
        Holding storage h = _holding[collection][tokenId];

        // The token leaves whoever the index RECORDS as holding it, which is not necessarily the `from` the
        // token reported. Trusting `from` would let one disagreement — a move that happened before this hook
        // was armed, say — desynchronize the index permanently, or revert and brick the collection. A mint of a
        // token that still has a record (only a caller that is not an org can produce one) unlinks it the same
        // way, so no token is ever listed under two owners.
        address recorded = h.owner;
        if (recorded != address(0)) _unlink(collection, tokenId, recorded, h.indexPlusOne);

        if (to == address(0)) {
            delete _holding[collection][tokenId];
        } else {
            uint256[] storage list = _owned[collection][to];
            list.push(tokenId);
            _holding[collection][tokenId] = Holding({owner: to, indexPlusOne: uint96(list.length)});
            _incHeld(collection, to);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice How many tokens of `collection` this hook records `owner` as holding.
    function balanceOfTracked(address collection, address owner) external view returns (uint256) {
        return _owned[collection][owner].length;
    }

    /// @notice Token at `index` of `owner`'s holdings. Order is arbitrary and unstable across moves. Reverts with an
    ///         array-bounds panic past the end.
    function tokenOfOwnerByIndex(address collection, address owner, uint256 index)
        external
        view
        returns (uint256)
    {
        return _owned[collection][owner][index];
    }

    /// @notice Every token `owner` holds in `collection`.
    /// @dev Unbounded. Fine for the sizes ABX FS projects realistically reach and for `eth_call`,
    ///      which is where it is meant to be used — but {tokensOfOwnerSlice} exists for callers that
    ///      cannot assume that, and nothing on-chain should call this.
    function tokensOfOwner(address collection, address owner)
        external
        view
        returns (uint256[] memory)
    {
        return _owned[collection][owner];
    }

    /// @notice A window of `owner`'s holdings, for paging past what one `eth_call` will return.
    /// @dev Clamps rather than reverting on an overrun: a paging caller that walks off the end
    ///      should get an empty tail, not an error it has to special-case.
    function tokensOfOwnerSlice(address collection, address owner, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory window)
    {
        uint256[] storage src = _owned[collection][owner];
        uint256 len = src.length;
        if (start >= len) return new uint256[](0);
        uint256 end = count > len - start ? len : start + count; // clamps; no overflow for any `count`
        window = new uint256[](end - start);
        for (uint256 i = start; i < end; ++i) {
            window[i - start] = src[i];
        }
    }

    /// @notice Registered orgs in which `owner` holds at least one token. Order is not stable.
    function orgsHeldBy(address owner) external view returns (address[] memory) {
        return _orgsHeld[owner];
    }

    function orgsHeldCount(address owner) external view returns (uint256) {
        return _orgsHeld[owner].length;
    }

    /// @notice A window of {orgsHeldBy}, clamping rather than reverting on an overrun.
    function orgsHeldSlice(address owner, uint256 start, uint256 count)
        external
        view
        returns (address[] memory window)
    {
        address[] storage src = _orgsHeld[owner];
        uint256 len = src.length;
        if (start >= len) return new address[](0);
        uint256 end = count > len - start ? len : start + count; // clamps; no overflow for any `count`
        window = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            window[i - start] = src[i];
        }
    }

    /// @notice The owner this hook recorded for `tokenId`, or `address(0)` if it never saw the token or saw it burned.
    /// @dev The token contract remains the authority on ownership. This is what the index believes,
    ///      exposed so a disagreement is diagnosable rather than invisible.
    function trackedOwnerOf(address collection, uint256 tokenId) external view returns (address) {
        return _holding[collection][tokenId].owner;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev Take `tokenId` out of `recorded`'s list and count. The record's position is used only if the list
    ///      really holds the token there: a position that is zero, past the end or names another token cannot be
    ///      corrected without a scan, so nothing is popped (an array panic, or removing the wrong token, would be
    ///      worse). The token leaves `recorded` either way, so the org-held count drops either way. Through this
    ///      hook's own entry point the record always matches; only corrupted storage reaches the other case.
    function _unlink(address collection, uint256 tokenId, address recorded, uint256 indexPlusOne) internal {
        uint256[] storage list = _owned[collection][recorded];
        uint256 len = list.length;
        if (indexPlusOne != 0 && indexPlusOne <= len && list[indexPlusOne - 1] == tokenId) {
            uint256 last = len - 1;
            if (indexPlusOne - 1 != last) {
                uint256 moved = list[last];
                list[indexPlusOne - 1] = moved;
                _holding[collection][moved].indexPlusOne = uint96(indexPlusOne);
            }
            list.pop();
        }
        _decHeld(collection, recorded);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // The org-held index
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev Never reverts. The registry is consulted only while the count is zero; for a collection that is
    ///      not an org that is every time, since its count never leaves zero.
    function _incHeld(address collection, address owner) internal {
        OrgHolding storage o = _orgHolding[owner][collection];
        uint256 c = o.count;
        if (c != 0) {
            o.count = uint128(c + 1);
            return;
        }
        if (!_isOrg(collection)) return;
        address[] storage list = _orgsHeld[owner];
        list.push(collection);
        _orgHolding[owner][collection] = OrgHolding({count: 1, indexPlusOne: uint128(list.length)});
    }

    /// @dev Never reverts, and repairs rather than asserts: a zero count means the token was never
    ///      counted (the collection was not an org when it arrived), so there is nothing to undo, and a
    ///      position that does not name this org in the list is cleared without popping anything.
    function _decHeld(address collection, address owner) internal {
        OrgHolding storage o = _orgHolding[owner][collection];
        uint256 c = o.count;
        if (c == 0) return;
        if (c != 1) {
            o.count = uint128(c - 1);
            return;
        }
        uint256 indexPlusOne = o.indexPlusOne;
        delete _orgHolding[owner][collection];

        address[] storage list = _orgsHeld[owner];
        uint256 len = list.length;
        if (indexPlusOne != 0 && indexPlusOne <= len && list[indexPlusOne - 1] == collection) {
            uint256 last = len - 1;
            if (indexPlusOne - 1 != last) {
                address moved = list[last];
                list[indexPlusOne - 1] = moved;
                _orgHolding[owner][moved].indexPlusOne = uint128(indexPlusOne);
            }
            list.pop();
        }
    }

    /// @dev See the contract note. Anything other than exactly one canonical `true` word reads as "not an org"; a
    ///      call to an address with no code (`address(0)` included) returns nothing. At most 32 bytes of returndata
    ///      are copied, whatever the callee returns.
    function _isOrg(address collection) internal view returns (bool yes) {
        address f = factory;
        bytes4 selector = IOrgFactory.isOrg.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, shr(96, shl(96, collection)))
            let ok := staticcall(gas(), f, 0x00, 0x24, 0x00, 0x20)
            yes := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), 1))
        }
    }
}
