// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {ProjectPresentation} from "../../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../../src/interfaces/IProjectPresentation.sol";
import {IAbxSeriesCodeFactory, AbxInitParams, AbxContractField} from "../../src/interfaces/IAbxOrgDeploy.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IPresentationForkToken {
    function tokenURI(uint256 id) external view returns (string memory);
    function configureTokenParam(uint256 id, bytes32 key, bytes32 value) external;
    function configureTokenParamData(uint256 id, bytes32 key, bytes calldata value) external;
    function transferFrom(address from, address to, uint256 id) external;
}

/// @dev Arbitrary backends may lose availability; ChunkStore must still prevent changed bytes from escaping.
contract PresentationAvailabilityBackend {
    bytes internal _data;
    bool public burn;

    function setData(bytes calldata data) external {
        _data = data;
    }

    function setBurn(bool value) external {
        burn = value;
    }

    function store(bytes calldata data, address) external returns (bytes32) {
        _data = data;
        return bytes32(uint256(1));
    }

    function readable() external pure returns (bool) {
        return true;
    }

    function retrieve(bytes32) external view returns (bytes memory) {
        if (burn) assembly { for {} 1 {} {} }
        return _data;
    }
}

/// @dev Canonical new-factory integration against real ABX, including full metadata serialization.
///      Companion artifacts are built in their own package so their metadata paths stay canonical.
contract PresentationForkTest is Test {
    using LibString for string;
    address constant ABX = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant METADATA = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant IPFS = 0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d;
    address constant CHUNKS = 0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc;
    address constant FASTLZ = 0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1;
    address constant RAW = 0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844;
    address reader;
    ProjectPresentation presentation;
    OrgFactory factory;
    address org;
    address owner = makeAddr("presentation-owner");
    string constant JSON_PREFIX = "data:application/json;base64,";

    function setUp() public {
        string memory rpc = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        ContentLayer.deploy();
        reader = deployCode(
            "../contracts-companion/out/ContentReader.sol/ContentReader.json",
            abi.encode(CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE)
        );
        presentation = new ProjectPresentation(reader, IPFS, "https://fs.abx.io");
        factory = OrgComponents.create(
            ABX,
            METADATA,
            SEED,
            CONTENT_DIRECTORY_STORE,
            CONTENT_FILE_STORE,
            address(new OrgMeta("https://fs.abx.io")),
            address(presentation)
        );
        vm.prank(owner);
        org = factory.createOrg("Native presentation", "", bytes32(0));
    }

    function _file(bytes memory body, bool compressed) internal returns (bytes32) {
        return _fileChunks(body, compressed, 24_000, "text/html");
    }

    function _fileChunks(bytes memory body, bool compressed, uint256 chunkBytes, string memory mime)
        internal returns (bytes32)
    {
        bytes memory records = hex"00";
        for (uint256 offset; offset < body.length; offset += chunkBytes) {
            uint256 n = body.length - offset;
            if (n > chunkBytes) n = chunkBytes;
            bytes memory data = new bytes(n);
            assembly ("memory-safe") { mcopy(add(data, 32), add(add(body, 32), offset), n) }
            bytes32 chunk = IChunkStore(CHUNKS).write(
                compressed ? FASTLZ : RAW, compressed ? LibZip.flzCompress(data) : data, keccak256(data), uint48(n)
            );
            records = bytes.concat(records, abi.encodePacked(chunk, uint48(n)));
        }
        bytes32 node = IFileStore(CONTENT_FILE_STORE).putChunkNode(records);
        return IFileStore(CONTENT_FILE_STORE).createFile(node, mime, bytes32(0), bytes32(0));
    }

    function _html(uint256 size) internal pure returns (bytes memory body) {
        body = new bytes(size);
        for (uint256 i; i < size; i += 32) {
            assembly ("memory-safe") { mstore(add(add(body, 32), i), 0x2020202020202020202020202020202020202020202020202020202020202020) }
        }
        bytes memory prefix = "<!doctype html><title>large on-chain fixture</title><p>100 KiB</p>";
        assembly ("memory-safe") { mcopy(add(body, 32), add(prefix, 32), mload(prefix)) }
    }

    function _publish(bytes32 root) internal {
        vm.prank(owner);
        IPresentationForkToken(org).configureTokenParam(0, "abxfs.cid", root);
    }

    function _animation(address token) internal view returns (string memory) {
        string memory uri = IPresentationForkToken(token).tokenURI(0);
        assertTrue(uri.startsWith(JSON_PREFIX));
        string memory json = string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
        return vm.parseJsonString(json, ".animation_url");
    }

    function test_realMetadataEmbedsExactFastLzContentAndIgnoresLegacyView() public {
        bytes memory body = "<!doctype html><html><title>Preserved</title><p>On chain</p></html>";
        _publish(_file(body, true));
        vm.startPrank(owner);
        presentation.setMethod(org, 0, IProjectPresentation.Method.Embedded);
        IPresentationForkToken(org).configureTokenParamData(0, "abxfs.view", "https://unrelated.example");
        vm.stopPrank();
        assertEq(_animation(org), string.concat("data:text/html;base64,", Base64.encode(body)));
    }

    function test_realLockedContentSurvivesPublicationTagMovementTransferAndMethodSwitch() public {
        bytes32 first = _file("<p>First</p>", false);
        bytes32 second = _file("<p>Second</p>", true);
        _publish(first);
        vm.startPrank(owner);
        factory.hook().setTag(org, 0, "release", 1);
        presentation.setTarget(org, 0, IProjectPresentation.Selection.Tag, 0, "release", "");
        presentation.lock(org, 0, 1, presentation.lockCommitment(org, 0, 1));
        vm.stopPrank();
        _publish(second);
        address successor = makeAddr("successor");
        vm.startPrank(owner);
        factory.hook().setTag(org, 0, "release", 2);
        IPresentationForkToken(org).transferFrom(owner, successor, 0);
        vm.stopPrank();
        (bytes32 fixedRoot,) = presentation.target(org, 0);
        assertEq(fixedRoot, first);
        vm.startPrank(successor);
        presentation.setMethod(org, 0, IProjectPresentation.Method.Embedded);
        vm.stopPrank();
        assertEq(_animation(org), string.concat("data:text/html;base64,", Base64.encode("<p>First</p>")));
        vm.prank(owner);
        vm.expectRevert(IProjectPresentation.NotProjectOwner.selector);
        presentation.setMethod(org, 0, IProjectPresentation.Method.ChainGateway);
    }

    function _largeMetadata(bool compressed, string memory mime, bytes memory body, uint256 chunkBytes) internal {
        _publish(_fileChunks(body, compressed, chunkBytes, mime));
        vm.prank(owner);
        presentation.setMethod(org, 0, IProjectPresentation.Method.Embedded);
        uint256 beforeGas = gasleft();
        string memory uri = IPresentationForkToken(org).tokenURI(0);
        emit log_named_string("100 KiB metadata MIME", mime);
        emit log_named_uint("storage FastLZ", compressed ? 1 : 0);
        emit log_named_uint("complete tokenURI gas, 100 KiB embedding", beforeGas - gasleft());
        emit log_named_uint("complete tokenURI output bytes", bytes(uri).length);
        string memory json = string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
        assertEq(vm.parseJsonString(json, ".animation_url"), string.concat("data:", mime, ";base64,", Base64.encode(body)));
        // This is a measured caller profile, not a protocol cap. Larger callers remain free to supply more gas.
        (bool ok, bytes memory ret) = org.staticcall{gas: 50_000_000}(abi.encodeCall(IPresentationForkToken.tokenURI, (0)));
        assertTrue(ok, "100 KiB fixture completes with this caller's 50M gas");
        assertEq(abi.decode(ret, (string)), uri);
        // A much smaller caller can naturally fail. A returned document must never pretend to contain partial bytes.
        (ok, ret) = org.staticcall{gas: 2_000_000}(abi.encodeCall(IPresentationForkToken.tokenURI, (0)));
        if (ok) {
            json = string(Base64.decode(abi.decode(ret, (string)).slice(bytes(JSON_PREFIX).length)));
            string memory value = vm.parseJsonString(json, ".animation_url");
            assertTrue(value.eq("data:text/plain;base64,") || value.eq(string.concat("data:", mime, ";base64,", Base64.encode(body))));
        }
    }

    function test_realCompleteTokenURIRaw100KiBHtml() public {
        _largeMetadata(false, "text/html", _html(102_400), 24_000);
    }

    function test_realCompleteTokenURIFastLz100KiBHtmlWith50Chunks() public {
        _largeMetadata(true, "text/html", _html(102_400), 2048);
    }

    function test_realCompleteTokenURI100KiBRaster() public {
        // A 1x1 GIF with a legal comment extension carrying the remaining bytes. The media itself is self-contained.
        bytes memory pixel = Base64.decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
        bytes memory body = new bytes(102_400);
        uint256 prefix = pixel.length - 1; // Insert the comment before the GIF trailer.
        assembly ("memory-safe") { mcopy(add(body, 32), add(pixel, 32), prefix) }
        uint256 i = prefix;
        body[i++] = 0x21; body[i++] = 0xfe;
        while (body.length - i > 2) {
            uint256 n = body.length - i - 3;
            if (n > 255) n = 255;
            if (body.length - i - n - 1 == 3) --n;
            body[i++] = bytes1(uint8(n));
            i += n;
        }
        body[i++] = 0x00; body[i] = 0x3b;
        _largeMetadata(false, "image/gif", body, 24_000);
    }

    function _animationAtBudget(uint256 budget) internal view returns (string memory animation) {
        (bool ok, bytes memory ret) = org.staticcall{gas: budget}(abi.encodeCall(IPresentationForkToken.tokenURI, (0)));
        assertTrue(ok, "this measured caller budget completes metadata");
        string memory uri = abi.decode(ret, (string));
        assertTrue(uri.startsWith(JSON_PREFIX));
        string memory json = string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
        return vm.parseJsonString(json, ".animation_url");
    }

    function _sweepMetadataBudget(string memory expected) internal view {
        for (uint256 budget = 2_000_000; budget <= 8_000_000; budget += 500_000) {
            (bool ok, bytes memory ret) = org.staticcall{gas: budget}(abi.encodeCall(IPresentationForkToken.tokenURI, (0)));
            if (!ok) continue; // Natural caller exhaustion is allowed; there is no on-chain minimum-gas policy.
            string memory uri = abi.decode(ret, (string));
            string memory json = string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
            string memory animation = vm.parseJsonString(json, ".animation_url");
            assertTrue(animation.eq(expected) || animation.eq("data:text/plain;base64,"), "only exact output or neutral catchable failure");
        }
        assertEq(_animationAtBudget(8_000_000), expected);
    }

    function test_realShortGatewayUriCompletesAcrossQualifiedGasBoundary() public {
        _publish(_file("<p>short locator</p>", true));
        (, string memory mime, bytes memory data) = presentation.preview(org, 0);
        assertEq(mime, "text/uri-list");
        assertGt(data.length, 50);
        assertLt(data.length, 400);
        _sweepMetadataBudget(string(data));
    }

    function test_realMaximumEncodedGatewayPathCompletesAcrossGasBoundary() public {
        bytes32 child = _file("<p>nested locator</p>", false);
        bytes memory name = new bytes(255);
        for (uint256 i; i < name.length; ++i) {
            name[i] = "%";
        }
        string memory path;
        for (uint256 i; i < 8; ++i) {
            bytes32 node = IDirectoryStore(CONTENT_DIRECTORY_STORE)
                .putEntryNode(abi.encodePacked(hex"0000010000", uint8(255), name, uint8(i == 0 ? 0 : 1), child));
            child = IDirectoryStore(CONTENT_DIRECTORY_STORE).createDirectory(node);
            path = i == 0 ? string(name) : string.concat(string(name), "/", path);
        }
        _publish(child);
        vm.prank(owner);
        presentation.setTarget(org, 0, IProjectPresentation.Selection.Latest, 0, "", path);
        (IProjectPresentation.Status status,, bytes memory data) = presentation.preview(org, 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertGt(data.length, 6000);
        _sweepMetadataBudget(string(data));
    }

    function test_realEscapeHeavy100KiBEmbeddingWithCappedMetadataCompletes() public {
        bytes memory name = new bytes(64);
        bytes memory description = new bytes(1000);
        bytes memory projectName = new bytes(128);
        for (uint256 i; i < name.length; ++i) {
            name[i] = "&";
        }
        for (uint256 i; i < description.length; ++i) {
            description[i] = i % 2 == 0 ? bytes1('"') : bytes1("\\");
        }
        for (uint256 i; i < projectName.length; ++i) {
            projectName[i] = '"';
        }
        vm.prank(owner);
        org = factory.createOrg(string(name), string(description), bytes32(0));
        bytes memory body = new bytes(102_400);
        for (uint256 i; i < body.length; ++i) {
            body[i] = i % 3 == 0 ? bytes1('"') : (i % 3 == 1 ? bytes1("\\") : bytes1(uint8(1)));
        }
        _publish(_file(body, true));
        vm.startPrank(owner);
        IPresentationForkToken(org).configureTokenParamData(0, "abxfs.name", projectName);
        bytes memory externalLink = new bytes(512);
        bytes memory linkPrefix = "https://example.invalid/";
        for (uint256 i; i < externalLink.length; ++i) externalLink[i] = i < linkPrefix.length ? linkPrefix[i] : bytes1("a");
        IPresentationForkToken(org).configureTokenParamData(0, "abxfs.view", externalLink);
        IPresentationForkToken(org).configureTokenParamData(0, "abxfs.gateway", externalLink);
        presentation.setMethod(org, 0, IProjectPresentation.Method.Embedded);
        vm.stopPrank();
        _largeMetadata(true, "text/html", body, 2048);
    }

    function test_realMutableBackendCannotSubstituteBytesAndGasFailureIsNeutral() public {
        PresentationAvailabilityBackend backend = new PresentationAvailabilityBackend();
        bytes memory original = "original";
        bytes32 chunk =
            IChunkStore(CHUNKS).write(address(backend), original, keccak256(original), uint48(original.length));
        bytes32 node =
            IFileStore(CONTENT_FILE_STORE).putChunkNode(abi.encodePacked(hex"00", chunk, uint48(original.length)));
        bytes32 root = IFileStore(CONTENT_FILE_STORE).createFile(node, "text/html", bytes32(0), bytes32(0));
        _publish(root);
        vm.startPrank(owner);
        presentation.setMethod(org, 0, IProjectPresentation.Method.Embedded);
        presentation.lock(org, 0, 3, presentation.lockCommitment(org, 0, 3));
        vm.stopPrank();
        assertEq(_animationAtBudget(8_000_000), string.concat("data:text/html;base64,", Base64.encode(original)));
        backend.setData("changed!"); // Same length; only the committed hash detects this mutation.
        assertEq(_animationAtBudget(8_000_000), "data:text/plain;base64,");
        backend.setData(original);
        backend.setBurn(true);
        for (uint256 budget = 2_000_000; budget <= 8_000_000; budget += 500_000) {
            (bool ok, bytes memory ret) = org.staticcall{gas: budget}(abi.encodeCall(IPresentationForkToken.tokenURI, (0)));
            if (ok) {
                string memory uri = abi.decode(ret, (string));
                string memory json = string(Base64.decode(uri.slice(bytes(JSON_PREFIX).length)));
                assertEq(vm.parseJsonString(json, ".animation_url"), "data:text/plain;base64,");
            }
        }
        assertEq(uint256(presentation.config(org, 0).method), uint256(IProjectPresentation.Method.Embedded));
    }

    function test_realAbxReaderRepresentationUsesFixedAdapter() public {
        bytes memory body = "<!doctype html><p>Reader adapter</p>";
        bytes32 root = _file(body, true);
        address adapter = deployCode(
            "../contracts-companion/out/AbxContentReader.sol/AbxContentReader.json",
            abi.encode(reader, root, "", uint256(32_768), uint256(32))
        );
        AbxInitParams memory p;
        p.owner = owner;
        p.name = "Reader integration";
        p.symbol = "READ";
        p.tokenURIRenderer = METADATA;
        p.seedSource = SEED;
        p.maxInvocations = 1;
        p.mintTo = owner;
        p.mintCount = 1;
        p.contractFields = new AbxContractField[](1);
        p.contractFields[0] = AbxContractField("animation_url", "reader", abi.encode(adapter, adapter));
        address token = IAbxSeriesCodeFactory(ABX).deploy(p);
        assertEq(_animation(token), string.concat("data:text/html;base64,", Base64.encode(body)));
    }
}
