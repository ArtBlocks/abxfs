// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {GasModel} from "../GasModel.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IGasOrg {
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function transferFrom(address, address, uint256) external;
    function safeTransferFrom(address, address, uint256) external;
    function tokenURI(uint256) external view returns (string memory);
}

/// @dev The org layer's gas, per transaction, through the REAL ABX on Base Sepolia (skipped without
///      `ABXFS_RPC_URL_84532`). Run with `--isolate` so each call is metered as its own transaction, cold:
///
///        ABXFS_RPC_URL_84532=… forge test --isolate --match-contract GasProfileFork -vv
///
///      The publish, mint and org figures only report; the bounds that guard those claims live in
///      `test/GasClaims.t.sol`, which runs without a node. The param-write test below DOES assert bounds (the SDK's
///      previews), and they bite only under `--isolate`: without it each write reads 31k to 50k lower.
contract GasProfileForkTest is Test {
    address constant ABX = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;

    OrgFactory factory;
    address admin = makeAddr("admin");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();
        factory = OrgComponents.create(
            ABX, RENDERER, SEED, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE, address(new OrgMeta("https://fs.abx.io"))
        );
    }

    function _g() internal view returns (uint256) {
        return vm.lastCallGas().gasTotalUsed;
    }

    function _view(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = "a";
        bytes memory s = "https://";
        for (uint256 i; i < 8; ++i) b[i] = s[i];
    }

    function test_gasProfile() public {
        // createOrg, with its EIP-8037 split from the state it creates.
        vm.startStateDiffRecording();
        vm.prank(admin);
        address org = factory.createOrg("Gas Org", "", bytes32(0));
        uint256 legacy = _g();
        GasModel.Cost memory c = GasModel.cost(legacy, GasModel.created(vm.stopAndReturnStateDiff()));
        emit log_named_uint("createOrg legacy", c.legacy);
        emit log_named_uint("createOrg 8037 execution", c.execution8037);
        emit log_named_uint("createOrg 8037 state", c.state8037);

        vm.prank(admin);
        factory.setOpen(org, true);
        IGasOrg o = IGasOrg(org);
        bytes32 dirA = ContentLayer.realDirectory("a");
        bytes32 dirB = ContentLayer.realDirectory("b");
        bytes32 dirC = ContentLayer.realDirectory("c");

        vm.prank(admin);
        o.configureTokenParam(0, "abxfs.cid", dirA);
        emit log_named_uint("publish: first in the org (token 0 v1)", _g());
        vm.prank(admin);
        o.configureTokenParam(0, "abxfs.cid", dirB);
        emit log_named_uint("publish: steady (token 0 v2)", _g());
        vm.prank(admin);
        o.configureTokenParam(0, "abxfs.cid", dirC);
        emit log_named_uint("publish: steady (token 0 v3)", _g());

        address m = address(factory.minter());
        vm.prank(bob);
        (bool ok,) = m.call(abi.encodeWithSignature("mint(address,address)", org, bob));
        require(ok, "mint");
        emit log_named_uint("mint: new holder", _g());
        vm.prank(bob);
        (ok,) = m.call(abi.encodeWithSignature("mint(address,address)", org, bob));
        require(ok, "mint");
        emit log_named_uint("mint: existing holder", _g());

        vm.prank(bob);
        o.configureTokenParam(1, "abxfs.cid", dirA);
        emit log_named_uint("publish: first version of a token", _g());
        vm.prank(bob);
        o.configureTokenParam(1, "abxfs.cid", dirB);
        emit log_named_uint("publish: steady, token 1 v2", _g());

        vm.prank(admin);
        o.transferFrom(admin, carol, 0);
        emit log_named_uint("transfer: holder leaves the org, recipient new", _g());
        vm.prank(bob);
        o.transferFrom(bob, carol, 1);
        emit log_named_uint("transfer: holder keeps one, recipient existing", _g());

        // A file project's republish (the kind lock decides which store is asked first).
        bytes32 f1 = ContentLayer.realFile("f1");
        bytes32 f2 = ContentLayer.realFile("f2");
        vm.prank(bob);
        o.configureTokenParam(2, "abxfs.cid", f1);
        emit log_named_uint("publish: file project v1", _g());
        vm.prank(bob);
        o.configureTokenParam(2, "abxfs.cid", f2);
        emit log_named_uint("publish: file project v2", _g());

        // Renderers, as `eth_call` gas: the card of a published, named project; the links, default and a 512-byte view.
        vm.prank(carol);
        o.configureTokenParamData(0, "abxfs.name", bytes("A project & <its> \"name\""));
        uint256 g = gasleft();
        factory.card().render(org, 0, "image");
        emit log_named_uint("card render (published, escaped name)", g - gasleft());
        g = gasleft();
        factory.links().render(org, 0, "animation_url");
        emit log_named_uint("links render (default)", g - gasleft());
        vm.prank(carol);
        o.configureTokenParamData(0, "abxfs.view", _view(512));
        g = gasleft();
        factory.links().render(org, 0, "animation_url");
        emit log_named_uint("links render (512-byte view)", g - gasleft());
        g = gasleft();
        factory.traits().render(org, 0, "attributes");
        emit log_named_uint("traits render", g - gasleft());
        g = gasleft();
        o.tokenURI(0);
        emit log_named_uint("tokenURI (whole document)", g - gasleft());
    }

    /// @dev The SDK's previews of the project-param writes, `GAS_ESTIMATES` in `packages/sdk/src/gas.ts` (the CLI's
    ///      `WRITE_GAS` reads them), as of the delta audit. Hardcoded: a change there must be made here too.
    uint256 constant SDK_SET_NAME = 265_000; // GAS_ESTIMATES.projectSetName
    uint256 constant SDK_SET_VIEW = 435_000; // GAS_ESTIMATES.projectSetView
    uint256 constant SDK_SET_TAG = 195_000; // GAS_ESTIMATES.projectSetTag
    uint256 constant SDK_REMOVE_TAG = 70_000; // GAS_ESTIMATES.projectRemoveTag
    uint256 constant SDK_SET_OPEN = 40_000; // GAS_ESTIMATES.orgSetOpen
    uint256 constant SDK_TRANSFER_ADMIN = 60_000; // GAS_ESTIMATES.orgTransferAdmin
    uint256 constant SDK_ACCEPT_ADMIN = 100_000; // GAS_ESTIMATES.orgAcceptAdmin
    uint256 constant SDK_TRANSFER = 260_000; // GAS_ESTIMATES.projectTransfer

    function _bytes(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = "a";
    }

    function _measured(string memory what, uint256 bound) internal returns (uint256 gas) {
        gas = _g();
        emit log_named_uint(what, gas);
        assertLe(gas, bound, what);
    }

    /// @dev The name, view and tag writes through the real ABX, each at its shortest common case and at its cap
    ///      (a 128-byte name, a 512-byte view URL, a 64-byte tag), each a FIRST write (a fresh SSTORE2 blob, a new tag
    ///      slot): never above what the SDK previews (delta audit L4, where the preview was 150k / 80k / 60k). With
    ///      `--isolate` each is metered as its own cold transaction, intrinsic gas included (2026-10-30: name 205,354
    ///      and 258,111; view 212,746 and 426,037; tag 127,263 and 190,670; tag move 62,108; tag removal 68,499).
    ///      Without `--isolate` they read 31k to 50k lower, so only an isolated run guards the previews.
    function test_projectParamWritesWithinTheSdkPreview() public {
        vm.prank(admin);
        address org = factory.createOrg("Gas Org", "", bytes32(0));
        IGasOrg o = IGasOrg(org);
        address hook = address(factory.hook());
        address minter = address(factory.minter());
        // Built before any prank: writing them is a call of its own, which would take the prank.
        bytes32 dirA = ContentLayer.realDirectory("a");
        bytes32 dirB = ContentLayer.realDirectory("b");
        vm.prank(admin);
        o.configureTokenParam(0, "abxfs.cid", dirA);
        vm.prank(admin);
        o.configureTokenParam(0, "abxfs.cid", dirB);
        vm.prank(admin); // the org is closed: the admin mints
        (bool ok,) = minter.call(abi.encodeWithSignature("mint(address,address)", org, admin));
        require(ok, "mint");
        vm.prank(admin);
        o.configureTokenParam(1, "abxfs.cid", dirA);

        vm.prank(admin);
        o.configureTokenParamData(1, "abxfs.name", bytes("my-site"));
        _measured("setName 7 bytes", SDK_SET_NAME);
        vm.prank(admin);
        o.configureTokenParamData(0, "abxfs.name", _bytes(128));
        _measured("setName 128 bytes", SDK_SET_NAME);
        vm.prank(admin);
        o.configureTokenParamData(1, "abxfs.view", bytes("https://my-site.example/"));
        _measured("setView 24 bytes", SDK_SET_VIEW);
        vm.prank(admin);
        o.configureTokenParamData(0, "abxfs.view", _view(512));
        _measured("setView 512 bytes", SDK_SET_VIEW);

        string memory tag64 = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01";
        vm.prank(admin);
        (ok,) = hook.call(abi.encodeWithSignature("setTag(address,uint256,string,uint256)", org, 1, "v1", 1));
        require(ok, "setTag v1");
        _measured("setTag v1", SDK_SET_TAG);
        vm.prank(admin);
        (ok,) = hook.call(abi.encodeWithSignature("setTag(address,uint256,string,uint256)", org, 0, tag64, 1));
        require(ok, "setTag 64");
        _measured("setTag 64 bytes", SDK_SET_TAG);
        vm.prank(admin);
        (ok,) = hook.call(abi.encodeWithSignature("setTag(address,uint256,string,uint256)", org, 0, tag64, 2));
        require(ok, "move tag 64");
        _measured("setTag 64 bytes (move)", SDK_SET_TAG);
        vm.prank(admin);
        (ok,) = hook.call(abi.encodeWithSignature("removeTag(address,uint256,string)", org, 0, tag64));
        require(ok, "removeTag 64");
        _measured("removeTag 64 bytes", SDK_REMOVE_TAG);
    }

    /// @dev The org admin's writes and a project transfer through the real ABX, each a cold transaction under
    ///      `--isolate`: never above what the SDK previews. The transfer is `safeTransferFrom` (what the SDK sends) in all
    ///      four cases of the enumeration hook's owner indexes: the dearest is a sender that keeps a project in the org
    ///      and a recipient new to it (a sender that leaves frees index slots, which refunds gas). 2026-11-03: setOpen
    ///      28,850; safeTransferFrom 217,887 (sender keeps, recipient new), 176,326, 116,646 and 97,438; transferAdmin
    ///      48,690; acceptAdmin 77,144, closing an open org.
    function test_orgWritesWithinTheSdkPreview() public {
        vm.prank(admin);
        address org = factory.createOrg("Gas Org", "", bytes32(0));
        IGasOrg o = IGasOrg(org);
        address minter = address(factory.minter());

        vm.prank(admin);
        factory.setOpen(org, true);
        _measured("setOpen true", SDK_SET_OPEN);
        vm.prank(admin);
        factory.setOpen(org, false);
        _measured("setOpen false", SDK_SET_OPEN);

        // Fresh labels: on the fork some `makeAddr` addresses have code, and a safe transfer to code needs a receiver.
        address dave = makeAddr("abxfs-gas-dave");
        address erin = makeAddr("abxfs-gas-erin");
        address frank = makeAddr("abxfs-gas-frank");
        for (uint256 i; i < 2; ++i) {
            vm.prank(admin);
            (bool ok,) = minter.call(abi.encodeWithSignature("mint(address,address)", org, dave));
            require(ok, "mint");
        }
        // The admin holds token 0, dave tokens 1 and 2.
        vm.prank(dave);
        o.safeTransferFrom(dave, erin, 1);
        _measured("safeTransferFrom: sender keeps one, recipient new", SDK_TRANSFER);
        vm.prank(dave);
        o.safeTransferFrom(dave, erin, 2);
        _measured("safeTransferFrom: sender leaves, recipient holds one", SDK_TRANSFER);
        vm.prank(admin);
        o.safeTransferFrom(admin, frank, 0);
        _measured("safeTransferFrom: sender leaves, recipient new", SDK_TRANSFER);
        vm.prank(erin);
        o.safeTransferFrom(erin, frank, 1);
        _measured("safeTransferFrom: sender keeps one, recipient holds one", SDK_TRANSFER);

        vm.prank(admin);
        factory.setOpen(org, true); // the handover closes it again: the dearer acceptance
        vm.prank(admin);
        factory.transferAdmin(org, bob);
        _measured("transferAdmin", SDK_TRANSFER_ADMIN);
        vm.prank(bob);
        factory.acceptAdmin(org);
        _measured("acceptAdmin (closes the open org)", SDK_ACCEPT_ADMIN);
    }
}
