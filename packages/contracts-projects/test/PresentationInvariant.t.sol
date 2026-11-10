// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../src/interfaces/IProjectPresentation.sol";
import {
    PresentationFactoryMock,
    PresentationHookMock,
    PresentationOrgMock,
    PresentationReaderMock,
    PresentationIpfsMock
} from "./ProjectPresentation.t.sol";

contract PresentationSequenceHandler is Test {
    ProjectPresentation public immutable presentation;
    PresentationOrgMock public immutable org;
    PresentationHookMock public immutable hook;
    uint8 public observedLocks;
    bytes32 public lockedRoot;
    bytes32 public lockedPath;
    IProjectPresentation.Method public lockedMethod;
    bytes32 public lockedEndpoints;
    bool public violation;
    address constant SECOND_OWNER = address(0x12345);
    address constant STRANGER = address(0x67890);

    constructor(ProjectPresentation p, PresentationOrgMock o, PresentationHookMock h) {
        presentation = p;
        org = o;
        hook = h;
    }

    function publishAndMoveTag(bytes32 head, bytes32 tag) external {
        hook.publish(bytes32(uint256(head) | 1));
        hook.moveTag(bytes32(uint256(tag) | 1));
        _observe();
    }

    function transfer() external {
        address owner = org.owner();
        vm.prank(owner);
        org.transfer(owner == address(this) ? SECOND_OWNER : address(this));
        _observe();
    }

    function chooseTarget(uint8 selection, bool nested, bool unauthorized) external {
        IProjectPresentation.Selection s = IProjectPresentation.Selection(selection % 3);
        vm.prank(unauthorized ? STRANGER : org.owner());
        try presentation.setTarget(
            address(org),
            0,
            s,
            s == IProjectPresentation.Selection.Version ? 1 : 0,
            s == IProjectPresentation.Selection.Tag ? "release" : "",
            nested ? "nested" : "index.html"
        ) {
            if (unauthorized || observedLocks & 1 != 0) violation = true;
        } catch {
            if (!unauthorized && observedLocks & 1 == 0) violation = true;
        }
        _observe();
    }

    function chooseMethod(uint8 method, bool unauthorized) external {
        vm.prank(unauthorized ? STRANGER : org.owner());
        try presentation.setMethod(address(org), 0, IProjectPresentation.Method(method % 3)) {
            if (unauthorized || observedLocks & 2 != 0) violation = true;
        } catch {
            if (!unauthorized && observedLocks & 2 == 0) violation = true;
        }
        _observe();
    }

    function chooseEndpoints(bool custom, bool unauthorized) external {
        vm.prank(unauthorized ? STRANGER : org.owner());
        try presentation.setEndpoints(
            address(org), 0, custom ? "https://chain.example" : "", custom ? "https://dweb.link" : ""
        ) {
            if (unauthorized || observedLocks & 4 != 0) violation = true;
        } catch {
            if (!unauthorized && observedLocks & 4 == 0) violation = true;
        }
        _observe();
    }

    function applyLock(uint8 bits, bool stale, bool unauthorized) external {
        uint8 mask = uint8(bound(bits, 1, 7));
        bytes32 expected = presentation.lockCommitment(address(org), 0, mask);
        if (stale) expected = bytes32(uint256(expected) ^ 2);
        vm.prank(unauthorized ? STRANGER : org.owner());
        try presentation.lock(address(org), 0, mask, expected) {
            if (unauthorized || stale) violation = true;
        } catch {
            if (!unauthorized && !stale) violation = true;
        }
        _observe();
    }

    function legacyParam(bytes32 key, bytes32 value) external {
        org.configureTokenParam(0, key, value);
        _observe();
    }

    function _observe() private {
        IProjectPresentation.Config memory c = presentation.config(address(org), 0);
        (bytes32 root, string memory path) = presentation.target(address(org), 0);
        bytes32 endpoints = keccak256(abi.encode(c.chainBase, c.ipfsBase));
        if (c.locks & observedLocks != observedLocks) violation = true;
        if (observedLocks & 1 != 0 && (root != lockedRoot || keccak256(bytes(path)) != lockedPath)) violation = true;
        if (observedLocks & 2 != 0 && c.method != lockedMethod) violation = true;
        if (observedLocks & 4 != 0 && endpoints != lockedEndpoints) violation = true;
        if (c.locks & 1 != 0 && observedLocks & 1 == 0) {
            lockedRoot = root;
            lockedPath = keccak256(bytes(path));
        }
        if (c.locks & 2 != 0 && observedLocks & 2 == 0) lockedMethod = c.method;
        if (c.locks & 4 != 0 && observedLocks & 4 == 0) lockedEndpoints = endpoints;
        observedLocks |= c.locks;
    }
}

contract PresentationInvariantTest is StdInvariant, Test {
    PresentationSequenceHandler handler;

    function setUp() public {
        address files = address(0x100);
        address dirs = address(0x200);
        vm.etch(files, hex"00");
        vm.etch(dirs, hex"00");
        PresentationFactoryMock factory = new PresentationFactoryMock();
        PresentationHookMock hook = new PresentationHookMock(address(factory), files, dirs);
        PresentationOrgMock org = new PresentationOrgMock(address(hook), address(this));
        ProjectPresentation p = new ProjectPresentation(
            address(new PresentationReaderMock(files, dirs)),
            address(new PresentationIpfsMock(files, dirs)),
            "https://fs.abx.io"
        );
        handler = new PresentationSequenceHandler(p, org, hook);
        org.transfer(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.publishAndMoveTag.selector;
        selectors[1] = handler.transfer.selector;
        selectors[2] = handler.chooseTarget.selector;
        selectors[3] = handler.chooseMethod.selector;
        selectors[4] = handler.chooseEndpoints.selector;
        selectors[5] = handler.applyLock.selector;
        selectors[6] = handler.legacyParam.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_locksRemainBindingAcrossOwnerAndSourceChanges() public view {
        assertFalse(handler.violation(), "authorization, negative veto, or irreversible lock invariant violated");
    }
}
