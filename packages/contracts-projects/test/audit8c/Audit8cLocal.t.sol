// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {MockStore} from "../mocks/Mocks.sol";
import {MockAbxFactory, MockOrgCollection} from "../mocks/AbxMocks.sol";

/// @dev Audit 8c, local (mock ABX). Properties of OrgMeta not pinned by its own suite.
contract Audit8cLocalTest is Test {
    using LibString for string;

    string constant PREFIX = "data:application/json;base64,";
    MockAbxFactory abxFactory;
    OrgFactory factory;
    OrgMeta meta;
    address alice = makeAddr("alice");

    function setUp() public {
        abxFactory = new MockAbxFactory();
        meta = new OrgMeta("https://fs.abx.io");
        factory = OrgComponents.create(
            address(abxFactory), address(0xBEEF01), address(0xBEEF02), address(new MockStore()), address(new MockStore()), address(meta)
        );
    }

    function _json(string memory uri) internal pure returns (string memory) {
        assertTrue(uri.startsWith(PREFIX));
        return string(Base64.decode(uri.slice(bytes(PREFIX).length)));
    }

    function _printableOnly(bytes memory b) internal pure {
        for (uint256 i; i < b.length; ++i) assertTrue(uint8(b[i]) >= 0x20 && uint8(b[i]) <= 0x7e, "printable");
    }

    /// @dev Any description the factory accepts (printable + `\n`, up to 1000 bytes) and any name it accepts:
    ///      the collection document is printable ASCII end to end (no raw control byte reaches a consumer),
    ///      parses, has exactly five keys, and round-trips both strings.
    function testFuzz_anyAcceptedInputGivesAValidDocument(bytes calldata rawName, bytes calldata rawDesc) public {
        bytes memory n = new bytes(1 + rawName.length % 64);
        for (uint256 i; i < n.length; ++i) n[i] = bytes1(uint8(0x20 + uint8(i < rawName.length ? rawName[i] : bytes1(0)) % 95));
        n[0] = n[0] == " " ? bytes1("x") : n[0];
        bytes memory d = new bytes(rawDesc.length % 1001);
        for (uint256 i; i < d.length; ++i) {
            uint8 r = uint8(rawDesc[i]) % 96;
            d[i] = r == 95 ? bytes1(0x0a) : bytes1(0x20 + r);
        }
        if (d.length != 0) d[0] = "y";

        vm.prank(alice);
        MockOrgCollection org = MockOrgCollection(factory.createOrg(string(n), string(d), bytes32(0)));
        string memory j = _json(org.contractURI());
        _printableOnly(bytes(j));
        assertEq(vm.parseJsonKeys(j, "$").length, 5);
        assertEq(vm.parseJsonString(j, ".name"), string(n));
        if (d.length != 0) assertEq(vm.parseJsonString(j, ".description"), string(d));
    }

    /// @dev For every gas budget, `render(name)` either reverts or returns the project's REAL name: a capped
    ///      read that fails under pressure never yields a confident wrong answer the caller would cache.
    function test_renderGasSweep_neverSilentlyWrong() public {
        vm.prank(alice);
        MockOrgCollection org = MockOrgCollection(factory.createOrg("Acme", "", bytes32(0)));
        vm.prank(alice);
        org.configureTokenParamData(0, "abxfs.name", "My Project");
        uint256 okCount;
        for (uint256 gas = 1_000; gas < 120_000; gas += 250) {
            vm.cool(address(org));
            vm.cool(address(meta));
            (bool ok, bytes memory ret) =
                address(meta).staticcall{gas: gas}(abi.encodeCall(OrgMeta.render, (address(org), 0, "name")));
            if (!ok) continue;
            (, bytes memory data) = abi.decode(ret, (string, bytes));
            assertEq(string(data), "My Project", "never the fallback because of gas");
            ++okCount;
        }
        assertGt(okCount, 0);
    }

    /// @dev The SDK's `projectNameShowsOnMarketplaces("-")` returns TRUE, but the chain treats `-` as the
    ///      cleared marker and names the token "<org> #<id>". This pins the on-chain side of that mismatch.
    function test_dashIsFallbackOnChain() public {
        vm.prank(alice);
        MockOrgCollection org = MockOrgCollection(factory.createOrg("Acme", "", bytes32(0)));
        vm.prank(alice);
        org.configureTokenParamData(0, "abxfs.name", "-");
        (, bytes memory data) = meta.render(address(org), 0, "name");
        assertEq(string(data), "Acme #0");
    }
}
