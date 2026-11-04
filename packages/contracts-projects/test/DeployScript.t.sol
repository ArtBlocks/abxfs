// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Deploy as DeployContent} from "@abxfs/core-script/Deploy.s.sol";
import {DeployFromArtifacts} from "@abxfs/core-script/DeployFromArtifacts.s.sol";

/// @dev The deploy script's gateway-base validation, which guards a value frozen into every org.
contract DeployScriptTest is Test {
    DeployProjects d;

    function setUp() public {
        d = new DeployProjects();
    }

    function _bad(string memory base) internal {
        vm.expectPartialRevert(DeployProjects.BadGatewayBase.selector);
        d.validateGatewayBase(base);
    }

    function test_acceptsOrdinaryHttpsBases() public view {
        d.validateGatewayBase("https://fs.abx.io");
        d.validateGatewayBase("https://abx.io");
        d.validateGatewayBase("https://gw.example.com:8443");
        d.validateGatewayBase("https://x.example/base/path");
    }

    function test_refusesWhatCannotBeFrozen() public {
        _bad("");
        _bad("https://");
        _bad("http://fs.abx.io");
        _bad("HTTPS://fs.abx.io");
        _bad("fs.abx.io");
        _bad("https:///path"); // empty host
        _bad("https://fs.abx.io/"); // trailing slash
        _bad("https://fs.abx.io "); // whitespace
        _bad("https://www.ab x.example");
        _bad("https://fs.abx.io\n");
        _bad(unicode"https://exämple.test");
        _bad('https://a.example/"x');
        _bad("https://a.example/'x");
        _bad("https://a.example/?a&b");
        _bad("https://a.example/<x>");
        _bad("https://a.example/\\x");
    }

    function test_lengthCapIs128Bytes() public {
        bytes memory b = new bytes(128);
        bytes memory p = "https://";
        for (uint256 i; i < 128; ++i) b[i] = i < 8 ? p[i] : bytes1("a");
        d.validateGatewayBase(string(b));
        bytes memory c = bytes.concat(b, "a");
        _bad(string(c));
    }

    /// @dev The probe the script runs on OrgMeta before the factory freezes it into every org.
    function test_probeOrgMeta() public {
        OrgMeta m = new OrgMeta("https://fs.abx.io");
        d.probeOrgMeta(address(m), "https://fs.abx.io");

        vm.expectPartialRevert(DeployProjects.WiringMismatch.selector);
        d.probeOrgMeta(address(m), "https://abx.io"); // a different base than it was built with
        vm.expectPartialRevert(DeployProjects.NoCode.selector);
        d.probeOrgMeta(address(0xdead), "https://fs.abx.io");
        vm.expectRevert(); // something else entirely: it does not answer `gatewayBase()`
        d.probeOrgMeta(address(d), "https://fs.abx.io");
    }

    /// @dev The allow-table's store pair is the content layer's CREATE2 prediction from contracts-core's own build
    ///      (`DeployFromArtifacts`; this project's compile of the core sources has different metadata). If this fails,
    ///      the content layer's code moved: update `expected()`.
    function test_storeAllowTableIsTheContentLayersPrediction() public {
        DeployContent.Addresses memory core = new DeployFromArtifacts().predict();
        DeployProjects.Inputs memory e = d.expected();
        assertEq(e.directoryStore, core.directoryStore, "DirectoryStore");
        assertEq(e.fileStore, core.fileStore, "FileStore");
        assertEq(e.gatewayBase, "https://fs.abx.io");
    }
}
