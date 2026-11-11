// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {IChunkStore} from "@abxfs/core/interfaces/IChunkStore.sol";
import {IFileStore} from "@abxfs/core/interfaces/IFileStore.sol";
import {IDirectoryStore} from "@abxfs/core/interfaces/IDirectoryStore.sol";
import {ContentLayer} from "./fork/ContentLayer.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../src/interfaces/IProjectPresentation.sol";
import {PresentationFactoryMock, PresentationHookMock, PresentationOrgMock, PresentationIpfsMock} from "./ProjectPresentation.t.sol";

/// @dev Real native content reads on the test EVM, independent of fork availability.
contract PresentationContentTest is Test {
    address constant CHUNKS = 0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc;
    address constant RAW = 0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844;
    address constant FASTLZ = 0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1;
    address constant FILES = 0x8b6077a1d6953D96687005B9408D56A655b4d155;
    address constant DIRS = 0x4273E4E078F47303Ca15b11959eeb61F3FC94c11;
    ProjectPresentation presentation;
    PresentationHookMock hook;
    PresentationOrgMock org;

    function setUp() public {
        ContentLayer.deploy();
        address reader = deployCode(
            "../contracts-companion/out/ContentReader.sol/ContentReader.json", abi.encode(DIRS, FILES)
        );
        PresentationFactoryMock factory = new PresentationFactoryMock();
        hook = new PresentationHookMock(address(factory), FILES, DIRS);
        org = new PresentationOrgMock(address(hook), address(this));
        PresentationIpfsMock resolver = new PresentationIpfsMock(FILES, DIRS);
        presentation = new ProjectPresentation(reader, address(resolver), "https://fs.abx.io");
        presentation.setMethod(address(org), 0, IProjectPresentation.Method.Embedded);
    }

    function _file(bytes memory body, bool compressed, uint256 chunkBytes, bytes32 codec) internal returns (bytes32) {
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
        bytes32 node = IFileStore(FILES).putChunkNode(records);
        return IFileStore(FILES).createFile(node, "text/html", codec, codec == 0 ? bytes32(0) : keccak256(body));
    }

    function _assertOutput(bytes memory expected) internal view {
        (IProjectPresentation.Status status, string memory mime, bytes memory data) =
            presentation.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertEq(mime, "text/html");
        assertEq(data, expected);
    }

    function test_rawAndFastLz100KiBWithMoreThan32ChunksReturnEveryByte() public {
        bytes memory body = new bytes(102_400);
        for (uint256 i; i < body.length; ++i) body[i] = bytes1(uint8(i));
        for (uint256 compressed; compressed <= 1; ++compressed) {
            bytes32 root = _file(body, compressed == 1, 2048, bytes32(0));
            assertEq(IFileStore(FILES).getFileInfo(root).chunkCount, 50);
            hook.publish(root);
            _assertOutput(body);
        }
    }

    function test_selectedFileAndDirectoryIndexAreExactAndNeverAListing() public {
        bytes memory index = "<!doctype html><p>index</p>";
        bytes memory other = "<!doctype html><p>selected file</p>";
        bytes32 indexFile = _file(index, true, 2048, bytes32(0));
        bytes32 otherFile = _file(other, false, 2048, bytes32(0));
        bytes memory node = abi.encodePacked(
            hex"00", uint16(2), uint16(0), uint16(40), uint8(6), "a.html", uint8(0), otherFile,
            uint8(10), "index.html", uint8(0), indexFile
        );
        bytes32 directory = IDirectoryStore(DIRS).createDirectory(IDirectoryStore(DIRS).putEntryNode(node));
        hook.publish(directory);
        _assertOutput(index);
        presentation.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "a.html");
        _assertOutput(other);
        presentation.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "");
        hook.publish(otherFile);
        _assertOutput(other);
    }

    function test_emptyDirectoryAndOffchainCodecHaveNoHttpOrListingFallback() public {
        bytes32 empty = IDirectoryStore(DIRS).createDirectory(bytes32(0));
        hook.publish(empty);
        (IProjectPresentation.Status status,, bytes memory data) = presentation.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.ReadFailed));
        assertEq(data.length, 0);
        hook.publish(_file("gzip bytes", false, 2048, bytes32("gzip")));
        (status,, data) = presentation.preview(address(org), 0);
        assertEq(uint256(status), uint256(IProjectPresentation.Status.UnsupportedCodec));
        assertEq(data.length, 0);
        assertEq(uint256(presentation.config(address(org), 0).method), uint256(IProjectPresentation.Method.Embedded));
    }
}
