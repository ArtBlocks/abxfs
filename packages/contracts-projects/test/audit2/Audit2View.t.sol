// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectLinks} from "../../src/ProjectLinks.sol";

contract A2ViewToken {
    bytes public stored;

    function set(bytes calldata b) external {
        stored = b;
    }

    function tokenParamData(uint256, bytes32) external view returns (bytes memory) {
        return stored;
    }
}

/// @dev Differential test of the on-chain `abxfs.view` validator (`ProjectLinks._view`, observed through
///      `render`) against the SDK mirror `isUsableViewUrl` (packages/sdk/src/project.ts), run through node:
///
///        AUDIT2_ORACLE=<scratch>/view-oracle.cjs FOUNDRY_FFI=true forge test --match-path 'test/audit2/Audit2View*'
///
///      The oracle prints, per input, (1) the verdict of the SDK's real read path (TextDecoder, then
///      `isUsableViewUrl`) and (2) the verdict of `isUsableViewUrl` over a one-char-per-byte view.
contract Audit2View is Test {
    ProjectLinks links;
    A2ViewToken tok;

    function setUp() public {
        if (!vm.envOr("FOUNDRY_FFI", false) || bytes(vm.envOr("AUDIT2_ORACLE", string(""))).length == 0) vm.skip(true);
        links = new ProjectLinks("https://gw.example");
        tok = new A2ViewToken();
    }

    modifier unmetered() {
        vm.pauseGasMetering();
        _;
    }

    function _onchain(bytes memory b) internal returns (bool) {
        tok.set(b);
        (, bytes memory a) = links.render(address(tok), 0, "animation_url");
        (, bytes memory e) = links.render(address(tok), 0, "external_url");
        bool accA = keccak256(a) == keccak256(b);
        bool accE = keccak256(e) == keccak256(b);
        assertEq(accA, accE, "both fields agree");
        return accA;
    }

    /// @dev Returns (sdkFull, sdkLatin1) per input, batched through one node process.
    function _oracle(bytes[] memory inputs) internal returns (bool[] memory full, bool[] memory lat) {
        string[] memory cmd = new string[](2 + inputs.length);
        cmd[0] = "node";
        cmd[1] = vm.envString("AUDIT2_ORACLE");
        for (uint256 i; i < inputs.length; ++i) cmd[2 + i] = vm.toString(inputs[i]);
        bytes memory res = vm.ffi(cmd);
        require(res.length == inputs.length * 2, "oracle length");
        full = new bool[](inputs.length);
        lat = new bool[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            full[i] = res[2 * i] == 0x01;
            lat[i] = res[2 * i + 1] == 0x01;
        }
    }

    uint256 public disagreeFull;
    uint256 public disagreeLatin;
    uint256 public total;
    uint256 public acceptedOnchain;

    function _run(bytes[] memory inputs) internal {
        uint256 B = 150;
        for (uint256 s; s < inputs.length; s += B) {
            uint256 e = s + B > inputs.length ? inputs.length : s + B;
            bytes[] memory batch = new bytes[](e - s);
            for (uint256 i = s; i < e; ++i) batch[i - s] = inputs[i];
            (bool[] memory full, bool[] memory lat) = _oracle(batch);
            for (uint256 i; i < batch.length; ++i) {
                bool on = _onchain(batch[i]);
                ++total;
                if (on) ++acceptedOnchain;
                // the contract MUST agree with the pure per-byte mirror on every input
                if (on != lat[i]) {
                    ++disagreeLatin;
                    emit log_named_bytes("DISAGREES with per-byte mirror", batch[i]);
                    emit log_named_string("  onchain", on ? "accept" : "reject");
                }
                // the SDK's real read path may differ only through TextDecoder normalisation
                if (on != full[i]) {
                    ++disagreeFull;
                    if (disagreeFull <= 6) {
                        emit log_named_bytes("SDK read path differs from chain", batch[i]);
                        emit log_named_string("  onchain", on ? "accept" : "reject");
                    }
                }
            }
        }
    }

    // ── corpus classes ──────────────────────────────────────────────────────

    /// every byte value at every position of a valid URL
    function test_diff_everyByteEveryPosition() public unmetered {
        bytes memory base = "https://a.b/c?d=e#f";
        bytes[] memory inputs = new bytes[](base.length * 256);
        uint256 k;
        for (uint256 p; p < base.length; ++p) {
            for (uint256 v; v < 256; ++v) {
                bytes memory x = bytes.concat(base);
                x[p] = bytes1(uint8(v));
                inputs[k++] = x;
            }
        }
        _run(inputs);
        assertEq(disagreeLatin, 0, "contract == per-byte mirror");
        emit log_named_uint("inputs", total);
        emit log_named_uint("accepted on chain", acceptedOnchain);
        emit log_named_uint("SDK read path differs", disagreeFull);
    }

    /// every total length 0..530, all-valid body: pins the 512-byte boundary and the 9-byte floor
    function test_diff_lengthBoundary() public unmetered {
        bytes[] memory inputs = new bytes[](531);
        for (uint256 n; n <= 530; ++n) {
            bytes memory x = new bytes(n);
            for (uint256 i; i < n; ++i) x[i] = i < 8 ? bytes("https://")[i] : bytes1("a");
            inputs[n] = x;
        }
        _run(inputs);
        assertEq(disagreeLatin, 0);
        assertEq(disagreeFull, 0);
        // spot checks of the boundary itself
        assertTrue(_onchain(inputs[512]), "512 accepted");
        assertFalse(_onchain(inputs[513]), "513 refused");
        assertFalse(_onchain(inputs[8]), "'https://' alone refused");
        assertTrue(_onchain(inputs[9]), "'https://a' accepted");
    }

    /// scheme / prefix variants
    function test_diff_prefixes() public unmetered {
        string[24] memory ps = [
            "https://a", "HTTPS://a", "Https://a", "http://a", "https:/a", "https//a", "https:///", "https://", "ftps://a",
            "javascript:alert(1)", "data:text/html,x", "//a.b", " https://a", "https://a ", "https://a\n", "\thttps://a",
            "https://a b", "https://a%20b", "https://\xc3\xa9", "https://xn--e1afmkfd.xn--p1ai/", "https://a@b", "https://[::1]/", "https://a:1/", "https://a/\x7f"
        ];
        bytes[] memory inputs = new bytes[](ps.length);
        for (uint256 i; i < ps.length; ++i) inputs[i] = bytes(ps[i]);
        _run(inputs);
        assertEq(disagreeLatin, 0);
        assertEq(disagreeFull, 0);
    }

    /// random bodies drawn mostly from valid characters with rare unsafe ones, plus random raw bytes
    function test_diff_random() public unmetered {
        bytes[] memory inputs = new bytes[](1200);
        bytes memory unsafe_ = "\"&'<>\\`";
        uint256 seed = 0xA0D172;
        for (uint256 k; k < inputs.length; ++k) {
            seed = uint256(keccak256(abi.encode(seed, k)));
            uint256 mode = seed % 4;
            uint256 n = 9 + ((seed >> 8) % 60);
            if (mode == 3) n = 480 + ((seed >> 8) % 60); // around the cap
            bytes memory x = new bytes(n);
            for (uint256 i; i < n; ++i) {
                uint256 r = uint256(keccak256(abi.encode(seed, i)));
                if (i < 8 && mode != 2) x[i] = bytes("https://")[i];
                else if (mode == 2) x[i] = bytes1(uint8(r)); // raw random bytes
                else if (r % 97 == 0) x[i] = unsafe_[(r >> 8) % unsafe_.length];
                else if (r % 211 == 0) x[i] = bytes1(uint8(0x80 + (r >> 8) % 128));
                else x[i] = bytes1(uint8(0x21 + (r >> 8) % 94));
            }
            inputs[k] = x;
        }
        _run(inputs);
        assertEq(disagreeLatin, 0);
        assertEq(disagreeFull, 0);
        emit log_named_uint("accepted on chain", acceptedOnchain);
    }

    /// byte-order mark and other UTF-8 sequences the SDK's TextDecoder normalises (decode: strips a BOM)
    function test_diff_textDecoderNormalisations() public unmetered {
        bytes[] memory inputs = new bytes[](6);
        inputs[0] = bytes.concat(hex"efbbbf", "https://evil.example/");
        inputs[1] = bytes.concat(hex"efbbbf", hex"efbbbf", "https://evil.example/");
        inputs[2] = bytes.concat("https://a.b/", hex"efbbbf");
        inputs[3] = bytes.concat("https://a.b/", hex"c0af"); // invalid UTF-8
        inputs[4] = bytes.concat("https://a.b/", hex"eda080"); // lone surrogate (also non-ASCII)
        inputs[5] = bytes.concat(hex"efbbbf", new bytes(0), "https://a");
        _run(inputs);
        assertEq(disagreeLatin, 0, "the contract matches the per-byte mirror");
        emit log_named_uint("SDK read path differs from chain on the BOM class", disagreeFull);
        // FINDING (low): the SDK strips a leading BOM before validating, so a value the chain REFUSES
        // (and replaces by the default link) is surfaced by the SDK as a usable `viewUrl`.
        assertGt(disagreeFull, 0, "BOM-prefixed value: SDK accepts, chain refuses");
    }
}
