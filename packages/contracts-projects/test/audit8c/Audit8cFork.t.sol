// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "../fork/ContentLayer.sol";

interface IA8 {
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function name() external view returns (string memory);
    function owner() external view returns (address);
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function contractField(bytes32) external view returns (bytes32, bytes memory);
    function contractFieldLocked(bytes32) external view returns (bool);
    function tokenField(uint256, bytes32) external view returns (bytes32, bytes memory);
    function setContractField(bytes32, bytes32, bytes calldata) external;
    function setTokenField(uint256, bytes32, bytes32, bytes calldata) external;
    function lockContractField(bytes32) external;
    function lockTokenField(uint256, bytes32) external;
    function setContractURIRenderer(address) external;
    function setContractURIOverride(string calldata) external;
    function setContractURIBase(string calldata) external;
    function setTokenURIRenderer(address) external;
    function multicall(bytes[] calldata) external returns (bytes[] memory);
}

/// @dev Audit 8c (OrgMeta + description; written for the eighth generation, kept for the ninth) against the REAL ABX on Base Sepolia.
///      Skipped unless `ABXFS_RPC_URL_84532` is set.
contract Audit8cForkTest is Test {
    using LibString for string;

    address constant ABX_SERIES_CODE_FACTORY = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIRECTORY_STORE = CONTENT_DIRECTORY_STORE;
    address constant FILE_STORE = CONTENT_FILE_STORE;
    string constant PREFIX = "data:application/json;base64,";
    bytes4 constant UNAUTHORIZED = 0x82b42900; // solady Ownable.Unauthorized()
    uint256 constant TX_GAS_CAP = 1 << 24;

    OrgFactory factory;
    OrgMeta meta;
    address admin = makeAddr("admin");

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        meta = new OrgMeta("https://fs.abx.io");
        factory = OrgComponents.create(
            ABX_SERIES_CODE_FACTORY, ABX_RENDERER, ABX_SEED, DIRECTORY_STORE, FILE_STORE, address(meta)
        );
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _fill(uint256 n, bytes1 c) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = c;
    }

    /// Every printable byte 0x20..0x7e and a newline, repeated to `n` bytes (starts visible).
    function _allPrintable(uint256 n, bool newline) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            uint256 k = i % (newline ? 96 : 95);
            // 0x21..0x7e, then a space, then (optionally) a newline.
            b[i] = k == 95 ? bytes1(0x0a) : (k == 94 ? bytes1(0x20) : bytes1(uint8(0x21 + k)));
        }
    }

    function _count(string memory s, string memory needle) internal pure returns (uint256 n) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(needle);
        if (b.length == 0 || a.length < b.length) return 0;
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool m = true;
            for (uint256 j; j < b.length; ++j) {
                if (a[i + j] != b[j]) { m = false; break; }
            }
            if (m) ++n;
        }
    }

    function _json(string memory uri) internal pure returns (string memory) {
        assertTrue(uri.startsWith(PREFIX), "on-chain JSON");
        return string(Base64.decode(uri.slice(bytes(PREFIX).length)));
    }

    function _printableOnly(bytes memory b, string memory what) internal pure {
        for (uint256 i; i < b.length; ++i) {
            if (uint8(b[i]) < 0x20 || uint8(b[i]) > 0x7e) {
                revert(string.concat(what, ": non-printable byte at ", LibString.toString(i)));
            }
        }
    }

    // ─── 5. Gas: createOrg at the limits vs the 2^24 per-tx cap ──────────────

    /// @dev Worst case createOrg: 64-byte name, 1000-byte description, prefix-bound salt. Execution gas is
    ///      measured in-frame (cold accounts), plus the intrinsic 21000 and calldata (16/byte nonzero, 4/zero).
    function test_createOrgGas_worstCaseUnderTxCap() public {
        bytes memory name = _fill(64, "W");
        bytes memory desc = _allPrintable(1000, true);
        bytes32 salt = bytes32(abi.encodePacked(admin, uint96(7)));
        bytes memory cd = abi.encodeCall(OrgFactory.createOrg, (string(name), string(desc), salt));
        uint256 calldataGas;
        for (uint256 i; i < cd.length; ++i) calldataGas += cd[i] == 0 ? 4 : 16;

        vm.prank(admin);
        uint256 g = gasleft();
        address org = factory.createOrg(string(name), string(desc), salt);
        uint256 exec = g - gasleft();
        uint256 total = exec + 21_000 + calldataGas;
        console2.log("createOrg exec gas (64B name, 1000B description)", exec);
        console2.log("createOrg est. tx gas", total);
        assertLt(total, TX_GAS_CAP, "fits the per-tx gas cap");

        vm.prank(admin);
        g = gasleft();
        factory.createOrg("x", "", bytes32(0));
        console2.log("createOrg exec gas (1B name, no description)", g - gasleft());

        // and the description was stored intact
        (bytes32 rep, bytes memory v) = IA8(org).contractField("description");
        assertEq(rep, bytes32("inline"));
        assertEq(v, desc);
    }

    // ─── 5. Gas: tokenURI / contractURI eth_call cost, worst inputs ──────────

    /// @dev 1000 `"` in the description (escapeJSON doubles it, and ABX then base64s the doc) and a 128-byte
    ///      project name of `\` (doubled too). Both documents must render well inside a 50M eth_call cap,
    ///      and must render with an explicit gas budget, i.e. without relying on block-gas-limit eth_call.
    function test_uriGas_worstCaseFarUnderPublicRpcCaps() public {
        bytes memory desc = _fill(1000, '"');
        desc[0] = "a";
        vm.prank(admin);
        address org = factory.createOrg(string(_fill(64, "&")), string(desc), bytes32(0));
        vm.prank(admin);
        IA8(org).configureTokenParamData(0, "abxfs.name", _fill(128, "\\"));

        vm.cool(org);
        vm.cool(address(meta));
        vm.cool(ABX_RENDERER);
        uint256 g = gasleft();
        string memory t = IA8(org).tokenURI(0);
        uint256 tg = g - gasleft();
        vm.cool(org);
        vm.cool(address(meta));
        g = gasleft();
        string memory c = IA8(org).contractURI();
        uint256 cg = g - gasleft();
        console2.log("tokenURI gas (cold, 1000x\" description, 128x\\ name)", tg);
        console2.log("contractURI gas (cold, 64x& name, 1000x\" description)", cg);
        assertLt(tg, 10_000_000);
        assertLt(cg, 10_000_000);

        string memory tj = _json(t);
        string memory cj = _json(c);
        assertEq(vm.parseJsonString(tj, ".name"), string(_fill(128, "\\")));
        assertEq(vm.parseJsonString(tj, ".description"), string(desc));
        assertEq(vm.parseJsonString(cj, ".description"), string(desc));
        assertEq(vm.parseJsonString(cj, ".name"), string(_fill(64, "&")));
        _printableOnly(bytes(tj), "tokenURI JSON");
        _printableOnly(bytes(cj), "contractURI JSON");

        // With a hard budget, as a capped RPC would run it.
        (bool ok,) = org.staticcall{gas: 5_000_000}(abi.encodeWithSignature("tokenURI(uint256)", 0));
        assertTrue(ok, "tokenURI in 5M");
        (ok,) = org.staticcall{gas: 5_000_000}(abi.encodeWithSignature("contractURI()"));
        assertTrue(ok, "contractURI in 5M");
    }

    // ─── 1. Never silently wrong under gas pressure ──────────────────────────

    string internal constant SWEEP_DESC = "About Acme.\nSecond line.";

    /// @dev One budget, in its own frame so memory does not accumulate across a long sweep. Returns whether
    ///      the call succeeded; asserts the values are RIGHT whenever it did.
    function probeC(address org, uint256 gas) external returns (bool ok) {
        vm.cool(org);
        vm.cool(address(meta));
        bytes memory ret;
        (ok, ret) = org.staticcall{gas: gas}(abi.encodeWithSignature("contractURI()"));
        if (ok) {
            string memory j = _json(abi.decode(ret, (string)));
            assertEq(vm.parseJsonString(j, ".name"), "Acme Sites", "contractURI name under pressure");
            assertEq(vm.parseJsonString(j, ".description"), SWEEP_DESC, "contractURI description under pressure");
        }
    }

    function probeT(address org, uint256 gas) external returns (bool ok) {
        vm.cool(org);
        vm.cool(address(meta));
        vm.cool(ABX_RENDERER);
        bytes memory ret;
        (ok, ret) = org.staticcall{gas: gas}(abi.encodeWithSignature("tokenURI(uint256)", 0));
        if (ok) {
            assertEq(vm.parseJsonString(_json(abi.decode(ret, (string))), ".name"), "My Project", "tokenURI name under pressure");
        }
    }

    /// @dev The capped reads fall back on failure. Show that a gas budget too small for a read is too small
    ///      for the whole document: for EVERY budget, the call either reverts or returns the RIGHT values.
    ///      Coarse sweep to find each threshold, then a fine sweep below it, where a fallback-after-OOG window
    ///      would have to be.
    function test_gasSweep_neverSilentlyWrong() public {
        vm.prank(admin);
        address org = factory.createOrg("Acme Sites", SWEEP_DESC, bytes32(0));
        vm.prank(admin);
        IA8(org).configureTokenParamData(0, "abxfs.name", "My Project");

        uint256 minC;
        uint256 minT;
        for (uint256 gas = 20_000; gas < 1_500_000 && minC == 0; gas += 2_500) {
            if (this.probeC(org, gas)) minC = gas;
        }
        for (uint256 gas = 100_000; gas < 6_000_000 && minT == 0; gas += 10_000) {
            if (this.probeT(org, gas)) minT = gas;
        }
        assertGt(minC, 0);
        assertGt(minT, 0);
        for (uint256 gas = minC - 3_000; gas <= minC + 1_000; gas += 10) this.probeC(org, gas);
        for (uint256 gas = minT - 10_000; gas <= minT + 1_000; gas += 50) this.probeT(org, gas);
        console2.log("contractURI min gas (cold)", minC);
        console2.log("tokenURI    min gas (cold)", minT);
    }

    // ─── 2. Injection: every printable byte through the real ABX renderer ────

    function test_everyPrintableByte_realDocumentsStayValid() public {
        bytes memory desc = _allPrintable(1000, true);
        // A name using every XML/JSON metacharacter at word starts, so the monogram takes two of them.
        string memory orgName = "<\"&'> \\</text><script>alert(1)</script>";
        vm.prank(admin);
        address org = factory.createOrg(orgName, string(desc), bytes32(0));
        bytes memory pname = _allPrintable(95, false);
        vm.prank(admin);
        IA8(org).configureTokenParamData(0, "abxfs.name", pname);

        string memory tj = _json(IA8(org).tokenURI(0));
        _printableOnly(bytes(tj), "tokenURI JSON");
        assertEq(vm.parseJsonString(tj, ".name"), string(pname));
        assertEq(vm.parseJsonString(tj, ".description"), string(desc));

        string memory cj = _json(IA8(org).contractURI());
        _printableOnly(bytes(cj), "contractURI JSON");
        assertEq(vm.parseJsonString(cj, ".name"), orgName);
        assertEq(vm.parseJsonString(cj, ".description"), string(desc));
        string[] memory keys = vm.parseJsonKeys(cj, "$");
        assertEq(keys.length, 5, "no key injected");

        // Neither SVG carries the raw name: no `<script`, no stray `</text>` beyond the two the template has.
        string[2] memory imgs = [vm.parseJsonString(cj, ".image"), vm.parseJsonString(cj, ".banner_image")];
        for (uint256 i; i < 2; ++i) {
            string memory svg = string(Base64.decode(imgs[i].slice(26)));
            assertFalse(svg.contains("<script"), "no script element");
            assertEq(_count(svg, "</text>"), 2, "exactly the template's two text nodes");
            assertEq(_count(svg, "<"), _count(svg, ">"), "balanced tags");
        }
    }

    // ─── 3. Nothing can change after creation: VALID arguments, every actor ──

    /// @dev The generated battery calls every mutator with zero-valued arguments, which for
    ///      `setContractField` / `setTokenField` is an empty value that ABX would refuse even from the owner
    ///      (`EmptyFieldValue`). Here each metadata/URI mutator gets arguments that WOULD succeed for an owner,
    ///      and the revert must be precisely `Unauthorized`.
    function test_metadataMutatorsClosedWithValidArgs() public {
        vm.prank(admin);
        address org = factory.createOrg("Closed", "Desc", bytes32(0));
        assertEq(IA8(org).owner(), address(0));

        address[7] memory who = [
            admin,
            address(factory),
            address(meta),
            address(factory.minter()),
            address(factory.hook()),
            address(factory.enumeration()),
            makeAddr("stranger")
        ];
        bytes[11] memory calls = [
            abi.encodeCall(IA8.setContractField, ("description", "inline", "pwned")),
            abi.encodeCall(IA8.setContractField, ("name", "inline", "pwned")),
            abi.encodeCall(IA8.setContractField, ("banner_image", "url", "https://evil.example/x.png")),
            abi.encodeCall(IA8.setContractField, ("abx_gateway_ipfs", "inline", "https://evil.example/")),
            abi.encodeCall(IA8.setTokenField, (0, "name", "inline", "pwned")),
            abi.encodeCall(IA8.setTokenField, (0, "description", "inline", "pwned")),
            abi.encodeCall(IA8.lockContractField, ("external_link")),
            abi.encodeCall(IA8.lockTokenField, (0, "name")),
            abi.encodeCall(IA8.setContractURIRenderer, (address(0xBAD))),
            abi.encodeCall(IA8.setContractURIOverride, ("https://evil.example")),
            abi.encodeCall(IA8.setContractURIBase, ("https://evil.example"))
        ];
        for (uint256 a; a < who.length; ++a) {
            for (uint256 c; c < calls.length; ++c) {
                vm.prank(who[a]);
                (bool ok, bytes memory ret) = org.call(calls[c]);
                assertFalse(ok, "closed");
                assertEq(bytes4(ret), UNAUTHORIZED, "closed by authorization, not by argument shape");
                // and through multicall
                bytes[] memory batch = new bytes[](1);
                batch[0] = calls[c];
                vm.prank(who[a]);
                (ok,) = org.call(abi.encodeCall(IA8.multicall, (batch)));
                assertFalse(ok, "closed via multicall");
            }
        }
        // Nothing moved.
        (bytes32 rep, bytes memory v) = IA8(org).contractField("description");
        assertEq(rep, bytes32("inline"));
        assertEq(v, bytes("Desc"));
        (, v) = IA8(org).tokenField(0, "name");
        assertEq(v.length, 0);
    }

    /// @dev ABX's own renderer reading the org's collection document directly (an indexer that ignores
    ///      `contractURIRenderer` and calls the canonical renderer): the `renderer`-represented `name` field
    ///      must fall back to `name()` there, never revert.
    function test_abxCanonicalContractURIStillWorksOnAnOrg() public {
        vm.prank(admin);
        address org = factory.createOrg("Acme", "About.", bytes32(0));
        (bool ok, bytes memory ret) =
            ABX_RENDERER.staticcall(abi.encodeWithSignature("contractURI(address)", org));
        assertTrue(ok, "ABX renderer's contractURI does not revert on an org");
        string memory j = _json(abi.decode(ret, (string)));
        assertEq(vm.parseJsonString(j, ".name"), "Acme");
        assertEq(vm.parseJsonString(j, ".description"), "About.");
    }
}
