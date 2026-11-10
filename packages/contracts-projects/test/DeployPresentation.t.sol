// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RawStub} from "./mocks/Hostile.sol";
import {Test} from "forge-std/Test.sol";
import {DeployProjects} from "../script/Deploy.s.sol";
import {DeployPresentation} from "../script/DeployPresentation.s.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {PresentationChecks} from "../script/PresentationChecks.sol";
import {
    DWAbxFactory,
    DWRenderer,
    DWSeed,
    DWDirectoryStore,
    DWFileStore,
    DWPresentation,
    DWPresentationDependency
} from "./DeployWrong.t.sol";

contract DeployPresentationTest is Test {
    bytes32 constant CREATION_CODE_HASH = 0xf6399f3412b1146290212a72f2c43e142496a5ace0567e15ddb4244ceacd5d31;
    address constant READER = 0xe6d62620A284565B7F0B3581A6972BA3Be5C8B13;
    address constant RESOLVER = 0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d;
    string constant GATEWAY = "https://fs.abx.io";

    DeployProjects internal projects;
    DeployPresentation internal script;
    DeployProjects.Inputs internal input;
    DWPresentation internal presentation;

    function setUp() public {
        projects = new DeployProjects();
        script = new DeployPresentation();
        input = DeployProjects.Inputs(
            address(new DWAbxFactory()),
            address(new DWRenderer()),
            address(new DWSeed()),
            address(new DWDirectoryStore()),
            address(new DWFileStore()),
            address(0),
            GATEWAY
        );
        presentation = new DWPresentation(input.directoryStore, input.fileStore, GATEWAY);
        input.presentation = address(presentation);
    }

    function test_presentationCreationCodeIsPinned() public pure {
        assertEq(keccak256(type(ProjectPresentation).creationCode), CREATION_CODE_HASH);
    }

    function test_presentationPredictionIsPinned() public view {
        assertEq(script.predict(READER, RESOLVER, GATEWAY), script.pinned());
        assertEq(projects.expected().presentation, script.pinned());
    }

    function test_preflightRequiresPresentationAndItsWholeDependencyTree() public {
        projects.preflight(input, true, true);
        input.presentation = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.MissingAddress.selector, "ABXFS_PRESENTATION"));
        projects.preflight(input, true, true);
        input.presentation = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, "ABXFS_PRESENTATION", address(0x1234)));
        projects.preflight(input, true, true);
        input.presentation = address(presentation);
        address resolver = presentation.ipfsResolver();
        presentation.setDependencies(address(0), resolver);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "reader()", address(presentation)));
        projects.preflight(input, true, true);
        presentation.setDependencies(address(0x1234), resolver);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, "ABXFS_CONTENT_READER", address(0x1234)));
        projects.preflight(input, true, true);
        address reader = address(new DWPresentationDependency(input.directoryStore, input.fileStore));
        presentation.setDependencies(reader, address(0x1234));
        vm.expectRevert(
            abi.encodeWithSelector(DeployProjects.NoCode.selector, "ABXFS_IPFS_CID_RESOLVER", address(0x1234))
        );
        projects.preflight(input, true, true);
    }

    function test_overridesNeverBypassPresentationStoresOrDefaultBase() public {
        input.presentation = address(new DWPresentation(input.fileStore, input.directoryStore, GATEWAY));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "presentation.directoryStore"));
        projects.preflight(input, true, true);
        input.presentation = address(presentation);
        presentation.setBase("https://other.example");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "presentation.defaultChainBase"));
        projects.preflight(input, true, true);
    }

    function test_readerAndResolverMustBothNameTheFactoryStorePair() public {
        address reader = presentation.reader();
        address resolver = presentation.ipfsResolver();
        address swapped = address(new DWPresentationDependency(input.fileStore, input.directoryStore));
        presentation.setDependencies(swapped, resolver);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "reader.directoryStore"));
        projects.preflight(input, true, true);
        presentation.setDependencies(reader, swapped);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "resolver.directoryStore"));
        projects.preflight(input, true, true);
        vm.expectRevert(abi.encodeWithSelector(PresentationChecks.WiringMismatch.selector, "resolver.directoryStore"));
        script.preflight(reader, swapped, GATEWAY);
    }

    function test_malformedPresentationGettersAreNamedProbeFailures() public {
        RawStub fake = new RawStub();
        fake.ret(bytes4(keccak256("directoryStore()")), abi.encode(input.directoryStore));
        fake.ret(bytes4(keccak256("fileStore()")), abi.encode(input.fileStore));
        fake.ret(bytes4(keccak256("reader()")), abi.encode(presentation.reader()));
        fake.ret(bytes4(keccak256("ipfsResolver()")), abi.encode(presentation.ipfsResolver()));
        fake.ret(bytes4(keccak256("defaultChainBase()")), abi.encode(GATEWAY));
        input.presentation = address(fake);
        projects.preflight(input, true, true);
        fake.ret(bytes4(keccak256("reader()")), abi.encode(uint256(1) << 160));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "reader()", address(fake)));
        projects.preflight(input, true, true);
        fake.ret(bytes4(keccak256("reader()")), new bytes(31));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "reader()", address(fake)));
        projects.preflight(input, true, true);
        fake.ret(bytes4(keccak256("reader()")), abi.encode(presentation.reader()));
        fake.ret(bytes4(keccak256("defaultChainBase()")), abi.encode(uint256(64), uint256(0)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "defaultChainBase()", address(fake))
        );
        projects.preflight(input, true, true);
        fake.ret(bytes4(keccak256("defaultChainBase()")), abi.encodePacked(uint256(32), uint256(129), new bytes(129)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "defaultChainBase()", address(fake))
        );
        projects.preflight(input, true, true);
    }

    function test_localDeployIsIdempotentAndStoresItsExactDependencies() public {
        vm.chainId(31337);
        address reader = presentation.reader();
        address resolver = presentation.ipfsResolver();
        address at = script.runWith(reader, resolver, GATEWAY);
        assertEq(at, script.predict(reader, resolver, GATEWAY));
        assertEq(address(ProjectPresentation(at).reader()), reader);
        assertEq(address(ProjectPresentation(at).ipfsResolver()), resolver);
        assertEq(ProjectPresentation(at).fileStore(), input.fileStore);
        assertEq(ProjectPresentation(at).directoryStore(), input.directoryStore);
        assertEq(script.runWith(reader, resolver, GATEWAY), at);
    }

    function test_offLocalPinsCannotBeBypassedByOtherCodedDependencies() public {
        vm.chainId(8453);
        address reader = presentation.reader();
        address resolver = presentation.ipfsResolver();
        address at = script.predict(reader, resolver, GATEWAY);
        address pin = script.pinned();
        vm.expectRevert(abi.encodeWithSelector(DeployPresentation.UnexpectedAddress.selector, at, pin));
        script.runWith(reader, resolver, GATEWAY);
        assertEq(at.code.length, 0);
    }

    function test_pinnedBuildCanDeployOffLocalWithMatchingDependencies() public {
        DeployProjects.Inputs memory expected = projects.expected();
        vm.etch(expected.fileStore, address(new DWFileStore()).code);
        vm.etch(expected.directoryStore, address(new DWDirectoryStore()).code);
        bytes memory dependency =
            address(new DWPresentationDependency(expected.directoryStore, expected.fileStore)).code;
        vm.etch(READER, dependency);
        vm.etch(RESOLVER, dependency);
        vm.chainId(8453);
        address at = script.runWith(READER, RESOLVER, GATEWAY);
        assertEq(at, script.pinned());
        projects.probePresentation(at, expected.directoryStore, expected.fileStore, GATEWAY);
    }
}
