// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployProjects} from "../../script/Deploy.s.sol";
import {OrgFactory} from "../../src/OrgFactory.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {Audit2Base, IA2Coll} from "./Audit2Base.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "../fork/ContentLayer.sol";

/// @dev Re-audit of round-1 fix F5 (Deploy.s.sol checks): `validateGatewayBase` differential, and whether a
///      WRONG deployment can still pass `run()`.
contract Audit2DeployValidate is Test {
    DeployProjects d;

    function setUp() public {
        d = new DeployProjects();
    }

    function _ref(bytes memory b) internal pure returns (bool) {
        if (b.length > 128 || b.length < 9) return false;
        bytes memory s = "https://";
        for (uint256 i; i < 8; ++i) if (b[i] != s[i]) return false;
        if (b[8] == "/") return false;
        if (b[b.length - 1] == "/") return false;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c <= 0x20 || c >= 0x7f) return false;
            if (
                c == 0x22 || c == 0x26 || c == 0x27 || c == 0x28 || c == 0x29 || c == 0x3c || c == 0x3e || c == 0x5b
                    || c == 0x5c || c == 0x5d || c == 0x5e || c == 0x60 || c == 0x7b || c == 0x7c || c == 0x7d
            ) return false;
        }
        return true;
    }

    function _ok(string memory s) internal view returns (bool) {
        try d.validateGatewayBase(s) {
            return true;
        } catch {
            return false;
        }
    }

    /// CONFIRMED: matches the stated rule (and so the Links charset) on every byte and every length.
    function test_everyByteEveryPosition() public view {
        bytes memory base = "https://fs.abx.io";
        for (uint256 p; p < base.length; ++p) {
            for (uint256 v; v < 256; ++v) {
                bytes memory x = bytes.concat(base);
                x[p] = bytes1(uint8(v));
                assertEq(_ok(string(x)), _ref(x));
            }
        }
        for (uint256 n; n <= 140; ++n) {
            bytes memory x = new bytes(n);
            for (uint256 i; i < n; ++i) x[i] = i < 8 && n >= 8 ? bytes("https://")[i] : bytes1("a");
            assertEq(_ok(string(x)), _ref(x), "length sweep");
        }
        // boundary
        bytes memory y = new bytes(128);
        for (uint256 i; i < 128; ++i) y[i] = i < 8 ? bytes("https://")[i] : bytes1("a");
        assertTrue(_ok(string(y)), "128 accepted");
        y = bytes.concat(y, "a");
        assertFalse(_ok(string(y)), "129 refused");
    }

    function testFuzz_validateMatchesReference(bytes calldata b) public view {
        assertEq(_ok(string(b)), _ref(b));
    }

    /// Accepted-but-odd bases the script does NOT refuse. All are the deployer's own choice (frozen
    /// into the links renderer), none can break the JSON or markup; recorded so the doc says it.
    function test_acceptedOddities() public view {
        assertTrue(_ok("https://a"));
        assertTrue(_ok("https://a.b?x="), "query accepted");
        assertTrue(_ok("https://a.b#frag"), "fragment accepted");
        assertTrue(_ok("https://user:pw@a.b"), "userinfo accepted");
        assertTrue(_ok("https://localhost:8787"), "localhost accepted");
        assertTrue(_ok("https://127.0.0.1"), "loopback accepted");
        assertTrue(_ok("https://a.b/some/path"), "path prefix accepted");
        assertTrue(_ok("https://@"), "garbage host accepted");
        assertFalse(_ok("http://a.b"));
        assertFalse(_ok("HTTPS://a.b"));
        assertFalse(_ok("https://a.b/"));
    }
}

/// @dev Fork: run the REAL `run()` with wrong-but-coded dependencies.
contract Audit2DeployFork is Audit2Base {
    DeployProjects d;

    // The script's 84532 allow-table lists the ABX FS content layer's store pair.
    address constant STORE_DIR = CONTENT_DIRECTORY_STORE;
    address constant STORE_FILES = CONTENT_FILE_STORE;
    /// @dev The ninth generation's PREDICTED address (the deploy script's `pinned()`); not yet deployed.
    address constant CURRENT_FACTORY = 0xC5aBF9fBd94659cdfc173AF30c6052700Fa62798;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        d = new DeployProjects();
    }

    /// @dev The script's inputs, passed to `runWith` rather than set as env vars: `vm.setEnv` is process-global and
    ///      forge runs tests in parallel, so a test that sets them races every other test that does.
    function _run(address abx, address renderer, address seed, address dir, address files, string memory gw)
        internal
        returns (address factory)
    {
        (factory,) = d.runWith(
            DeployProjects.Inputs({
                abx: abx, renderer: renderer, seed: seed, directoryStore: dir, fileStore: files, gatewayBase: gw
            }),
            false,
            false
        );
    }

    /// @dev The scenarios share one fork, in order.
    function test_scriptScenarios() public {
        // (control) correct inputs: the script lands the factory at its pinned CREATE2 address
        // (OrgMeta first, then the factory bound to it, then the lens). Not deployed yet, so this is parity with the pin,
        // not with the chain; once it is deployed, this asserts the tree matches it.
        address live = _run(ABX_F, ABX_RENDERER, ABX_SEED, STORE_DIR, STORE_FILES, GATEWAY);
        assertEq(live, CURRENT_FACTORY, "tree == pinned generation (CREATE2 address parity)");

        // INVERTED after the deploy-script hardening (round-1 F5 follow-up): every wrong deployment that used
        // to pass `run()` now reverts before anything is broadcast. The original findings were: a wrong
        // renderer froze a tokenURI that can never render; swapped stores passed the tokenURI read yet nothing
        // could ever publish; a wrong seed source or ABX factory made a useless factory; and a lookalike
        // gateway domain passed. Fuller coverage, without env vars, is in DeployWrong*.t.sol.
        vm.expectRevert();
        _run(ABX_F, STORE_FILES, ABX_SEED, STORE_DIR, STORE_FILES, GATEWAY);

        vm.expectRevert();
        _run(ABX_F, ABX_RENDERER, ABX_SEED, STORE_FILES, STORE_DIR, GATEWAY);

        vm.expectRevert();
        _run(ABX_F, ABX_RENDERER, STORE_DIR, STORE_DIR, STORE_FILES, GATEWAY);

        vm.expectRevert();
        _run(STORE_DIR, ABX_RENDERER, ABX_SEED, STORE_DIR, STORE_FILES, GATEWAY);

        vm.expectRevert();
        _run(ABX_F, ABX_RENDERER, ABX_SEED, STORE_DIR, STORE_FILES, "https://fs.abx.io.evil.example");
    }

    function _someRealDirectory() internal returns (bytes32) {
        return ContentLayer.realDirectory("audit2-deploy");
    }
}
