// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Audit2Base, IA2Coll} from "./Audit2Base.sol";

/// @dev The shipped battery (`test/fork/Battery.sol`) calls every ABX mutator with ZERO-valued arguments.
///      A zero argument often reverts for a reason unrelated to authorization (empty key, zero address, no
///      such token), so a gate that were open could still look closed. This battery uses MEANINGFUL
///      arguments (real keys, the real token, a hostile address) for every mutator, from every kind of
///      actor, on a real renounced org, and compares observable state before and after.
contract Audit2Battery is Audit2Base {
    address constant REG = 0x00000000000000447e69651d841bD8D104Bed493;
    address org;
    IA2Coll c;
    address operator = makeAddr("operator");
    address delegate_ = makeAddr("delegate");
    bytes32 root1 = keccak256("audit2-battery-root");

    function setUp() public {
        _fork();
        org = _newOrg(alice, "Battery");
        c = IA2Coll(org);
        _dirRoot(root1);
        vm.startPrank(alice);
        c.setApprovalForAll(operator, true);
        c.approve(mallory, 0);
        (bool ok,) = REG.call(abi.encodeWithSignature("delegateAll(address,bytes32,bool)", delegate_, bytes32(0), true));
        require(ok);
        vm.stopPrank();
    }

    function _calls() internal view returns (string[] memory labels, bytes[] memory data) {
        uint256 n = 46;
        labels = new string[](n);
        data = new bytes[](n);
        string[] memory none = new string[](0);
        uint256 i;
        (labels[i], data[i++]) = ("setParamSchema(abxfs.cid retype)", abi.encodeWithSignature("setParamSchema(bytes32,uint8,uint8,address,uint48,bytes32,bytes32,string[])", bytes32("abxfs.cid"), uint8(7), uint8(0), mallory, uint48(1), bytes32(0), bytes32(0), none));
        (labels[i], data[i++]) = ("setParamSchema(new key)", abi.encodeWithSignature("setParamSchema(bytes32,uint8,uint8,address,uint48,bytes32,bytes32,string[])", bytes32("evil.key"), uint8(7), uint8(1), address(0), uint48(0), bytes32(0), bytes32(0), none));
        (labels[i], data[i++]) = ("setParamHooks(evil)", abi.encodeWithSignature("setParamHooks(address,address,address)", mallory, mallory, mallory));
        (labels[i], data[i++]) = ("setParamHooks(0,0,0) unarm", abi.encodeWithSignature("setParamHooks(address,address,address)", address(0), address(0), address(0)));
        (labels[i], data[i++]) = ("lockParamHooks", abi.encodeWithSignature("lockParamHooks()"));
        (labels[i], data[i++]) = ("setDelegateRegistry(real)", abi.encodeWithSignature("setDelegateRegistry(address)", REG));
        (labels[i], data[i++]) = ("setMinter(mallory)", abi.encodeWithSignature("setMinter(address)", mallory));
        (labels[i], data[i++]) = ("setPaused(true)", abi.encodeWithSignature("setPaused(bool)", true));
        (labels[i], data[i++]) = ("setMaxInvocations(1)", abi.encodeWithSignature("setMaxInvocations(uint256)", uint256(1)));
        (labels[i], data[i++]) = ("setSeedSource(mallory)", abi.encodeWithSignature("setSeedSource(address)", mallory));
        (labels[i], data[i++]) = ("setTransferValidator(mallory)", abi.encodeWithSignature("setTransferValidator(address)", mallory));
        (labels[i], data[i++]) = ("setDefaultRoyalty(mallory,max)", abi.encodeWithSignature("setDefaultRoyalty(address,uint16)", mallory, uint16(1000)));
        (labels[i], data[i++]) = ("reduceMaxRoyaltyBps(0)", abi.encodeWithSignature("reduceMaxRoyaltyBps(uint16)", uint16(0)));
        (labels[i], data[i++]) = ("setPrimaryPayee(mallory)", abi.encodeWithSignature("setPrimaryPayee(address)", mallory));
        (labels[i], data[i++]) = ("setTokenURIRenderer(mallory)", abi.encodeWithSignature("setTokenURIRenderer(address)", mallory));
        (labels[i], data[i++]) = ("setContractURIRenderer(mallory)", abi.encodeWithSignature("setContractURIRenderer(address)", mallory));
        (labels[i], data[i++]) = ("setTokenURIBase(str)", abi.encodeWithSignature("setTokenURIBase(string)", "https://evil/"));
        (labels[i], data[i++]) = ("setTokenURIOverride(0,str)", abi.encodeWithSignature("setTokenURIOverride(uint256,string)", uint256(0), "https://evil/0"));
        (labels[i], data[i++]) = ("setContractURIBase(str)", abi.encodeWithSignature("setContractURIBase(string)", "https://evil/"));
        (labels[i], data[i++]) = ("setContractURIOverride(str)", abi.encodeWithSignature("setContractURIOverride(string)", "https://evil/c"));
        (labels[i], data[i++]) = ("setTokenField(0,image)", abi.encodeWithSignature("setTokenField(uint256,bytes32,bytes32,bytes)", uint256(0), bytes32("image"), bytes32("url"), bytes("https://evil/i.png")));
        (labels[i], data[i++]) = ("setContractField(animation_url)", abi.encodeWithSignature("setContractField(bytes32,bytes32,bytes)", bytes32("animation_url"), bytes32("url"), bytes("https://evil/")));
        (labels[i], data[i++]) = ("lockTokenField(0,image)", abi.encodeWithSignature("lockTokenField(uint256,bytes32)", uint256(0), bytes32("image")));
        (labels[i], data[i++]) = ("lockContractField(image)", abi.encodeWithSignature("lockContractField(bytes32)", bytes32("image")));
        (labels[i], data[i++]) = ("lockTokenURI", abi.encodeWithSignature("lockTokenURI()"));
        (labels[i], data[i++]) = ("lockContractURI", abi.encodeWithSignature("lockContractURI()"));
        (labels[i], data[i++]) = ("lockScript", abi.encodeWithSignature("lockScript()"));
        (labels[i], data[i++]) = ("lockDependencies", abi.encodeWithSignature("lockDependencies()"));
        (labels[i], data[i++]) = ("setScriptChunk(0,x)", abi.encodeWithSignature("setScriptChunk(uint256,bytes)", uint256(0), bytes("alert(1)")));
        (labels[i], data[i++]) = ("removeLastScriptChunk", abi.encodeWithSignature("removeLastScriptChunk()"));
        (labels[i], data[i++]) = ("setDependency", abi.encodeWithSignature("setDependency(uint256,uint8,bytes32)", uint256(0), uint8(1), bytes32("x")));
        (labels[i], data[i++]) = ("setDependencyRegistry(mallory)", abi.encodeWithSignature("setDependencyRegistry(address)", mallory));
        (labels[i], data[i++]) = ("removeLastDependency", abi.encodeWithSignature("removeLastDependency()"));
        (labels[i], data[i++]) = ("mint(mallory)", abi.encodeWithSignature("mint(address)", mallory));
        (labels[i], data[i++]) = ("mintMany(mallory,3)", abi.encodeWithSignature("mintMany(address,uint256)", mallory, uint256(3)));
        (labels[i], data[i++]) = ("burn(0)", abi.encodeWithSignature("burn(uint256)", uint256(0)));
        (labels[i], data[i++]) = ("transferOwnership(mallory)", abi.encodeWithSignature("transferOwnership(address)", mallory));
        (labels[i], data[i++]) = ("completeOwnershipHandover(mallory)", abi.encodeWithSignature("completeOwnershipHandover(address)", mallory));
        (labels[i], data[i++]) = ("renounceOwnership", abi.encodeWithSignature("renounceOwnership()"));
        (labels[i], data[i++]) = ("setContractParam(k,v)", abi.encodeWithSignature("setContractParam(bytes32,bytes32)", bytes32("k"), bytes32("v")));
        (labels[i], data[i++]) = ("setContractParamData(k,v)", abi.encodeWithSignature("setContractParamData(bytes32,bytes)", bytes32("k"), bytes("v")));
        (labels[i], data[i++]) = ("clearContractParam(k)", abi.encodeWithSignature("clearContractParam(bytes32)", bytes32("k")));
        (labels[i], data[i++]) = ("setTokenParam(0,seed)", abi.encodeWithSignature("setTokenParam(uint256,bytes32,bytes32)", uint256(0), bytes32("seed"), bytes32(uint256(1))));
        (labels[i], data[i++]) = ("setTokenParamData(0,abxfs.view)", abi.encodeWithSignature("setTokenParamData(uint256,bytes32,bytes)", uint256(0), bytes32("abxfs.view"), bytes("https://evil/")));
        (labels[i], data[i++]) = ("clearTokenParam(0,abxfs.name)", abi.encodeWithSignature("clearTokenParam(uint256,bytes32)", uint256(0), bytes32("abxfs.name")));
        (labels[i], data[i++]) = ("clearTokenParam(0,seed)", abi.encodeWithSignature("clearTokenParam(uint256,bytes32)", uint256(0), bytes32("seed")));
        require(i == n, "count");
    }

    function _snap() internal view returns (bytes32) {
        // Two digests, not one 13-argument `abi.encode`: that encoder is "stack too deep" with the optimizer off,
        // which is how `forge coverage` compiles, and it broke the coverage run for the whole package.
        (address a, address b, address x) = c.paramHooks();
        bytes32 collection = keccak256(
            abi.encode(c.owner(), a, b, x, c.paramHooksLocked(), c.totalSupply(), c.nextTokenId(), c.delegateRegistry())
        );
        bytes32 views = keccak256(
            abi.encode(
                keccak256(bytes(c.tokenURI(0))),
                keccak256(bytes(c.contractURI())),
                c.ownerOf(0),
                hook.versionCount(org, 0),
                hook.globalPublishCount()
            )
        );
        return keccak256(abi.encode(collection, views));
    }

    function test_everyMutatorMeaningfulArgsEveryActor() public {
        (string[] memory labels, bytes[] memory data) = _calls();
        address[9] memory actors = [alice, bob, mallory, delegate_, operator, address(f), address(hook), address(en), address(lens)];
        string[9] memory an = ["alice(admin+owner)", "bob", "mallory", "delegate", "operator(for-all)", "factory", "hook", "enumeration", "lens"];
        bytes32 before = _snap();
        uint256 succeeded;
        for (uint256 k; k < data.length; ++k) {
            for (uint256 a; a < actors.length; ++a) {
                uint256 snap = vm.snapshotState();
                vm.prank(actors[a]);
                (bool ok,) = org.call(data[k]);
                if (ok) {
                    ++succeeded;
                    emit log_named_string(string.concat(an[a], " SUCCEEDED"), labels[k]);
                }
                vm.revertToState(snap);
            }
        }
        // the only calls allowed to succeed are caller-scoped bookkeeping that grants nothing:
        // none in this list is (requestOwnershipHandover / cancel are not listed), so zero is expected,
        // except `completeOwnershipHandover` which requires owner (zero) -> must fail too.
        assertEq(succeeded, 0, "no ABX mutator is reachable by any actor");
        assertEq(_snap(), before, "state untouched");
    }

    /// The same meaningful-argument battery from the actors on ABX's side: its factory, the clone's implementation,
    /// its metadata renderer and seed source, the org's minter, and the org itself (a self-call). Only the minter may
    /// mint (it is the mint authority, and no code path reaches its address but `OrgMinter.mint` after `mayMint`).
    function test_everyMutatorFromAbxSideActors() public {
        (string[] memory labels, bytes[] memory data) = _calls();
        (bool okImpl, bytes memory implRet) = ABX_F.staticcall(abi.encodeWithSignature("implementation()"));
        require(okImpl && implRet.length == 32, "implementation()");
        address impl = abi.decode(implRet, (address));
        address[6] memory actors = [ABX_F, impl, address(f.minter()), ABX_RENDERER, ABX_SEED, org];
        bytes32 before = _snap();
        uint256 succeeded;
        for (uint256 k; k < data.length; ++k) {
            for (uint256 a; a < actors.length; ++a) {
                uint256 snap = vm.snapshotState();
                vm.prank(actors[a]);
                (bool ok,) = org.call(data[k]);
                if (ok) {
                    bool expected = actors[a] == address(f.minter())
                        && (keccak256(bytes(labels[k])) == keccak256("mint(mallory)")
                            || keccak256(bytes(labels[k])) == keccak256("mintMany(mallory,3)"));
                    if (!expected) ++succeeded;
                    emit log_named_string(expected ? "expected (minter)" : "UNEXPECTED SUCCESS", labels[k]);
                }
                vm.revertToState(snap);
            }
        }
        assertEq(succeeded, 0, "no ABX mutator but the minter's mint is reachable from ABX's side");
        assertEq(_snap(), before, "state untouched");
    }

    /// CONFIRMED: the one open-looking surface is the handover REQUEST; completing it needs owner() == caller,
    /// and owner() is zero, so it cannot finish.
    function test_handoverRequestIsInert() public {
        vm.prank(mallory);
        (bool ok,) = org.call(abi.encodeWithSignature("requestOwnershipHandover()"));
        assertTrue(ok, "request is caller-scoped and open");
        vm.prank(mallory);
        (ok,) = org.call(abi.encodeWithSignature("completeOwnershipHandover(address)", mallory));
        assertFalse(ok);
        vm.prank(address(0));
        (ok,) = org.call(abi.encodeWithSignature("completeOwnershipHandover(address)", mallory));
        // msg.sender == 0 would equal owner() == 0; not producible on a real chain, but record the fact
        emit log_named_string("complete as msg.sender==0 (unreachable on a real chain)", ok ? "ok" : "reverted");
        assertEq(c.owner(), ok ? mallory : address(0));
    }

    /// CONFIRMED: the minter actor is the only address ABX mint-authorizes, and it can only do what its
    /// code does (`mint` after `mayMint`); a delegatecall into it from a hostile contract cannot mint,
    /// because ABX sees the hostile contract (not the minter) as msg.sender.
    function test_minterDelegatecallAndMulticallPaths() public {
        address m = address(f.minter());
        Delegator d = new Delegator();
        // admin invokes through a hostile contract that delegatecalls minter.mint
        vm.prank(alice);
        (bool ok,) = address(d).call(abi.encodeCall(Delegator.go, (m, org, mallory)));
        assertFalse(ok, "delegatecall into the minter cannot mint: ABX msg.sender is the delegator");
        assertEq(c.totalSupply(), 1);

        // multicall on the org preserves msg.sender; a mint through it from the admin fails the same way
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(IA2Coll.mint, (mallory));
        vm.prank(alice);
        vm.expectRevert();
        c.multicall(inner);
        vm.prank(m);
        c.multicall(inner); // the minter address itself (unreachable except through minter code) could
        assertEq(c.totalSupply(), 2, "minter-as-msg.sender is the authority; no code path lets anyone be it");
    }
}

contract Delegator {
    function go(address minter, address org, address to) external {
        (bool ok, bytes memory ret) = minter.delegatecall(abi.encodeWithSignature("mint(address,address)", org, to));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
