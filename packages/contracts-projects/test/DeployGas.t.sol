// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {DWPresentationDependency} from "./DeployWrong.t.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {GasModel} from "./GasModel.sol";

/// @dev Every org-layer deploy is one transaction through the keyless CREATE2 deployer. Each must fit EIP-7825's
///      2^24 cap on a legacy chain (where it caps all gas) and, under EIP-8037, keep its EXECUTION gas under 2^24 and
///      its total under Ethereum's 60M block. The numbers are measured per transaction when run with `--isolate`
///      (`forge test --isolate --match-contract DeployGas -vv`); without it the bounds still hold, on execution only.
contract DeployGasTest is Test {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 constant TX_CAP = 16_777_216;
    uint256 constant BLOCK = 60_000_000;

    function _deploy(string memory label, bytes32 salt, bytes memory initCode) internal returns (address at) {
        assertLt(initCode.length, 49_152, string.concat(label, ": initcode over EIP-3860"));
        vm.startStateDiffRecording();
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        uint256 used = g - gasleft();
        GasModel.Created memory created = GasModel.created(vm.stopAndReturnStateDiff());
        require(ok && ret.length == 20, "deploy failed");
        at = address(bytes20(ret));
        assertLt(at.code.length, 24_576, string.concat(label, ": runtime over EIP-170"));
        // Under --isolate the deploy is its own transaction and lastCallGas is its total, intrinsic cost included.
        uint256 total = vm.lastCallGas().gasTotalUsed;
        if (total < used) total = used;
        GasModel.Cost memory c = GasModel.cost(total, created);
        emit log_named_string("contract", label);
        emit log_named_uint("  initcode bytes", initCode.length);
        emit log_named_uint("  legacy total", c.legacy);
        emit log_named_uint("  8037 execution", c.execution8037);
        emit log_named_uint("  8037 state", c.state8037);
        emit log_named_uint("  8037 total", c.execution8037 + c.state8037);
        assertLt(c.legacy, TX_CAP, string.concat(label, ": over 2^24 on a legacy chain"));
        assertLt(c.execution8037, TX_CAP, string.concat(label, ": EIP-8037 execution over 2^24"));
        assertLt(c.execution8037 + c.state8037, BLOCK, string.concat(label, ": EIP-8037 total over a 60M block"));
    }

    function test_everyDeployFitsBothSchedules() public {
        bytes32 salt = keccak256("deploy-gas");
        address meta = _deploy("OrgMeta", salt, abi.encodePacked(type(OrgMeta).creationCode, abi.encode("https://fs.abx.io")));
        address dir = address(0xD1);
        address files = address(0xF1);
        vm.etch(dir, hex"00"); vm.etch(files, hex"00");
        address reader = address(new DWPresentationDependency(dir, files));
        address resolver = address(new DWPresentationDependency(dir, files));
        address presentation = _deploy("ProjectPresentation", salt, abi.encodePacked(type(ProjectPresentation).creationCode, abi.encode(reader, resolver, "https://fs.abx.io")));
        address f = _deploy(
            "OrgFactory",
            salt,
            abi.encodePacked(
                type(OrgFactory).creationCode,
                abi.encode(address(0xA1), address(0xA2), address(0xA3), dir, files, meta, presentation)
            )
        );
        bytes32 cs = OrgFactory(f).COMPONENT_SALT();
        address hook = _deploy("ProjectHook", cs, abi.encodePacked(type(ProjectHook).creationCode, abi.encode(dir, files, f)));
        assertEq(hook, address(OrgFactory(f).hook()));
        _deploy("ProjectEnumeration", cs, abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(f)));
        _deploy("OrgMinter", cs, abi.encodePacked(type(OrgMinter).creationCode, abi.encode(f)));
        _deploy("ProjectCard", cs, abi.encodePacked(type(ProjectCard).creationCode, abi.encode(hook)));
        _deploy("ProjectTraits", cs, abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(hook)));
        assertTrue(OrgFactory(f).componentsDeployed());
        _deploy("Lens", salt, abi.encodePacked(type(Lens).creationCode, abi.encode(f, hook)));
    }
}
