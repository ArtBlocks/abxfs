// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../src/interfaces/IProjectPresentation.sol";
import {IProjectHook} from "../src/interfaces/IProjectHook.sol";

contract PresentationFactoryMock {
    bool public registered = true;

    function setRegistered(bool b) external {
        registered = b;
    }

    function isOrg(address) external view returns (bool) {
        return registered;
    }
}

contract PresentationHookMock {
    address public factory;
    address public fileStore;
    address public directoryStore;
    bytes32 public head = bytes32(uint256(1));
    bytes32 public tagged = bytes32(uint256(1));
    bool public unpublished;
    bytes public failure;

    function setFailure(bytes calldata reason) external { failure = reason; }

    constructor(address f, address files, address dirs) {
        factory = f;
        fileStore = files;
        directoryStore = dirs;
    }

    function publish(bytes32 root) external {
        head = root;
    }

    function moveTag(bytes32 root) external {
        tagged = root;
    }

    function setUnpublished(bool b) external {
        unpublished = b;
    }

    function latestVersion(address, uint256) external view returns (uint256, bytes32) {
        bytes memory reason = failure;
        if (reason.length != 0) assembly { revert(add(reason, 32), mload(reason)) }
        if (unpublished) revert IProjectHook.NoVersions(address(0), 0);
        return (2, head);
    }

    function getTag(address, uint256, string calldata) external view returns (uint256, bytes32) {
        return (1, tagged);
    }

    function versionAt(address, uint256, uint256) external pure returns (IProjectHook.Version memory) {
        return IProjectHook.Version(bytes32(uint256(1)), 1, address(1));
    }
}

contract PresentationOrgMock {
    address public owner;
    address public hook;
    uint256 public malicious;
    mapping(bytes32 => bytes32) public params;

    constructor(address h, address o) {
        hook = h;
        owner = o;
    }

    function transfer(address o) external {
        require(msg.sender == owner);
        owner = o;
    }

    function ownerOf(uint256) external view returns (address) {
        return owner;
    }

    function setMalicious(uint256 m) external {
        malicious = m;
    }

    function paramHooks() external view returns (address, address, address) {
        if (malicious == 1) assembly { for {} 1 {} {} }
        if (malicious == 2) assembly { return(0, 0x1000000) }
        if (malicious == 3) assembly { return(0, 32) }
        return (hook, address(0), address(0));
    }

    function configureTokenParam(uint256, bytes32 key, bytes32 value) external {
        params[key] = value;
    }
}

contract PresentationReaderMock {
    error CodecNotSupported(bytes32 codec);
    error RootNotFound(bytes32 root);
    error PathNotFound(string path);
    error NotDirectory(bytes32 root);
    error RetrieveFailed(bytes32 chunk, address backend);
    bytes public resolutionFailure;

    function setResolutionFailure(bytes calldata reason) external { resolutionFailure = reason; }
    error ByteLimitExceeded(uint256 required, uint256 maximum);
    error ChunkLimitExceeded(uint256 required, uint256 maximum);
    address public fileStore;
    address public directoryStore;
    uint256 public mode;
    string public mime = "text/html";
    bool public directory = true;

    constructor(address f, address d) {
        fileStore = f;
        directoryStore = d;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function setMime(string calldata m) external {
        mime = m;
    }

    function setDirectory(bool d) external {
        directory = d;
    }

    function resolve(bytes32 root, string calldata path) external view returns (bytes32, bool) {
        if (mode == 11) assembly { return(0, 32) }
        bytes memory reason = resolutionFailure;
        if (reason.length != 0) assembly { revert(add(reason, 32), mload(reason)) }
        if (root == bytes32(0)) revert RootNotFound(root);
        if (keccak256(bytes(path)) == keccak256("missing")) revert PathNotFound(path);
        if (!directory && bytes(path).length != 0) revert NotDirectory(root);
        return (root, directory && (bytes(path).length == 0 || keccak256(bytes(path)) == keccak256("nested")));
    }

    function readPath(bytes32, string calldata, uint256 maxBytes, uint256 maxChunks)
        external
        view
        returns (string memory, bytes memory)
    {
        require(maxBytes == type(uint256).max && maxChunks == type(uint256).max);
        if (mode == 1) assembly { for {} 1 {} {} }
        if (mode == 2) assembly { return(0, 0x1000000) }
        if (mode == 3) revert CodecNotSupported(bytes32("gzip"));
        if (mode == 4) revert ByteLimitExceeded(1, 0);
        if (mode == 6) revert ChunkLimitExceeded(1, 0);
        if (mode == 7) return (mime, new bytes(16_385));
        if (mode == 5) {
            assembly {
                mstore(0, 0xffffffffffffffff)
                return(0, 32)
            }
        }
        if (mode == 10) revert RetrieveFailed(bytes32(uint256(1)), address(this));
        if (mode == 8) return (mime, new bytes(102_400));
        if (mode == 9) {
            // A caller with enough gas can render a source that uses more than the old fixed 5M allowance.
            uint256 start = gasleft();
            while (start - gasleft() < 6_000_000) {}
            return (mime, bytes("expensive but successful"));
        }
        return (mime, bytes("<html>on chain</html>"));
    }
}

contract PresentationIpfsMock {
    address public fileStore;
    address public directoryStore;
    uint256 public mode;
    string internal constant CID = "baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    constructor(address f, address d) {
        fileStore = f;
        directoryStore = d;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function computeIpfsCid(bytes32 root) external view returns (string memory) {
        require(root == bytes32(uint256(1))); // Must derive the full directory, not its selected file.
        if (mode == 1) assembly { for {} 1 {} {} }
        if (mode == 2) assembly { return(0, 0x1000000) }
        if (mode == 3) revert("CodecNotSupported");
        return CID;
    }

    function computeFileCid(bytes32) external pure returns (string memory) {
        return CID;
    }
}

contract ProjectPresentationTest is Test {
    ProjectPresentation internal p;
    PresentationFactoryMock internal factory;
    PresentationHookMock internal hook;
    PresentationOrgMock internal org;
    PresentationReaderMock internal reader;
    PresentationIpfsMock internal ipfs;
    address internal constant OTHER = address(0x1234);
    string internal constant CID = "baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    function setUp() public {
        address files = address(0x100);
        address dirs = address(0x200);
        vm.etch(files, hex"00");
        vm.etch(dirs, hex"00");
        factory = new PresentationFactoryMock();
        hook = new PresentationHookMock(address(factory), files, dirs);
        org = new PresentationOrgMock(address(hook), address(this));
        reader = new PresentationReaderMock(files, dirs);
        ipfs = new PresentationIpfsMock(files, dirs);
        p = new ProjectPresentation(address(reader), address(ipfs), "https://fs.abx.io");
    }

    function _render() internal view returns (string memory mime, bytes memory data) {
        return p.render(address(org), 0, "animation_url");
    }

    function _embedded() internal {
        p.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
    }

    function test_defaultRawRootGatewayAndEncodedPath() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "a b/%?.html");
        (string memory mime, bytes memory data) = _render();
        assertEq(mime, "text/uri-list");
        assertEq(
            string(data),
            string.concat(
                "https://fs.abx.io/g/cid/",
                vm.toString(block.chainid),
                "/0x0000000000000000000000000000000000000000000000000000000000000001/a%20b/%25%3F.html"
            )
        );
    }

    function test_embeddedReturnsActualMimeAndContent() public {
        _embedded();
        (string memory mime, bytes memory data) = _render();
        assertEq(mime, "text/html");
        assertEq(string(data), "<html>on chain</html>");
    }

    function test_onlyOwnerAndRegisteredOrgMayWrite() public {
        vm.prank(OTHER);
        vm.expectRevert(IProjectPresentation.NotProjectOwner.selector);
        p.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
        factory.setRegistered(false);
        vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
        p.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
    }

    function test_contentLockSnapshotsTagAndIgnoresFuturePublish() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Tag, 0, "stable", "index.html");
        p.lock(address(org), 0, uint8(1), p.lockCommitment(address(org), 0, uint8(1)));
        hook.publish(bytes32(uint256(2)));
        hook.moveTag(bytes32(uint256(3)));
        (bytes32 root, string memory path) = p.target(address(org), 0);
        assertEq(root, bytes32(uint256(1)));
        assertEq(path, "index.html");
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.Locked.selector, uint8(1)));
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "");
        p.setEndpoints(address(org), 0, "https://replacement.example", "");
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (, bytes memory data) = _render();
        assertEq(string(data), string.concat("ipfs://", CID, "/index.html"));
    }

    function test_latestAndVersionSnapshotAndIdempotentLocks() public {
        p.lock(address(org), 0, uint8(1), p.lockCommitment(address(org), 0, uint8(1)));
        hook.publish(bytes32(uint256(9)));
        p.lock(address(org), 0, uint8(1), p.lockCommitment(address(org), 0, uint8(1)));
        (bytes32 root,) = p.target(address(org), 0);
        assertEq(root, bytes32(uint256(1)));
        p.setTarget(address(org), 1, IProjectPresentation.Selection.Version, 1, "", "");
        p.lock(address(org), 1, uint8(1), p.lockCommitment(address(org), 1, uint8(1)));
        (root,) = p.target(address(org), 1);
        assertEq(root, bytes32(uint256(1)));
    }

    function test_methodAndEndpointLocksIndependentAcrossTransfer() public {
        p.lock(address(org), 0, uint8(2), p.lockCommitment(address(org), 0, uint8(2)));
        p.setEndpoints(address(org), 0, "https://chain.example", "https://ipfs.example");
        org.transfer(OTHER);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.Locked.selector, uint8(2)));
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        bytes32 commitment = p.lockCommitment(address(org), 0, uint8(4));
        vm.prank(OTHER);
        p.lock(address(org), 0, uint8(4), commitment);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.Locked.selector, uint8(4)));
        p.setEndpoints(address(org), 0, "", "");
        vm.prank(OTHER);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "index.html");
    }

    function test_endpointLockStillAllowsMethodSwitch() public {
        p.setEndpoints(address(org), 0, "https://chain.example", "https://ipfs.example");
        p.lock(address(org), 0, uint8(4), p.lockCommitment(address(org), 0, uint8(4)));
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (, bytes memory data) = _render();
        assertEq(string(data), string.concat("https://", CID, ".ipfs.ipfs.example/"));
    }

    function test_postParamsCannotBypassAnyLock() public {
        p.lock(address(org), 0, 7, p.lockCommitment(address(org), 0, 7));
        (, bytes memory beforeData) = _render();
        org.configureTokenParam(0, "abxfs.view", bytes32("https://attacker.example"));
        org.configureTokenParam(0, "abxfs.gateway", bytes32("https://attacker.example"));
        org.configureTokenParam(0, "abxfs.cid", bytes32(uint256(99)));
        (, bytes memory afterData) = _render();
        assertEq(beforeData, afterData);
    }

    function test_noCodeSentinelWrongFieldAndUnpublishedSafe() public {
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, IProjectPresentation.Status.ReadFailed));
        p.render(address(0xdead), 0, "animation_url");
        (, bytes memory data) = p.render(address(org), type(uint256).max, "animation_url");
        assertEq(data.length, 0);
        (, data) = p.render(address(org), 0, "image");
        assertEq(data.length, 0);
        hook.setUnpublished(true);
        (, data) = _render();
        assertEq(data.length, 0);
    }

    function test_mimeInjectionAndUnsupportedMimeRefused() public {
        _embedded();
        reader.setMime("text/html,<script>alert(1)</script>");
        (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.UnsupportedMime));
        (, bytes memory data) = _render();
        assertEq(data.length, 0);
    }

    function test_catchableReaderFailuresKeepMethodAndReturnTypedStatuses() public {
        _embedded();
        p.lock(address(org), 0, uint8(2), p.lockCommitment(address(org), 0, uint8(2)));
        uint256[5] memory modes = [uint256(3), 4, 5, 6, 10];
        for (uint256 i; i < modes.length; ++i) {
            reader.setMode(modes[i]);
            (IProjectPresentation.Status status,, bytes memory data) = p.preview(address(org), 0);
            assertEq(uint256(status), uint256(modes[i] == 3 ? IProjectPresentation.Status.UnsupportedCodec : IProjectPresentation.Status.ReadFailed));
            assertEq(data.length, 0);
            if (modes[i] != 3) {
                vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, status));
                _render();
            }
            assertEq(uint256(p.config(address(org), 0).method), uint256(IProjectPresentation.Method.Embedded));
        }
    }

    function test_resourceExhaustionDoesNotChangeLockedConfiguration() public {
        _embedded();
        p.lock(address(org), 0, uint8(2), p.lockCommitment(address(org), 0, uint8(2)));
        for (uint256 mode = 1; mode <= 2; ++mode) {
            reader.setMode(mode);
            // Resource/dependency failures must fail rendering, preserving the owner's configured method.
            (bool ok,) = address(p).staticcall{gas: 2_000_000}(
                abi.encodeCall(p.render, (address(org), 0, bytes32("animation_url")))
            );
            assertFalse(ok, "resource failure must not become successful neutral metadata");
            assertEq(uint256(p.config(address(org), 0).method), uint256(IProjectPresentation.Method.Embedded));
        }
    }

    function test_ipfsFailuresDoNotFallbackToGateway() public {
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        p.lock(address(org), 0, uint8(2), p.lockCommitment(address(org), 0, uint8(2)));
        ipfs.setMode(3);
        (IProjectPresentation.Status status,, bytes memory data) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.IpfsFailed));
        assertEq(data.length, 0);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, status));
        _render();
        for (uint256 mode = 1; mode <= 2; ++mode) {
            ipfs.setMode(mode);
            (bool ok,) = address(p).staticcall{gas: 2_000_000}(
                abi.encodeCall(p.render, (address(org), 0, bytes32("animation_url")))
            );
            assertFalse(ok, "IPFS resource failure must fail metadata");
        }
        assertEq(uint256(p.config(address(org), 0).method), uint256(IProjectPresentation.Method.Ipfs));
    }

    function test_hostileOrgResourceOrMalformedReturnCannotBecomeSuccessfulMetadata() public {
        for (uint256 mode = 1; mode <= 3; ++mode) {
            org.setMalicious(mode);
            (bool ok,) = address(p).staticcall{gas: 2_000_000}(
                abi.encodeCall(p.render, (address(org), 0, bytes32("animation_url")))
            );
            assertFalse(ok, "resource failure must not become successful neutral metadata");
        }
    }

    function test_invalidPathsAndFailedContentLockLeaveStateMutable() public {
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "../index.html");
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "missing");
        bytes32 commitment = p.lockCommitment(address(org), 0, uint8(1));
        vm.expectRevert();
        p.lock(address(org), 0, uint8(1), commitment);
        assertEq(p.config(address(org), 0).locks, 0);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "index.html");
    }

    function test_directorySuffixAndFileRootUriShape() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "nested");
        (, bytes memory data) = _render();
        assertTrue(bytes(data)[data.length - 1] == "/");
        reader.setDirectory(false);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "");
        (, data) = _render();
        assertTrue(bytes(data)[data.length - 1] != "/");
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (, data) = _render();
        assertEq(string(data), string.concat("ipfs://", CID));
    }

    function testFuzz_lockBitsOnlyAccumulate(uint8 first, uint8 second) public {
        first = uint8(bound(first, 1, 7));
        second = uint8(bound(second, 1, 7));
        p.lock(address(org), 0, first, p.lockCommitment(address(org), 0, first));
        org.transfer(OTHER);
        bytes32 commitment = p.lockCommitment(address(org), 0, second);
        vm.prank(OTHER);
        p.lock(address(org), 0, second, commitment);
        assertEq(p.config(address(org), 0).locks, first | second);
    }

    function test_ipfsEndpointRejectsSharedOriginPathAndUserinfo() public {
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.setEndpoints(address(org), 0, "", "https://gateway.example/ipfs");
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.setEndpoints(address(org), 0, "", "https://user@gateway.example");
    }

    function test_unpublishedAndMissingTargetStatusDiffer() public {
        hook.setUnpublished(true);
        (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Unpublished));
        hook.setUnpublished(false);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "missing");
        (status,,) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.InvalidTarget));
    }

    function test_targetOnlyRecognizesCompleteSemanticHookErrors() public {
        bytes[3] memory semantic = [
            abi.encodeWithSelector(IProjectHook.NoVersions.selector, address(org), uint256(0)),
            abi.encodeWithSelector(IProjectHook.InvalidVersion.selector, uint256(3), uint256(2)),
            abi.encodeWithSelector(IProjectHook.TagNotFound.selector, address(org), uint256(0), "missing")
        ];
        for (uint256 i; i < semantic.length; ++i) {
            hook.setFailure(semantic[i]);
            (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
            assertEq(uint256(status), uint256(i == 0 ? IProjectPresentation.Status.Unpublished : IProjectPresentation.Status.InvalidTarget));
            (, bytes memory data) = _render();
            assertEq(data.length, 0);
        }
        bytes[4] memory unexpected = [
            abi.encodeWithSignature("DependencyFailed(uint256)", 1),
            abi.encodePacked(IProjectHook.NoVersions.selector),
            abi.encodePacked(IProjectHook.TagNotFound.selector, bytes32(0), bytes32(0), bytes32(uint256(96))),
            abi.encodeWithSignature("Error(string)", "transport or dependency failure")
        ];
        for (uint256 i; i < unexpected.length; ++i) {
            hook.setFailure(unexpected[i]);
            (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
            assertEq(uint256(status), uint256(IProjectPresentation.Status.ReadFailed));
            vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, status));
            _render();
        }
    }

    function test_resolveUnexpectedAndMalformedFailuresAreNotMissingTargets() public {
        bytes[3] memory failures = [
            abi.encodeWithSignature("RetrieveFailed(bytes32,address)", bytes32(uint256(1)), address(reader)),
            abi.encodeWithSignature("Panic(uint256)", uint256(0x41)),
            abi.encodePacked(PresentationReaderMock.PathNotFound.selector)
        ];
        for (uint256 i; i < failures.length; ++i) {
            reader.setResolutionFailure(failures[i]);
            (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
            assertEq(uint256(status), uint256(IProjectPresentation.Status.ReadFailed));
            vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, status));
            _render();
        }
        reader.setResolutionFailure(abi.encodeWithSelector(PresentationReaderMock.PathNotFound.selector, "missing"));
        (IProjectPresentation.Status missing,,) = p.preview(address(org), 0);
        assertEq(uint256(missing), uint256(IProjectPresentation.Status.InvalidTarget));
        (, bytes memory data) = _render();
        assertEq(data.length, 0);
    }

    function test_malformedResolveReturnIsIndeterminate() public {
        reader.setMode(11);
        (IProjectPresentation.Status status,,) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.ReadFailed));
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.RenderFailed.selector, status));
        _render();
    }

    function test_staleRootCannotBeFrozenAndNoLockStateChanges() public {
        bytes32 reviewed = p.lockCommitment(address(org), 0, 7);
        hook.publish(bytes32(uint256(2)));
        bytes32 actual = p.lockCommitment(address(org), 0, 7);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.StaleCommitment.selector, reviewed, actual));
        p.lock(address(org), 0, 7, reviewed);
        assertEq(p.config(address(org), 0).locks, 0);
        p.lock(address(org), 0, 7, actual);
        assertEq(p.config(address(org), 0).frozenRoot, bytes32(uint256(2)));
    }

    function test_invalidMaskIsConsistentForInspectionAndLock() public {
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.lockCommitment(address(org), 0, 0);
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.lock(address(org), 0, 0, bytes32(0));
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.lockCommitment(address(org), 0, 8);
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.lock(address(org), 0, 8, bytes32(0));
    }

    function test_exactMixedPathEncodingInBothGatewayMethods() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", unicode"AZaz09-._~/café 100%.html");
        (, bytes memory data) = _render();
        assertEq(
            string(data),
            string.concat(
                "https://fs.abx.io/g/cid/",
                vm.toString(block.chainid),
                "/0x0000000000000000000000000000000000000000000000000000000000000001/AZaz09-._~/caf%C3%A9%20100%25.html"
            )
        );
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (, data) = _render();
        assertEq(string(data), string.concat("ipfs://", CID, "/AZaz09-._~/caf%C3%A9%20100%25.html"));
    }

    function test_movedTagCannotRaceContentLock() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Tag, 0, "stable", "");
        bytes32 reviewed = p.lockCommitment(address(org), 0, 1);
        hook.moveTag(bytes32(uint256(3)));
        bytes32 actual = p.lockCommitment(address(org), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.StaleCommitment.selector, reviewed, actual));
        p.lock(address(org), 0, 1, reviewed);
        assertEq(p.config(address(org), 0).locks, 0);
    }

    function test_sameRootPathChangeCannotRaceReviewedLockAcrossTransfer() public {
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "index.html");
        bytes32 reviewed = p.lockCommitment(address(org), 0, 1);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "other.html");
        org.transfer(OTHER);
        bytes32 actual = p.lockCommitment(address(org), 0, 1);
        assertNotEq(reviewed, actual);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.StaleCommitment.selector, reviewed, actual));
        p.lock(address(org), 0, 1, reviewed);
        assertEq(p.config(address(org), 0).locks, 0);
        vm.prank(OTHER);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "index.html");
        assertEq(p.lockCommitment(address(org), 0, 1), reviewed);
        vm.prank(OTHER);
        p.lock(address(org), 0, 1, reviewed);
        (, string memory path) = p.target(address(org), 0);
        assertEq(path, "index.html");
    }

    function test_methodAndEndpointChangesInvalidateOnlyTheirReviewedLocks() public {
        bytes32 content = p.lockCommitment(address(org), 0, 1);
        bytes32 method = p.lockCommitment(address(org), 0, 2);
        bytes32 endpoints = p.lockCommitment(address(org), 0, 4);
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        assertEq(p.lockCommitment(address(org), 0, 1), content);
        assertEq(p.lockCommitment(address(org), 0, 4), endpoints);
        bytes32 actual = p.lockCommitment(address(org), 0, 2);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.StaleCommitment.selector, method, actual));
        p.lock(address(org), 0, 2, method);
        p.setEndpoints(address(org), 0, "https://other.example", "https://gateway.example");
        actual = p.lockCommitment(address(org), 0, 4);
        vm.expectRevert(abi.encodeWithSelector(IProjectPresentation.StaleCommitment.selector, endpoints, actual));
        p.lock(address(org), 0, 4, endpoints);
        assertEq(p.config(address(org), 0).locks, 0);
    }

    function test_unrelatedPublicationAndTransferDoNotInvalidateMethodEndpointLocks() public {
        bytes32 reviewed = p.lockCommitment(address(org), 0, 6);
        hook.publish(bytes32(uint256(7)));
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "other.html");
        org.transfer(OTHER);
        assertEq(p.lockCommitment(address(org), 0, 6), reviewed);
        vm.prank(OTHER);
        p.lock(address(org), 0, 6, reviewed);
        assertEq(p.config(address(org), 0).locks, 6);
    }

    function test_repeatedContentLockRetainsItsOriginalCommitmentAfterOtherChanges() public {
        bytes32 reviewed = p.lockCommitment(address(org), 0, 1);
        p.lock(address(org), 0, 1, reviewed);
        hook.publish(bytes32(uint256(7)));
        p.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
        p.setEndpoints(address(org), 0, "https://other.example", "");
        assertEq(p.lockCommitment(address(org), 0, 1), reviewed);
        p.lock(address(org), 0, 1, reviewed);
    }

    function test_commitmentSeparatesDomainChainOrgTokenAndMask() public {
        bytes32 reviewed = p.lockCommitment(address(org), 0, 2);
        assertNotEq(reviewed, p.lockCommitment(address(org), 1, 2));
        assertNotEq(reviewed, p.lockCommitment(address(org), 0, 4));
        assertNotEq(reviewed, p.lockCommitment(address(0x1234), 0, 2));
        vm.chainId(block.chainid + 1);
        assertNotEq(reviewed, p.lockCommitment(address(org), 0, 2));
    }

    function test_versionAndRemovedLimitGettersDescribeUncappedSemantics() public view {
        assertEq(p.presentationVersion(), 2);
        string[5] memory removed = ["MAX_EMBED_BYTES()", "MAX_EMBED_CHUNKS()", "RENDER_GAS()", "SERIALIZE_BASE_GAS()", "SERIALIZE_GAS_PER_BYTE()"];
        for (uint256 i; i < removed.length; ++i) {
            (bool ok,) = address(p).staticcall(abi.encodeWithSignature(removed[i]));
            assertFalse(ok, "no legacy resource policy getter");
        }
    }

    function test_embeddedReturnsPayloadsBeyondFormerByteAndReturnBufferLimits() public {
        _embedded();
        reader.setMode(7);
        (IProjectPresentation.Status status, string memory mime, bytes memory data) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertEq(mime, "text/html");
        assertEq(data.length, 16_385);
        reader.setMode(8);
        (status, mime, data) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertEq(mime, "text/html");
        assertEq(data.length, 102_400);
    }

    function test_successfulSourceMayUseMoreThanFormerFixedGasAllowance() public {
        _embedded();
        reader.setMode(9);
        (IProjectPresentation.Status status,, bytes memory data) = p.preview{gas: 8_000_000}(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertEq(string(data), "expensive but successful");
    }

    function test_smallPresentationHasNoFormerMinimumGasReserve() public {
        _embedded();
        (IProjectPresentation.Status status,, bytes memory data) = p.preview{gas: 900_000}(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertGt(data.length, 0);
    }

    function test_uriListSentinelCannotBecomeEmbeddedLocator() public {
        _embedded();
        reader.setMime("text/uri-list");
        (IProjectPresentation.Status status,, bytes memory data) = p.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.UnsupportedMime));
        assertEq(data.length, 0);
    }

    function test_changedValueEventsReconstructConfigurationAndLocks() public {
        vm.recordLogs();
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Tag, 0, "release", "nested/index.html");
        p.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
        p.setEndpoints(address(org), 0, "https://chain.example", "https://ipfs.example");
        p.lock(address(org), 0, 1, p.lockCommitment(address(org), 0, 1));
        p.lock(address(org), 0, 6, p.lockCommitment(address(org), 0, 6));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 5);
        IProjectPresentation.Config memory replayed;
        for (uint256 i; i < logs.length; ++i) {
            assertEq(logs[i].emitter, address(p));
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(org)))));
            assertEq(logs[i].topics[2], bytes32(0));
            bytes32 kind = logs[i].topics[0];
            if (kind == keccak256("TargetChanged(address,uint256,uint8,uint32,string,string)")) {
                (replayed.selection, replayed.version, replayed.tag, replayed.path) =
                    abi.decode(logs[i].data, (IProjectPresentation.Selection, uint32, string, string));
                replayed.configuredFlags |= 1;
            } else if (kind == keccak256("MethodChanged(address,uint256,uint8)")) {
                replayed.method = abi.decode(logs[i].data, (IProjectPresentation.Method));
                replayed.configuredFlags |= 2;
            } else if (kind == keccak256("EndpointsChanged(address,uint256,string,string)")) {
                (replayed.chainBase, replayed.ipfsBase) = abi.decode(logs[i].data, (string, string));
                replayed.configuredFlags |= 4;
            } else if (kind == keccak256("PresentationLocked(address,uint256,uint8,bytes32)")) {
                (replayed.locks, replayed.frozenRoot) = abi.decode(logs[i].data, (uint8, bytes32));
                replayed.configuredFlags |= replayed.locks;
            } else fail("unexpected event");
        }
        assertEq(abi.encode(replayed), abi.encode(p.config(address(org), 0)));
    }

    function test_configurationFlagsDistinguishExplicitDefaultsAndIndependentDimensions() public {
        assertEq(p.config(address(org), 0).configuredFlags, 0);
        p.setEndpoints(address(org), 0, "", "");
        assertEq(p.config(address(org), 0).configuredFlags, 4);
        p.setMethod(address(org), 0, IProjectPresentation.Method.ChainGateway);
        assertEq(p.config(address(org), 0).configuredFlags, 6);
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "");
        assertEq(p.config(address(org), 0).configuredFlags, 7);
        p.setMethod(address(org), 0, IProjectPresentation.Method.ChainGateway);
        assertEq(p.config(address(org), 0).configuredFlags, 7);
        assertEq(p.config(address(org), 1).configuredFlags, 0);
        p.lock(address(org), 1, 2, p.lockCommitment(address(org), 1, 2));
        assertEq(p.config(address(org), 1).configuredFlags, 2);
        assertEq(p.config(address(org), 1).locks, 2);
    }

    function testFuzz_arbitraryEndpointCannotInjectScheme(string calldata endpoint) public {
        bytes memory b = bytes(endpoint);
        vm.assume(b.length > 0 && (b.length < 8 || bytes8(b) != "https://"));
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.setEndpoints(address(org), 0, endpoint, "");
    }
}
