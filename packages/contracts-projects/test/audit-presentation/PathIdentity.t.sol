// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    PresentationFactoryMock,
    PresentationHookMock,
    PresentationOrgMock,
    PresentationReaderMock,
    PresentationIpfsMock
} from "../ProjectPresentation.t.sol";
import {ProjectPresentation} from "../../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../../src/interfaces/IProjectPresentation.sol";

/// @dev Independent identity regression: a selected path must survive URL construction byte-for-byte.
contract AuditPresentationPathIdentityTest is Test {
    function test_auditNestedAsciiPathPreservesIdentity() public {
        address files = address(0x100);
        address dirs = address(0x200);
        vm.etch(files, hex"00");
        vm.etch(dirs, hex"00");
        PresentationFactoryMock factory = new PresentationFactoryMock();
        PresentationHookMock hook = new PresentationHookMock(address(factory), files, dirs);
        PresentationOrgMock org = new PresentationOrgMock(address(hook), address(this));
        ProjectPresentation p = new ProjectPresentation(
            address(new PresentationReaderMock(files, dirs)),
            address(new PresentationIpfsMock(files, dirs)),
            "https://fs.abx.io"
        );
        p.setTarget(address(org), 0, IProjectPresentation.Selection.Latest, 0, "", "a/b");
        (, bytes memory gateway) = p.render(address(org), 0, "animation_url");
        string memory expectedSuffix = "/0x0000000000000000000000000000000000000000000000000000000000000001/a/b";
        assertEq(
            string(gateway),
            string.concat("https://fs.abx.io/g/cid/", vm.toString(block.chainid), expectedSuffix)
        );
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (, bytes memory ipfsUri) = p.render(address(org), 0, "animation_url");
        assertEq(string(ipfsUri), "ipfs://baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/a/b");
    }
}
