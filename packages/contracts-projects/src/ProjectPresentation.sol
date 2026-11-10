// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {IProjectPresentation} from "./interfaces/IProjectPresentation.sol";
import {IProjectHook} from "./interfaces/IProjectHook.sol";

interface IPresentationOrg {
    function ownerOf(uint256 id) external view returns (address);
    function paramHooks() external view returns (address configure, address augment, address transfer);
}

interface IPresentationHook {
    function factory() external view returns (address);
    function fileStore() external view returns (address);
    function directoryStore() external view returns (address);
}

interface IPresentationFactory {
    function isOrg(address org) external view returns (bool);
}

interface IPresentationReader {
    function fileStore() external view returns (address);
    function directoryStore() external view returns (address);
    function resolve(bytes32 root, string calldata path) external view returns (bytes32 cid, bool isDirectory);
    function readPath(bytes32 root, string calldata path, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory mime, bytes memory data);
}

interface IPresentationIpfs {
    function fileStore() external view returns (address);
    function directoryStore() external view returns (address);
    function computeIpfsCid(bytes32 root) external view returns (string memory);
    function computeFileCid(bytes32 root) external view returns (string memory);
}

/// @notice Immutable animation renderer with independent, owner-controlled content, method and endpoint locks.
/// @dev All state is namespaced by org and token. Rendering runs in a bounded self-call: a hostile org,
///      storage backend or resolver can fail that frame without exhausting the fallback frame.
contract ProjectPresentation is IProjectPresentation {
    using LibString for uint256;

    bytes32 public constant LOCK_COMMITMENT_DOMAIN = keccak256("abx-fs/presentation-lock/v1");
    uint8 public constant CONTENT_LOCK = 1;
    uint8 public constant METHOD_LOCK = 2;
    uint8 public constant ENDPOINT_LOCK = 4;
    uint256 public constant MAX_EMBED_BYTES = 8192;
    uint256 public constant MAX_EMBED_CHUNKS = 32;
    uint256 public constant MAX_PATH_BYTES = 2048;
    uint256 public constant MAX_ENDPOINT_BYTES = 512;
    uint256 public constant RENDER_GAS = 5_000_000;
    uint256 internal constant _MAX_RETURN = MAX_EMBED_BYTES + 512;
    uint256 internal constant _RESERVE_GAS = 1_000_000;
    // Qualified against the full ABX tokenURI, including its outer JSON/base64 serialization.
    // Recheck these margins when changing supported ABX renderers or the output ceiling.
    uint256 public constant SERIALIZE_BASE_GAS = 500_000;
    uint256 public constant SERIALIZE_GAS_PER_BYTE = 600;

    IPresentationReader public immutable reader;
    IPresentationIpfs public immutable ipfsResolver;
    address public immutable fileStore;
    address public immutable directoryStore;
    string public defaultChainBase;
    mapping(address => mapping(uint256 => Config)) internal _configs;

    constructor(address reader_, address ipfsResolver_, string memory defaultChainBase_) {
        if (!_endpoint(bytes(defaultChainBase_), false)) revert InvalidConfiguration();
        reader = IPresentationReader(reader_);
        ipfsResolver = IPresentationIpfs(ipfsResolver_);
        fileStore = IPresentationReader(reader_).fileStore();
        directoryStore = IPresentationReader(reader_).directoryStore();
        if (
            fileStore.code.length == 0 || directoryStore.code.length == 0
                || IPresentationIpfs(ipfsResolver_).fileStore() != fileStore
                || IPresentationIpfs(ipfsResolver_).directoryStore() != directoryStore
        ) revert InvalidConfiguration();
        defaultChainBase = defaultChainBase_;
    }

    function config(address org, uint256 tokenId) external view returns (Config memory) {
        return _configs[org][tokenId];
    }

    function setTarget(
        address org,
        uint256 tokenId,
        Selection selection,
        uint32 version,
        string calldata tag,
        string calldata path
    ) external {
        _owner(org, tokenId);
        Config storage c = _configs[org][tokenId];
        if (c.locks & CONTENT_LOCK != 0) revert Locked(CONTENT_LOCK);
        if (
            !_path(bytes(path)) || (selection == Selection.Version ? version == 0 : version != 0)
                || (selection == Selection.Tag ? !_tag(bytes(tag)) : bytes(tag).length != 0)
        ) revert InvalidConfiguration();
        c.selection = selection;
        c.version = version;
        c.tag = tag;
        c.path = path;
        emit TargetChanged(org, tokenId);
    }

    function setMethod(address org, uint256 tokenId, Method method) external {
        _owner(org, tokenId);
        Config storage c = _configs[org][tokenId];
        if (c.locks & METHOD_LOCK != 0) revert Locked(METHOD_LOCK);
        c.method = method;
        emit MethodChanged(org, tokenId, method);
    }

    function setEndpoints(address org, uint256 tokenId, string calldata chainBase, string calldata ipfsBase) external {
        _owner(org, tokenId);
        Config storage c = _configs[org][tokenId];
        if (c.locks & ENDPOINT_LOCK != 0) revert Locked(ENDPOINT_LOCK);
        if (!_endpoint(bytes(chainBase), true) || !_ipfsEndpoint(bytes(ipfsBase))) revert InvalidConfiguration();
        c.chainBase = chainBase;
        c.ipfsBase = ipfsBase;
        emit EndpointsChanged(org, tokenId);
    }

    /// @notice Hash the exact current values being frozen, without coupling unrelated dimensions.
    /// @dev Root/path, method and endpoint pair participate only when their corresponding mask bit is set.
    ///      Already locked content uses its frozen root, so repeating the same lock is idempotent.
    function lockCommitment(address org, uint256 tokenId, uint8 mask) public view returns (bytes32) {
        _validateMask(mask);
        bytes32 root;
        if (mask & CONTENT_LOCK != 0) (root,) = target(org, tokenId);
        return _lockCommitment(org, tokenId, mask, root);
    }

    function lock(address org, uint256 tokenId, uint8 mask, bytes32 expectedCommitment) external {
        _validateMask(mask);
        _owner(org, tokenId);
        Config storage c = _configs[org][tokenId];
        bytes32 root;
        if (mask & CONTENT_LOCK != 0) (root,) = target(org, tokenId);
        bytes32 actual = _lockCommitment(org, tokenId, mask, root);
        if (actual != expectedCommitment) revert StaleCommitment(expectedCommitment, actual);
        if (mask & CONTENT_LOCK != 0 && c.locks & CONTENT_LOCK == 0) {
            // Resolve before the irreversible commitment; a missing path is never silently frozen.
            reader.resolve(root, c.path);
            c.frozenRoot = root;
        }
        c.locks |= mask;
        emit PresentationLocked(org, tokenId, c.locks, c.frozenRoot);
    }

    function _validateMask(uint8 mask) internal pure {
        if (mask == 0 || mask > 7) revert InvalidConfiguration();
    }

    function _lockCommitment(address org, uint256 tokenId, uint8 mask, bytes32 root) internal view returns (bytes32) {
        Config storage c = _configs[org][tokenId];
        bytes32 content = mask & CONTENT_LOCK != 0 ? keccak256(abi.encode(root, c.path)) : bytes32(0);
        bytes32 method = mask & METHOD_LOCK != 0 ? bytes32(uint256(c.method)) : bytes32(0);
        bytes32 endpoints = mask & ENDPOINT_LOCK != 0 ? keccak256(abi.encode(c.chainBase, c.ipfsBase)) : bytes32(0);
        return keccak256(
            abi.encode(
                LOCK_COMMITMENT_DOMAIN, address(this), block.chainid, org, tokenId, mask, content, method, endpoints
            )
        );
    }

    function target(address org, uint256 tokenId) public view returns (bytes32 root, string memory path) {
        Config storage c = _configs[org][tokenId];
        path = c.path;
        if (c.locks & CONTENT_LOCK != 0) return (c.frozenRoot, path);
        IProjectHook h = IProjectHook(_hook(org));
        if (c.selection == Selection.Version) root = h.versionAt(org, tokenId, c.version).cid;
        else if (c.selection == Selection.Tag) (, root) = h.getTag(org, tokenId, c.tag);
        else (, root) = h.latestVersion(org, tokenId);
    }

    function _owner(address org, uint256 tokenId) internal view {
        _hook(org);
        if (IPresentationOrg(org).ownerOf(tokenId) != msg.sender) revert NotProjectOwner();
    }

    function _hook(address org) internal view returns (address h) {
        (h,,) = IPresentationOrg(org).paramHooks();
        IPresentationHook hook = IPresentationHook(h);
        if (
            hook.fileStore() != fileStore || hook.directoryStore() != directoryStore
                || !IPresentationFactory(hook.factory()).isOrg(org)
        ) revert InvalidOrg();
    }

    /// @notice Always returns a bounded result; direct callers can inspect why a presentation is empty.
    function preview(address org, uint256 tokenId)
        public
        view
        returns (Status status, string memory contentType, bytes memory data)
    {
        if (tokenId == type(uint256).max) return (Status.Unpublished, "text/plain", "");
        if (gasleft() <= _RESERVE_GAS) return (Status.OverBudget, "text/plain", "");
        bytes memory input = abi.encodeCall(this.evaluate, (org, tokenId));
        bytes memory ret;
        bool ok;
        uint256 cap = gasleft() - _RESERVE_GAS;
        if (cap > RENDER_GAS) cap = RENDER_GAS;
        uint256 maxReturn = _MAX_RETURN;
        address self = address(this);
        assembly ("memory-safe") {
            ok := staticcall(cap, self, add(input, 32), mload(input), 0, 0)
            let n := returndatasize()
            if gt(n, maxReturn) {
                ok := 0
                n := 0
            }
            ret := mload(0x40)
            mstore(ret, n)
            returndatacopy(add(ret, 32), 0, n)
            mstore(0x40, add(add(ret, 64), and(add(n, 31), not(31))))
        }
        if (!ok || ret.length < 96) return (Status.ReadFailed, "text/plain", "");
        uint256 s = uint256(_word(ret, 0));
        (bytes memory mime, bool validMime) = _slice(ret, 1, 64);
        (bytes memory payload, bool validPayload) = _slice(ret, 2, MAX_EMBED_BYTES);
        if (s > uint256(Status.OverBudget) || !validMime || !validPayload) {
            return (Status.ReadFailed, "text/plain", "");
        }
        // A successful source may spend almost the entire evaluation budget. Returning its large
        // payload then would leave ABX too little gas to serialize tokenURI, despite this frame
        // surviving. Refuse the payload while the fallback still has ample gas to finish.
        if (s == uint256(Status.Ready) && gasleft() < SERIALIZE_BASE_GAS + SERIALIZE_GAS_PER_BYTE * payload.length) {
            return (Status.OverBudget, "text/plain", "");
        }
        return (Status(s), string(mime), payload);
    }

    function render(address org, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != bytes32("animation_url")) return ("text/plain", "");
        (Status s, string memory mime, bytes memory payload) = preview(org, tokenId);
        if (s != Status.Ready) return ("text/plain", "");
        return (mime, payload);
    }

    /// @dev External only to isolate all untrusted calls behind preview's gas and return-data budget.
    function evaluate(address org, uint256 tokenId) external view returns (Status, string memory, bytes memory) {
        if (msg.sender != address(this)) revert InvalidConfiguration();
        bytes32 root;
        string memory path;
        try this.target(org, tokenId) returns (bytes32 r, string memory p) {
            root = r;
            path = p;
        } catch (bytes memory reason) {
            bytes4 selector;
            if (reason.length >= 4) assembly { selector := mload(add(reason, 32)) }
            return (
                selector == IProjectHook.NoVersions.selector ? Status.Unpublished : Status.InvalidTarget,
                "text/plain",
                ""
            );
        }
        Config storage c = _configs[org][tokenId];
        if (c.method == Method.Embedded) {
            try reader.readPath(root, path, MAX_EMBED_BYTES, MAX_EMBED_CHUNKS) returns (
                string memory mime, bytes memory data
            ) {
                if (data.length > MAX_EMBED_BYTES) return (Status.ReadFailed, "text/plain", "");
                if (!_mime(mime)) return (Status.UnsupportedMime, "text/plain", "");
                return (Status.Ready, mime, data);
            } catch (bytes memory reason) {
                bytes4 selector;
                if (reason.length >= 4) assembly { selector := mload(add(reason, 32)) }
                if (selector == bytes4(keccak256("CodecNotSupported(bytes32)"))) {
                    return (Status.UnsupportedCodec, "text/plain", "");
                }
                if (
                    selector == bytes4(keccak256("ByteLimitExceeded(uint256,uint256)"))
                        || selector == bytes4(keccak256("ChunkLimitExceeded(uint256,uint256)"))
                ) return (Status.OverBudget, "text/plain", "");
                return (Status.ReadFailed, "text/plain", "");
            }
        }
        bool directory;
        bool selectedDirectory;
        try reader.resolve(root, "") returns (bytes32, bool d) {
            directory = d;
            selectedDirectory = d;
        } catch {
            return (Status.InvalidTarget, "text/plain", "");
        }
        // Validate the selected path as well, without reading any file bytes.
        if (bytes(path).length != 0) {
            try reader.resolve(root, path) returns (bytes32, bool d) {
                selectedDirectory = d;
            } catch {
                return (Status.InvalidTarget, "text/plain", "");
            }
        }
        if (c.method == Method.ChainGateway) {
            string memory base = bytes(c.chainBase).length == 0 ? defaultChainBase : c.chainBase;
            return (
                Status.Ready,
                "text/uri-list",
                bytes(
                    string.concat(
                        base,
                        "/g/cid/",
                        block.chainid.toString(),
                        "/",
                        LibString.toHexString(uint256(root), 32),
                        _suffix(path, selectedDirectory)
                    )
                )
            );
        }
        try this.ipfsUri(root, directory, selectedDirectory, path, c.ipfsBase) returns (string memory uri) {
            return (Status.Ready, "text/uri-list", bytes(uri));
        } catch {
            return (Status.IpfsFailed, "text/plain", "");
        }
    }

    function ipfsUri(bytes32 root, bool directory, bool selectedDirectory, string calldata path, string calldata base)
        external
        view
        returns (string memory)
    {
        if (msg.sender != address(this)) revert InvalidConfiguration();
        string memory cid = directory ? ipfsResolver.computeIpfsCid(root) : ipfsResolver.computeFileCid(root);
        if (!_cid(bytes(cid))) revert InvalidConfiguration();
        if (bytes(base).length == 0) return string.concat("ipfs://", cid, _suffix(path, selectedDirectory));
        bytes memory host = bytes(base);
        bytes memory hostname = new bytes(host.length - 8);
        for (uint256 i; i < hostname.length; ++i) {
            hostname[i] = host[i + 8];
        }
        return string.concat("https://", cid, ".ipfs.", string(hostname), _suffix(path, selectedDirectory));
    }

    function _mime(string memory mime) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(mime));
        return h == keccak256("text/html") || h == keccak256("image/svg+xml") || h == keccak256("image/png")
            || h == keccak256("image/jpeg") || h == keccak256("image/gif") || h == keccak256("image/webp")
            || h == keccak256("image/avif") || h == keccak256("audio/mpeg") || h == keccak256("audio/wav")
            || h == keccak256("audio/ogg") || h == keccak256("video/mp4") || h == keccak256("video/webm");
    }

    function _endpoint(bytes memory b, bool empty) internal pure returns (bool) {
        if (b.length == 0) return empty;
        if (b.length < 9 || b.length > MAX_ENDPOINT_BYTES || bytes8(b) != "https://" || b[b.length - 1] == "/") {
            return false;
        }
        for (uint256 i = 8; i < b.length; ++i) {
            bytes1 c = b[i];
            if (
                c <= 0x20 || c >= 0x7f || c == '"' || c == "'" || c == "<" || c == ">" || c == "\\" || c == "`"
                    || c == "?" || c == "#"
            ) return false;
        }
        return true;
    }

    function _suffix(string memory path, bool directory) internal pure returns (string memory) {
        if (bytes(path).length == 0) return directory ? "/" : "";
        return string.concat("/", _encodePath(bytes(path)), directory ? "/" : "");
    }

    function _ipfsEndpoint(bytes memory b) internal pure returns (bool) {
        if (b.length == 0) return true;
        if (!_endpoint(b, false) || b.length > 196) return false;
        bool labelStart = true;
        for (uint256 i = 8; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == ".") {
                if (labelStart || b[i - 1] == "-") return false;
                labelStart = true;
            } else {
                if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-")) {
                    return false;
                }
                if (labelStart && c == "-") return false;
                labelStart = false;
            }
        }
        return !labelStart && b[b.length - 1] != "-";
    }

    function _tag(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > 64) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool alnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
            if (!alnum && (i == 0 || (c != "." && c != "_" && c != "-"))) return false;
        }
        return true;
    }

    function _path(bytes memory b) internal pure returns (bool) {
        if (b.length == 0) return true;
        if (b.length > MAX_PATH_BYTES) return false;
        uint256 start;
        uint256 depth;
        for (uint256 i; i <= b.length; ++i) {
            if (i < b.length && b[i] != "/") {
                if (b[i] == "\\" || b[i] < 0x20 || b[i] == 0x7f) return false;
                continue;
            }
            uint256 n = i - start;
            if (n == 0 || n > 255 || (n == 1 && b[start] == ".") || (n == 2 && b[start] == "." && b[start + 1] == ".")) return false;
            if (++depth > 32) return false;
            start = i + 1;
        }
        return true;
    }

    function _encodePath(bytes memory b) internal pure returns (string memory) {
        bytes memory out = new bytes(b.length * 3);
        bytes16 hexChars = "0123456789ABCDEF";
        uint256 n;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (
                (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 46 || c == 95
                    || c == 126 || c == 47
            ) {
                out[n++] = bytes1(c);
            } else {
                out[n++] = "%";
                out[n++] = hexChars[c >> 4];
                out[n++] = hexChars[c & 15];
            }
        }
        assembly { mstore(out, n) }
        return string(out);
    }

    function _cid(bytes memory b) internal pure returns (bool) {
        if (b.length != 59 || b[0] != "b") return false;
        for (uint256 i = 1; i < b.length; ++i) {
            if (!((b[i] >= "a" && b[i] <= "z") || (b[i] >= "2" && b[i] <= "7"))) return false;
        }
        return true;
    }

    function _word(bytes memory ret, uint256 i) internal pure returns (bytes32 w) {
        if (ret.length < (i + 1) * 32) return 0;
        assembly { w := mload(add(add(ret, 32), mul(i, 32))) }
    }

    function _slice(bytes memory ret, uint256 i, uint256 cap) internal pure returns (bytes memory out, bool valid) {
        uint256 offset = uint256(_word(ret, i));
        if (offset < 96 || offset > ret.length || ret.length - offset < 32) return ("", false);
        uint256 len;
        assembly { len := mload(add(add(ret, 32), offset)) }
        if (len > cap || len > ret.length - offset - 32) return ("", false);
        out = new bytes(len);
        assembly ("memory-safe") { mcopy(add(out, 32), add(add(ret, 64), offset), len) }
        valid = true;
    }
}
