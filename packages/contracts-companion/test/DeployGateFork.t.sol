// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";

/// The resolver's deploy script shares the content layer's local-chain rule (`LocalChain`). Against any RPC that is not
/// a 31337 chain, with `block.chainid` overridden to 31337, a resolver that would not land at its pin is still refused
/// before anything is broadcast. Takes `ABXFS_GATE_RPC_URL`, else `ABXFS_RPC_URL_84532`; skipped without either.
contract ResolverDeployGateForkTest is Test {
    function setUp() public {
        string memory url = vm.envOr("ABXFS_GATE_RPC_URL", vm.envOr("ABXFS_RPC_URL_84532", string("")));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        vm.chainId(31_337);
    }

    function test_aResolverOffItsPinIsRefusedWhateverBlockChainidSays() public {
        // Two stand-in stores: any address but the pinned stores moves the resolver (they are constructor arguments).
        address files = address(0xF11E);
        address dirs = address(0xD12);
        vm.etch(files, hex"00");
        vm.etch(dirs, hex"00");
        Deploy d = new Deploy();
        address want = d.predict(files, dirs);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnexpectedAddress.selector, want, d.pinned()));
        d.runWith(files, dirs);
        assertEq(want.code.length, 0, "nothing was deployed");
    }
}
