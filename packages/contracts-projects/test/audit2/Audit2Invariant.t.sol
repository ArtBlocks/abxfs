// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {ProjectEnumeration} from "../../src/ProjectEnumeration.sol";
import {OrgMinter} from "../../src/OrgMinter.sol";
import {IProjectHook} from "../../src/interfaces/IProjectHook.sol";
import {IA2Coll} from "./Audit2Base.sol";

/// @dev Two stores with separate dir / file membership, standing in for the content layer (the hook's whole
///      relationship with it is `directoryExists` / `fileExists`).
contract A2Store {
    mapping(bytes32 => bool) public has;

    function add(bytes32 c) external {
        has[c] = true;
    }

    function directoryExists(bytes32 c) external view returns (bool) {
        return has[c];
    }

    function fileExists(bytes32 c) external view returns (bool) {
        return has[c];
    }
}

interface IHandlerNotes {
    function noteVersion(address org, uint256 id, bytes32 root) external;
    function noteTag(address org, uint256 id, uint256 tagIdx, uint256 version) external;
}

/// @dev A contract holder with hostile callbacks. Mode picks what `onERC721Received` does.
contract A2Receiver {
    uint8 public mode;
    address public next;
    IHandlerNotes public h;
    ProjectHook public hook;
    bytes32 public root;
    uint256[6] public fired;

    constructor(address h_, address hook_) {
        h = IHandlerNotes(h_);
        hook = ProjectHook(hook_);
    }

    function configure(uint8 mode_, address next_, bytes32 root_) external {
        mode = mode_;
        next = next_;
        root = root_;
    }

    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        IA2Coll c = IA2Coll(msg.sender);
        ++fired[mode];
        if (mode == 1 && next != address(0)) {
            try c.transferFrom(address(this), next, id) {} catch {}
        } else if (mode == 2) {
            try c.configureTokenParam(id, "abxfs.cid", root) {
                h.noteVersion(msg.sender, id, root);
            } catch {}
        } else if (mode == 3) {
            try hook.setTag(msg.sender, id, "a", 1) {
                h.noteTag(msg.sender, id, 0, 1);
            } catch {}
        } else if (mode == 4) {
            try c.transferFrom(address(this), from, id) {} catch {}
        } else if (mode == 5) {
            revert("no thanks");
        }
        return this.onERC721Received.selector;
    }

    // contract holders must be able to initiate too
    function doTransfer(address org, address to, uint256 id) external {
        IA2Coll(org).transferFrom(address(this), to, id);
    }

    function doApprove(address org, address op, uint256 id) external {
        IA2Coll(org).approve(op, id);
    }

    function doPublish(address org, uint256 id, bytes32 r) external {
        IA2Coll(org).configureTokenParam(id, "abxfs.cid", r);
    }

    function doTag(address org, uint256 id, string calldata t, uint256 v) external {
        hook.setTag(org, id, t, v);
    }

    function doMintAsAdmin(OrgMinter m, address org, address to) external {
        m.mint(org, to);
    }

    function doSetOpen(OrgFactory f, address org, bool o) external {
        f.setOpen(org, o);
    }

    function doTransferAdmin(OrgFactory f, address org, address to) external {
        f.transferAdmin(org, to);
    }

    function doAccept(OrgFactory f, address org) external {
        f.acceptAdmin(org);
    }

    function doCreate(OrgFactory f, string calldata nm) external returns (address) {
        return f.createOrg(nm, "", bytes32(0));
    }
}

contract A2Handler is Test {
    address constant ABX_F = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;

    OrgFactory public f;
    ProjectHook public hook;
    ProjectEnumeration public en;
    OrgMinter public minter;
    A2Store public store;
    A2Store public fileStore;

    address[] public orgs;
    address[] public actors; // EOAs then receivers
    uint256 public nEoa = 5;
    A2Receiver[] public receivers;
    bytes32[5] public roots; // 0..2 dir, 3..4 file
    string[6] public tagPool = ["a", "b", "v1", "v2.0", "x-y_z", "latest"];

    // ghost: publishing
    mapping(address => mapping(uint256 => bytes32[])) internal gCids;
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) public gTag; // org,token,tagIdx => version
    struct GL {
        address org;
        uint256 id;
        uint256 version;
        bytes32 root;
    }
    GL[] internal gLedger;
    mapping(address => uint256) public gOrgPublishes;
    // ghost: admin registry
    mapping(address => address) public gAdmin;
    mapping(address => address) public gPending;
    mapping(address => bool) public gOpen;

    // "must not revert" violations observed by the handler
    uint256 public violations;
    string public lastViolation;

    uint256 public calls;
    uint256 public okMint;
    uint256 public okTransfer;
    uint256 public okSafeToReceiver;
    uint256 public okPublish;
    uint256 public okTag;
    uint256 public okRemoveTag;
    uint256 public okAdmin;
    uint256 public okOpen;
    uint256 public okApprovedMove;

    constructor() {
        store = new A2Store();
        fileStore = new A2Store();
        f = OrgComponents.create(ABX_F, ABX_RENDERER, ABX_SEED, address(store), address(fileStore), address(new OrgMeta("https://fs.abx.io")));
        hook = f.hook();
        en = f.enumeration();
        minter = f.minter();
        for (uint256 i; i < 5; ++i) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
            roots[i] = keccak256(abi.encode("a2-root", i));
            if (i < 3) store.add(roots[i]);
            else fileStore.add(roots[i]);
        }
        for (uint256 i; i < 2; ++i) {
            A2Receiver r = new A2Receiver(address(this), address(hook));
            receivers.push(r);
            actors.push(address(r));
        }
        _create(0);
        _create(1);
    }

    function _create(uint256 who) internal {
        address a = actors[who % actors.length];
        address org;
        vm.prank(a);
        try f.createOrg(string.concat("O", vm.toString(orgs.length)), "", bytes32(0)) returns (address o) {
            org = o;
        } catch {
            _viol("createOrg reverted");
            return;
        }
        orgs.push(org);
        gAdmin[org] = a;
    }

    function _viol(string memory s) internal {
        ++violations;
        lastViolation = s;
    }

    // ── notes from receivers ────────────────────────────────────────────────
    function noteVersion(address org, uint256 id, bytes32 root) external {
        _recordPublish(org, id, root);
    }

    function noteTag(address org, uint256 id, uint256 tagIdx, uint256 version) external {
        gTag[org][id][tagIdx] = version;
    }

    function _recordPublish(address org, uint256 id, bytes32 root) internal {
        gCids[org][id].push(root);
        gLedger.push(GL(org, id, gCids[org][id].length, root));
        ++gOrgPublishes[org];
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    function _org(uint256 s) internal view returns (address) {
        return orgs[s % orgs.length];
    }

    function _tokenOf(address org, uint256 s) internal view returns (bool ok, uint256 id) {
        uint256 n = IA2Coll(org).nextTokenId();
        if (n == 0) return (false, 0);
        return (true, s % n);
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    /// @dev Bias callers toward the party that can actually act, so the campaign reaches deep states.
    function _pick(address preferred, uint256 s) internal view returns (address) {
        if (preferred != address(0) && s % 5 < 4) return preferred;
        return _actor(s / 5);
    }

    function _isRecv(address a) internal view returns (bool, A2Receiver) {
        for (uint256 i; i < receivers.length; ++i) {
            if (address(receivers[i]) == a) return (true, receivers[i]);
        }
        return (false, A2Receiver(address(0)));
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function mint(uint256 so, uint256 sc, uint256 st) external {
        ++calls;
        address org = _org(so);
        address caller = _pick(gAdmin[org], sc);
        address to = _actor(st);
        if (IA2Coll(org).nextTokenId() >= 12) return; // keep checks cheap
        bool may = f.mayMint(org, caller);
        bool ok;
        vm.prank(caller);
        try minter.mint(org, to) returns (uint256) { ok = true; } catch {}
        if (ok) ++okMint;
        if (ok != may) _viol("mint outcome != mayMint");
    }

    function transfer(uint256 so, uint256 st, uint256 sc, uint256 sto, uint256 kind) external {
        ++calls;
        address org = _org(so);
        (bool has, uint256 id) = _tokenOf(org, st);
        if (!has) return;
        IA2Coll c = IA2Coll(org);
        address owner_ = c.ownerOf(id);
        address approved_ = c.getApproved(id);
        address caller = sc % 6 < 3 ? owner_ : (sc % 6 == 3 && approved_ != address(0) ? approved_ : _actor(sc / 6));
        address to = _actor(sto);
        bool authorized = caller == owner_ || c.getApproved(id) == caller || c.isApprovedForAll(owner_, caller);
        uint8 k = uint8(kind % 3);
        (bool toRecv, A2Receiver rr) = _isRecv(to);
        // transferFrom never calls the receiver; the safe variants do, and mode 5 rejects
        bool recvAccepts = !toRecv || k == 0 || rr.mode() != 5;
        bool ok;
        vm.prank(caller);
        if (k == 0) {
            try c.transferFrom(owner_, to, id) { ok = true; } catch {}
        } else if (k == 1) {
            try c.safeTransferFrom(owner_, to, id) { ok = true; } catch {}
        } else {
            try c.safeTransferFrom(owner_, to, id, hex"00") { ok = true; } catch {}
        }
        if (ok) {
            ++okTransfer;
            if (toRecv && k != 0) ++okSafeToReceiver;
            if (caller != owner_) ++okApprovedMove;
        }
        // a legitimate transfer must never be vetoed by an ABX FS hook; an unauthorised one must never land
        if (authorized && recvAccepts && !ok) _viol("authorized transfer reverted");
        if (!authorized && ok) _viol("unauthorized transfer succeeded");
        if (authorized && !recvAccepts && ok) _viol("rejecting receiver was delivered to");
    }

    function approve(uint256 so, uint256 st, uint256 sc, uint256 sop, bool forAll) external {
        ++calls;
        address org = _org(so);
        (bool has, uint256 id) = _tokenOf(org, st);
        if (!has) return;
        address caller = _pick(IA2Coll(org).ownerOf(id), sc);
        address op = _actor(sop);
        bool cur = IA2Coll(org).isApprovedForAll(caller, op);
        vm.prank(caller);
        if (forAll) {
            try IA2Coll(org).setApprovalForAll(op, !cur) {} catch {}
        } else {
            try IA2Coll(org).approve(op, id) {} catch {}
        }
    }

    function publish(uint256 so, uint256 st, uint256 sc, uint256 sr) external {
        ++calls;
        address org = _org(so);
        (bool has, uint256 id) = _tokenOf(org, st);
        if (!has) return;
        IA2Coll c = IA2Coll(org);
        address caller = _pick(IA2Coll(org).ownerOf(id), sc);
        bytes32 root = roots[sr % 5];
        bytes32[] storage hist = gCids[org][id];
        bool isOwner = c.ownerOf(id) == caller;
        bool kindOk = hist.length == 0 || (_isDir(root) == _isDir(hist[0]));
        bool fresh = hist.length == 0 || hist[hist.length - 1] != root;
        bool ok;
        vm.prank(caller);
        try c.configureTokenParam(id, "abxfs.cid", root) { ok = true; } catch {}
        if (ok) { ++okPublish; _recordPublish(org, id, root); }
        bool should = isOwner && kindOk && fresh;
        if (should != ok) _viol("publish outcome != prediction");
    }

    function _isDir(bytes32 r) internal view returns (bool) {
        for (uint256 i; i < 3; ++i) if (roots[i] == r) return true;
        return false;
    }

    function tag(uint256 so, uint256 st, uint256 sc, uint256 stag, uint256 sv, bool remove) external {
        ++calls;
        address org = _org(so);
        (bool has, uint256 id) = _tokenOf(org, st);
        if (!has) return;
        address caller = _pick(IA2Coll(org).ownerOf(id), sc);
        uint256 ti = stag % 6;
        uint256 count = gCids[org][id].length;
        bool isOwner = IA2Coll(org).ownerOf(id) == caller;
        bool ok;
        if (!remove) {
            uint256 v = sv % (count + 2); // 0..count+1
            vm.prank(caller);
            try hook.setTag(org, id, tagPool[ti], v) { ok = true; } catch {}
            bool should = isOwner && ti != 5 && v >= 1 && v <= count;
            if (should != ok) _viol("setTag outcome != prediction");
            if (ok) { ++okTag; gTag[org][id][ti] = v; }
        } else {
            vm.prank(caller);
            try hook.removeTag(org, id, tagPool[ti]) { ok = true; } catch {}
            bool should = isOwner && ti != 5 && gTag[org][id][ti] != 0;
            if (should != ok) _viol("removeTag outcome != prediction");
            if (ok) { ++okRemoveTag; gTag[org][id][ti] = 0; }
        }
    }

    function configureReceiver(uint256 sr, uint256 mode, uint256 snext, uint256 sroot) external {
        ++calls;
        A2Receiver r = receivers[sr % receivers.length];
        r.configure(uint8(mode % 6), _actor(snext), roots[sroot % 5]);
    }

    function createOrgAction(uint256 sc) external {
        ++calls;
        if (orgs.length >= 4) return;
        _create(sc);
    }

    function setOpen(uint256 so, uint256 sc, bool o) external {
        ++calls;
        address org = _org(so);
        address caller = _pick(gAdmin[org], sc);
        bool ok;
        vm.prank(caller);
        try f.setOpen(org, o) { ok = true; } catch {}
        bool should = gAdmin[org] == caller;
        if (should != ok) _viol("setOpen outcome != prediction");
        if (ok) { ++okOpen; gOpen[org] = o; }
    }

    function transferAdmin(uint256 so, uint256 sc, uint256 sto) external {
        ++calls;
        address org = _org(so);
        address caller = _pick(gAdmin[org], sc);
        address to = _actor(sto);
        bool ok;
        vm.prank(caller);
        try f.transferAdmin(org, to) { ok = true; } catch {}
        bool should = gAdmin[org] == caller;
        if (should != ok) _viol("transferAdmin outcome != prediction");
        if (ok) gPending[org] = to;
    }

    function acceptAdmin(uint256 so, uint256 sc) external {
        ++calls;
        address org = _org(so);
        address caller = _pick(gPending[org], sc);
        bool ok;
        vm.prank(caller);
        try f.acceptAdmin(org) { ok = true; } catch {}
        bool should = gPending[org] == caller;
        if (should != ok) _viol("acceptAdmin outcome != prediction");
        if (ok) {
            ++okAdmin;
            gAdmin[org] = caller;
            gPending[org] = address(0);
            gOpen[org] = false;
        }
    }

    // ── invariant checks (each returns "" when it holds) ───────────────────

    function receiverFired(uint256 i, uint256 m) external view returns (uint256) {
        return receivers[i].fired(m);
    }

    function orgCount() external view returns (uint256) {
        return orgs.length;
    }

    function checkEnumeration() external view returns (string memory) {
        for (uint256 oi; oi < orgs.length; ++oi) {
            address org = orgs[oi];
            IA2Coll c = IA2Coll(org);
            uint256 n = c.nextTokenId();
            // The org's own token set is `0 .. nextTokenId - 1` (sequential, not burnable): what replaced a tracked set.
            if (c.totalSupply() != n) return "supply != nextTokenId (burn?)";
            for (uint256 t; t < n; ++t) {
                if (en.trackedOwnerOf(org, t) != c.ownerOf(t)) return "trackedOwner != ownerOf";
            }
            uint256 sum;
            for (uint256 a; a < actors.length; ++a) {
                address h = actors[a];
                uint256 bal = c.balanceOf(h);
                if (en.balanceOfTracked(org, h) != bal) return "balanceOfTracked != balanceOf";
                uint256[] memory list = en.tokensOfOwner(org, h);
                if (list.length != bal) return "tokensOfOwner length";
                for (uint256 i; i < list.length; ++i) {
                    if (c.ownerOf(list[i]) != h) return "listed token not owned";
                    for (uint256 j; j < i; ++j) if (list[j] == list[i]) return "duplicate in owner list";
                }
                sum += bal;
            }
            if (sum != n) return "sum of balances != supply (token held by non-actor?)";
        }
        return "";
    }

    function checkOrgsHeld() external view returns (string memory) {
        for (uint256 a; a < actors.length; ++a) {
            address h = actors[a];
            address[] memory held = en.orgsHeldBy(h);
            if (en.orgsHeldCount(h) != held.length) return "orgsHeldCount";
            uint256 expect;
            for (uint256 oi; oi < orgs.length; ++oi) {
                bool holds = IA2Coll(orgs[oi]).balanceOf(h) > 0;
                bool listed;
                for (uint256 i; i < held.length; ++i) if (held[i] == orgs[oi]) listed = true;
                if (holds != listed) return "orgsHeldBy membership";
                if (holds) ++expect;
            }
            if (held.length != expect) return "orgsHeldBy has extras or duplicates";
        }
        return "";
    }

    function checkHistory() external view returns (string memory) {
        for (uint256 oi; oi < orgs.length; ++oi) {
            address org = orgs[oi];
            uint256 n = IA2Coll(org).nextTokenId();
            uint256 total;
            for (uint256 t; t < n; ++t) {
                total += gCids[org][t].length;
                string memory r = _checkToken(org, t);
                if (bytes(r).length != 0) return r;
                r = _checkTags(org, t);
                if (bytes(r).length != 0) return r;
            }
            if (hook.publishCount(org) != total) return "publishCount != sum of versions";
            if (hook.publishCount(org) != gOrgPublishes[org]) return "publishCount != ghost";
        }
        return "";
    }

    function _checkToken(address org, uint256 t) internal view returns (string memory) {
        bytes32[] storage g = gCids[org][t];
        if (hook.versionCount(org, t) != g.length) return "versionCount != ghost";
        (bytes32 pv,, bool set) = IA2Coll(org).tokenParam(t, "abxfs.cid");
        if (g.length == 0) {
            if (set) return "param set with no versions";
            if (uint8(hook.kindOf(org, t)) != 0) return "kind set with no versions";
            return "";
        }
        if (!set || pv != g[g.length - 1]) return "ABX param head != last version";
        (uint256 lv, bytes32 lc) = hook.latestVersion(org, t);
        if (lv != g.length || lc != g[g.length - 1]) return "latestVersion";
        uint8 wantKind = _isDir(g[0]) ? 1 : 2;
        if (uint8(hook.kindOf(org, t)) != wantKind) return "kind lock";
        for (uint256 v; v < g.length; ++v) {
            if (hook.versionAt(org, t, v + 1).cid != g[v]) return "versionAt cid";
            if (v > 0 && g[v] == g[v - 1]) return "consecutive duplicate recorded";
            if (_isDir(g[v]) != _isDir(g[0])) return "mixed kinds recorded";
        }
        return "";
    }

    function _checkTags(address org, uint256 t) internal view returns (string memory) {
        bytes32[] storage g = gCids[org][t];
        uint256 expectTags;
        for (uint256 ti; ti < 5; ++ti) if (gTag[org][t][ti] != 0) ++expectTags;
        if (hook.tagCount(org, t) != expectTags) return "tagCount";
        string[] memory listed = hook.listTags(org, t);
        if (listed.length != expectTags) return "listTags length";
        for (uint256 ti; ti < 5; ++ti) {
            uint256 gv = gTag[org][t][ti];
            if (gv == 0) {
                try hook.getTag(org, t, tagPool[ti]) returns (uint256, bytes32) {
                    return "removed tag still resolves";
                } catch {}
            } else {
                (uint256 v, bytes32 cc) = hook.getTag(org, t, tagPool[ti]);
                if (v != gv || cc != g[gv - 1]) return "getTag";
                bool found;
                for (uint256 i; i < listed.length; ++i) {
                    if (keccak256(bytes(listed[i])) == keccak256(bytes(tagPool[ti]))) found = true;
                }
                if (!found) return "tag missing from list";
            }
        }
        if (g.length != 0) {
            (uint256 lv2, bytes32 lc2) = hook.getTag(org, t, "latest");
            if (lv2 != g.length || lc2 != g[g.length - 1]) return "latest tag";
        }
        return "";
    }

    function _isDirV(bytes32 r) internal view returns (bool) {
        return _isDir(r);
    }

    function checkLedgers() external view returns (string memory) {
        uint256 len = hook.globalPublishCount();
        if (len != gLedger.length) return "globalPublishCount != ghost";
        uint256 sum;
        for (uint256 oi; oi < orgs.length; ++oi) sum += hook.publishCount(orgs[oi]);
        if (sum != len) return "global != sum of per-org";
        uint256[8] memory next; // per-org next expected index
        for (uint256 i; i < len; ++i) {
            (address org, uint256 idx) = hook.globalPublishAt(i);
            uint256 oi = type(uint256).max;
            for (uint256 j; j < orgs.length; ++j) if (orgs[j] == org) oi = j;
            if (oi == type(uint256).max) return "global entry for unknown org";
            if (idx != next[oi]) return "per-org index not strictly sequential";
            next[oi] = idx + 1;
            IProjectHook.PublishRecord memory r = hook.publishAt(org, idx);
            GL memory g = gLedger[i];
            if (g.org != org || r.tokenId != g.id || r.cid != g.root || r.version != g.version) return "ledger record != ghost";
        }
        return "";
    }

    function checkRegistry() external view returns (string memory) {
        if (f.orgCount() != orgs.length) return "orgCount";
        for (uint256 oi; oi < orgs.length; ++oi) {
            address org = orgs[oi];
            if (!f.isOrg(org)) return "isOrg";
            if (f.orgAt(oi) != org) return "orgAt";
            if (f.adminOf(org) != gAdmin[org]) return "adminOf";
            if (f.pendingAdminOf(org) != gPending[org]) return "pendingAdminOf";
            if (f.isOpen(org) != gOpen[org]) return "isOpen";
        }
        for (uint256 a; a < actors.length; ++a) {
            address h = actors[a];
            address[] memory list = f.orgsAdministered(h);
            uint256 expect;
            for (uint256 oi; oi < orgs.length; ++oi) {
                bool is_ = gAdmin[orgs[oi]] == h;
                bool listed;
                for (uint256 i; i < list.length; ++i) if (list[i] == orgs[oi]) listed = true;
                if (is_ != listed) return "orgsAdministered membership";
                if (is_) ++expect;
            }
            if (list.length != expect) return "orgsAdministered extras/duplicates";
            if (f.orgsAdministeredCount(h) != expect) return "orgsAdministeredCount";
        }
        return "";
    }
}

contract Audit2Invariant is Test {
    A2Handler h;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        h = new A2Handler();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = A2Handler.mint.selector;
        sels[1] = A2Handler.transfer.selector;
        sels[2] = A2Handler.approve.selector;
        sels[3] = A2Handler.publish.selector;
        sels[4] = A2Handler.tag.selector;
        sels[5] = A2Handler.configureReceiver.selector;
        sels[6] = A2Handler.createOrgAction.selector;
        sels[7] = A2Handler.setOpen.selector;
        sels[8] = A2Handler.transferAdmin.selector;
        sels[9] = A2Handler.acceptAdmin.selector;
        sels[10] = A2Handler.mint.selector; // weight mints
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function afterInvariant() public {
        emit log_named_uint("handler calls", h.calls());
        emit log_named_uint("ok mints", h.okMint());
        emit log_named_uint("ok transfers", h.okTransfer());
        emit log_named_uint("  of which by an approved operator", h.okApprovedMove());
        emit log_named_uint("  safe transfers into a contract", h.okSafeToReceiver());
        emit log_named_uint("ok publishes", h.okPublish());
        emit log_named_uint("ok setTag", h.okTag());
        emit log_named_uint("ok removeTag", h.okRemoveTag());
        emit log_named_uint("ok acceptAdmin", h.okAdmin());
        emit log_named_uint("ok setOpen", h.okOpen());
        for (uint256 i; i < 2; ++i) {
            for (uint256 m; m < 6; ++m) {
                emit log_named_uint(string.concat("receiver ", vm.toString(i), " callbacks in mode ", vm.toString(m)), h.receiverFired(i, m));
            }
        }
    }

    function _ok(string memory r) internal pure {
        assertEq(bytes(r).length, 0, r);
    }

    /// forge-config: default.invariant.runs = 60
    /// forge-config: default.invariant.depth = 150
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_everything() public view {
        _ok(h.checkEnumeration());
        _ok(h.checkOrgsHeld());
        _ok(h.checkHistory());
        _ok(h.checkLedgers());
        _ok(h.checkRegistry());
        assertEq(h.violations(), 0, h.lastViolation());
    }

    /// A directed long sequence driven through the same handler with success-biased callers and hostile
    /// receiver modes switched on most of the time. Checks the invariants after EVERY op (the invariant
    /// campaign checks after every call too, but reaches deep states rarely).
    /// forge-config: default.fuzz.runs = 40
    function test_hostileSequenceCoverageReport() public {
        _longSequence(0xC0FFEE);
    }

    function testFuzz_longHostileSequence(uint256 seed) public {
        _longSequence(seed);
    }

    function _longSequence(uint256 seed) internal {
        uint256 s = seed;
        for (uint256 i; i < 400; ++i) {
            s = uint256(keccak256(abi.encode(s, i)));
            _step(s);
            if (i % 13 == 0) _checkAll();
        }
        _checkAll();
        emit log_named_uint("ok transfers", h.okTransfer());
        emit log_named_uint("ok safe transfers into contracts", h.okSafeToReceiver());
        emit log_named_uint("ok publishes", h.okPublish());
        emit log_named_uint("ok setTag", h.okTag());
        emit log_named_uint("ok removeTag", h.okRemoveTag());
        emit log_named_uint("receiver callbacks: forward", h.receiverFired(0, 1) + h.receiverFired(1, 1));
        emit log_named_uint("receiver callbacks: publish-in-callback", h.receiverFired(0, 2) + h.receiverFired(1, 2));
        emit log_named_uint("receiver callbacks: tag-in-callback", h.receiverFired(0, 3) + h.receiverFired(1, 3));
        emit log_named_uint("receiver callbacks: bounce-back", h.receiverFired(0, 4) + h.receiverFired(1, 4));
    }

    function _step(uint256 seed) internal {
        uint256 a = seed >> 8;
        uint256 b = seed >> 40;
        uint256 c = seed >> 72;
        uint256 d = seed >> 104;
        uint256 e = seed >> 136;
        uint256 w = seed % 100;
        if (w < 8) h.mint(a, b, c);
        else if (w < 28) h.transfer(a, b, c, d, e);
        else if (w < 34) h.approve(a, b, c, d, e % 2 == 0);
        else if (w < 52) h.publish(a, b, c, d);
        else if (w < 80) _tagStep(seed);
        else if (w < 90) h.configureReceiver(a, 1 + (b % 4), c, d);
        else if (w < 92) h.createOrgAction(a);
        else if (w < 95) h.setOpen(a, b, c % 2 == 0);
        else if (w < 98) h.transferAdmin(a, b, c);
        else h.acceptAdmin(a, b);
    }

    function _tagStep(uint256 seed) internal {
        bool rm = (seed >> 200) % 5 < 2;
        h.tag(seed >> 8, seed >> 40, seed >> 72, seed >> 104, seed >> 136, rm);
    }

    function _checkAll() internal view {
        _ok(h.checkEnumeration());
        _ok(h.checkOrgsHeld());
        _ok(h.checkHistory());
        _ok(h.checkLedgers());
        _ok(h.checkRegistry());
        assertEq(h.violations(), 0, h.lastViolation());
    }

    /// The checks have teeth: corrupting what each reads (by mocking the SUT's view) makes it report.
    function test_checksHaveTeeth() public {
        // a published, tagged, transferred project so every check has something to look at
        h.publish(0, 0, 0, 0); // org 0, token 0, owner (actor 0 -> index bias) , root 0
        _ok(h.checkEnumeration());
        address org = h.orgs(0);
        address a0 = h.actors(0);

        vm.mockCall(address(h.en()), abi.encodeWithSignature("balanceOfTracked(address,address)", org, a0), abi.encode(uint256(7)));
        assertGt(bytes(h.checkEnumeration()).length, 0, "enumeration check bites");
        vm.clearMockedCalls();

        vm.mockCall(address(h.en()), abi.encodeWithSignature("orgsHeldBy(address)", a0), abi.encode(new address[](0)));
        assertGt(bytes(h.checkOrgsHeld()).length, 0, "orgs-held check bites");
        vm.clearMockedCalls();

        vm.mockCall(address(h.hook()), abi.encodeWithSignature("versionCount(address,uint256)", org, uint256(0)), abi.encode(uint256(9)));
        assertGt(bytes(h.checkHistory()).length, 0, "history check bites");
        vm.clearMockedCalls();

        vm.mockCall(address(h.hook()), abi.encodeWithSignature("globalPublishCount()"), abi.encode(uint256(99)));
        assertGt(bytes(h.checkLedgers()).length, 0, "ledger check bites");
        vm.clearMockedCalls();

        vm.mockCall(address(h.f()), abi.encodeWithSignature("isOpen(address)", org), abi.encode(true));
        assertGt(bytes(h.checkRegistry()).length, 0, "registry check bites");
        vm.clearMockedCalls();
        _ok(h.checkEnumeration());
        _ok(h.checkRegistry());
    }
}
