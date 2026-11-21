// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployDataReader} from "../script/DeployDataReader.s.sol";
import {FileDataReader} from "../src/FileDataReader.sol";
import {Deploy as CoreDeploy} from "@abxfs/core-script/Deploy.s.sol";
import {GasMeter} from "./FileDataReader.t.sol";

/// @dev The pinned reader over the canonical content layer of a live chain, reading a real gzip upload: the 13
///      JavaScript libraries of the first 500 Art Blocks Curated projects, stored with `--codec gzip --no-fastlz` under
///      one directory root on Base Sepolia, Base, Arbitrum One, Robinhood and Ethereum. Each file's data must hash to
///      the gzip bytes that were uploaded, and its `outputHash` to the original library. Takes `ABXFS_RPC_URL_84532`
///      (any chain holding the root works; the fork reads state, not `eth_call`, so endpoint gas caps do not apply);
///      skipped without it.
contract FileDataReaderForkTest is Test {
    bytes32 internal constant AB500_ROOT = 0x60cdc71765dc6954ebc3dcc4545d92a04d5a09ebd891bb02333d95ba0c39fa2d;

    struct Lib {
        string name;
        uint256 gzipBytes;
        bytes32 gzipHash;
        bytes32 jsHash;
    }

    FileDataReader internal reader;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        CoreDeploy.Addresses memory core = new CoreDeploy().pinned();
        if (core.fileStore.code.length == 0) vm.skip(true);
        address at = new DeployDataReader().runWith(core.fileStore, core.directoryStore, core.sstore2Backend);
        reader = FileDataReader(at);
    }

    function libs() internal pure returns (Lib[13] memory l) {
        l[0] = Lib(
            "aframe-1.2.0.min.js",
            344_012,
            0x24f18f6f390f687eb21da393f938f90592dda9db727b719321842a694210e0bc,
            0x61dda5ff5f80a622ea0c481d7009c112f2e57aa59bb6fde967f11406fda6321b
        );
        l[1] = Lib(
            "babylon-5.0.0.min.js",
            904_335,
            0xfaee6a021ed6a7351b5edaad189d66802e969036a547cf8f1c1d3ff7afb76848,
            0x183e812e4cb0b3184d5b6748bf9ca27da5edd0f9d117088c4f8e2e7f17152ebc
        );
        l[2] = Lib(
            "p5-1.0.0.min.js",
            163_587,
            0xc39c023f8754477c5c3c7c1e054ffac3e0cec6ca6d71ff799c9e7e259dc23d47,
            0xf87e7572ef7992b1a1bc62feb5abec7ab27fdb6703d7cc536ae8ce5403d0bf90
        );
        l[3] = Lib(
            "p5-1.9.0.min.js",
            243_275,
            0x6215d716211150c5ec3cb02eb2495e74b30172f3b6d814160e59e40b48b9eda9,
            0x59cc71c79a2265f27988fda075d9a50cf517ff7a7f3dfe6aafd0065def1f7ae7
        );
        l[4] = Lib(
            "paper-0.12.15.min.js",
            83_273,
            0x8266591d68879ee7a3983389525b3000dc9fd3e7b8816e3e88ea2efa6e9f938e,
            0xffa0ce4869d3e12f80fcd32f0954a327ed52ac85f73803d6433e217a132afe17
        );
        l[5] = Lib(
            "processing-1.4.6.min.js",
            66_156,
            0x4d9fff6b9f7e24bf4b3e61a6ec46f97016b4d4240bb9b684f916ed96c28cbeb5,
            0x2427219f38262030a4587044ec3770da4c3d6055aa039f1570d32fa8a5f1e8fd
        );
        l[6] = Lib(
            "regl-2.1.0.min.js",
            28_736,
            0x2c16fafa6f1e832d5e33e005334549b117a517c68ed758776f4efc43e928e1cf,
            0x98f35b6e017e1312e9e155d1f9f200e8b09224c5fa9a7f0fbea05efc7cb1cbcc
        );
        l[7] = Lib(
            "three-0.124.0.min.js",
            159_859,
            0xc57a394e4d28e500face05309b6f9ec965b03012e49234c97add8a958ac5c6b1,
            0xe564ebe6ddcc48b25252c6f47dd3222f6a955f314247265b45a0ffa8bf7a8020
        );
        l[8] = Lib(
            "three-0.160.0.min.js",
            167_719,
            0x9e8c146f0dda92fe0512d5b21081294baac1c23a68ab7da833a072cdb54d81c0,
            0xb0c3e2830e5e46e0ec81cf8da9e9084169c61975a105a9617b0db71c619c46d4
        );
        l[9] = Lib(
            "three-0.167.0.module.min.js",
            170_163,
            0x3798bf7d3eb768e71a4a33401d74de703f2281941b0b3b6b210c5b8a3f2a4d54,
            0x5c1c1e623794151444d51f33ebf09c772957587ff72d3d81f13111bdb0c30800
        );
        l[10] = Lib(
            "tone-14.8.15.js",
            79_558,
            0xb66a0c754e697302fd9a98392d013703677d3e27c0930a83b06a3790fc0dc302,
            0x2b13c8dd264da9422d9da92c74810b025c240be01d2b30ae20e0282edfe7eb1d
        );
        l[11] = Lib(
            "twemoji-14.0.2.min.js",
            4196,
            0xa0fb79ada67185da76ad28506a2c040d7e8795a4dd44fa4117f443d0b7b6f42c,
            0xa23639f6f28eefba98a59326f393ff4e1e97b856f99948685968d571e518ed33
        );
        l[12] = Lib(
            "zdog-1.1.2.min.js",
            7258,
            0xe1e28f9dfc9bcf2bea193ae09495a99c28ee909b33b664701d4ae907e537801d,
            0x0f333fd21a2218141e56d832a0955f33c7541a954d8568f48fc4884be65820af
        );
    }

    function test_ab500GzipLibrariesReadBackByteExact() public view {
        Lib[13] memory l = libs();
        for (uint256 i; i < l.length; i++) {
            (string memory mime, bytes32 codec, bytes32 outputHash, bytes memory data) =
                reader.readPathData(AB500_ROOT, l[i].name, 1 << 20, 64);
            assertEq(mime, "application/javascript", l[i].name);
            assertEq(codec, bytes32("gzip"), l[i].name);
            assertEq(data.length, l[i].gzipBytes, l[i].name);
            assertEq(keccak256(data), l[i].gzipHash, l[i].name);
            assertEq(outputHash, l[i].jsHash, l[i].name);
        }
    }

    function test_ab500Base64() public view {
        (,,, string memory b64) = reader.readPathDataBase64(AB500_ROOT, "zdog-1.1.2.min.js", 1 << 20, 64);
        (,,, bytes memory data) = reader.readPathData(AB500_ROOT, "zdog-1.1.2.min.js", 1 << 20, 64);
        assertEq(b64, vm.toBase64(data));
    }

    /// Cold gas for Babylon (904,335 bytes in 37 raw chunks), one path per test so neither warms the other: the direct
    /// read, and the same reader forced onto `ChunkStore.read` for every chunk (raw backend unset).
    function test_ab500BabylonGasDirect() public {
        emit log_named_uint("babylon direct", _babylonGas(address(reader)));
    }

    function test_ab500BabylonGasThroughChunkStore() public {
        FileDataReader viaStore =
            new FileDataReader(address(reader.directoryStore()), address(reader.fileStore()), address(0));
        emit log_named_uint("babylon through ChunkStore.read", _babylonGas(address(viaStore)));
    }

    function _babylonGas(address r) internal returns (uint256) {
        bytes32 cid = _lookup("babylon-5.0.0.min.js");
        return new GasMeter().measure(r, abi.encodeCall(FileDataReader.readFileData, (cid, 1 << 20, 64)));
    }

    function _lookup(string memory name) internal view returns (bytes32 cid) {
        (cid,) = reader.resolve(AB500_ROOT, name);
    }
}
