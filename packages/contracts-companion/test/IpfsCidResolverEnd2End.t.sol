// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseCompanionTest} from "./Base.t.sol";
import {IpfsCidResolver} from "../src/IpfsCidResolver.sol";

/// @notice A representative project shape through the whole ABX FS content layer and the resolver:
///
///             proj/
///             ├── readme.md            (small raw-leaf file)
///             └── sub/
///                 └── big.bin          (280 KiB, 2 IPFS blocks → dag-pb file root)
///
///         Every level must match `ipfs-unixfs-importer` (byte-identical with Kubo for this profile), including the
///         cumulative `Tsize` of each link. Vectors from `fixtures/nested-chunked.json` (`end_to_end`), regenerated
///         by `node test/fixtures/generate-nested-chunked.mjs`.
contract IpfsCidResolverEnd2EndTest is BaseCompanionTest {
    IpfsCidResolver internal resolver;

    function setUp() public override {
        super.setUp();
        resolver = new IpfsCidResolver(address(fileStore), address(directoryStore));
    }

    function test_End2End_NestedDirWithChunkedFile_MatchesKubo() public {
        bytes32 bigCid = writeFile(deterministicBytes(280 * 1024, "e2e-nested-chunked"), "application/octet-stream");
        bytes32 readmeCid = writeFile(bytes("# end-to-end test project\n"), "text/markdown");

        string[] memory subNames = new string[](1);
        subNames[0] = "big.bin";
        bytes32[] memory subCids = new bytes32[](1);
        subCids[0] = bigCid;
        bytes32 subDir = writeDir(subNames, subCids, new bool[](1));

        string[] memory rootNames = new string[](2);
        (rootNames[0], rootNames[1]) = ("readme.md", "sub");
        bytes32[] memory rootCids = new bytes32[](2);
        (rootCids[0], rootCids[1]) = (readmeCid, subDir);
        bool[] memory rootIsDirs = new bool[](2);
        rootIsDirs[1] = true;
        bytes32 rootDir = writeDir(rootNames, rootCids, rootIsDirs);

        assertEq(
            resolver.computeFileCid(bigCid),
            "bafybeib3qtvznkck6odzclwrzhc5ze6slwtp3uuaej2amw275ha7kl3zs4",
            "big.bin file CID diverges from importer"
        );
        assertEq(
            resolver.computeFileCid(readmeCid),
            "bafkreic3dhyr4dha67lk4vovhvt5ck4y5cndkvgvni2ocvx6f4jbt3swsa",
            "readme.md raw-leaf CID diverges from importer"
        );
        assertEq(
            resolver.computeIpfsCid(subDir),
            "bafybeieqiffpuifwfbe67ixmp2svjhbvoffvprwon3tfd4zzplvkpxesp4",
            "sub/ directory CID diverges from importer"
        );
        assertEq(
            resolver.computeIpfsCid(rootDir),
            "bafybeihebubkyjsws2ofeck2d23dbc2sxxoqofwu5etlr2cfhizmpjfkui",
            "proj/ root directory CID diverges from importer"
        );
    }
}
