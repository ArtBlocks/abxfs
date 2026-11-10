// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployProjects} from "../script/Deploy.s.sol";
import {OrgComponents} from "../script/OrgComponents.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";

import {MockStore} from "./mocks/Mocks.sol";
import {RawStub} from "./mocks/Hostile.sol";
import {DWAbxFactory, DWRenderer, DWSeed, DWDirectoryStore, DWFileStore, DWPresentation} from "./DeployWrong.t.sol";

/// @dev The script's internals, made callable.
contract DeployHarness is DeployProjects {
    function env(string memory name) external view returns (address) {
        return _env(name);
    }

    function verify(
        OrgFactory f,
        address abx,
        address renderer,
        address seed,
        address directoryStore,
        address fileStore,
        string memory gatewayBase
    ) external view {
        _verify(f, abx, renderer, seed, directoryStore, fileStore, gatewayBase);
    }

    function listed(uint256 chainId) external pure returns (bool) {
        return _isListedChain(chainId);
    }

    function gatewayAllowed(uint256 chainId, string memory base) external pure returns (bool) {
        return _gatewayAllowed(chainId, base);
    }
}

/// @dev The script with its pins replaced by this build's own prediction for the table. The real pins hold only for the
///      optimized build (`test/DeployFactoryPin.t.sol`); this lets the listed-chain path run under any build.
contract DeployBuildPinnedHarness is DeployHarness {
    function pinned() public view override returns (Addresses memory) {
        return predict(expected());
    }
}

/// @dev The script with one pinned address wrong: the build under test is not the pinned one.
contract DeployMispinnedHarness is DeployHarness {
    uint256 internal immutable _which;

    constructor(uint256 which) {
        _which = which;
    }

    function pinned() public view override returns (Addresses memory a) {
        a = predict(expected());
        address wrong = address(0xBAD);
        if (_which == 0) a.orgMeta = wrong;
        else if (_which == 1) a.factory = wrong;
        else if (_which == 2) a.hook = wrong;
        else if (_which == 3) a.enumeration = wrong;
        else if (_which == 4) a.minter = wrong;
        else if (_which == 5) a.card = wrong;
        else if (_which == 6) a.traits = wrong;
        else a.lens = wrong;
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The probes: every dependency must answer as what it is claimed to be
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/// @dev Each probe is a raw `staticcall` with a decoded result: one 32-byte word or it did not answer. The rig is five
///      scripted callees that pass every probe; each test breaks exactly one answer, in every way it can be wrong, and
///      asserts the named `ProbeFailed` that results.
contract DeployScriptProbesTest is Test {
    bytes4 internal constant PREDICT = bytes4(keccak256("predictDeterministicAddress(bytes32)"));
    bytes4 internal constant IMPL = bytes4(keccak256("implementation()"));
    bytes4 internal constant IS_CLONE = bytes4(keccak256("isAbxClone(address)"));
    bytes4 internal constant SPEC = bytes4(keccak256("specVersion()"));
    bytes4 internal constant SEED = bytes4(keccak256("seed(uint256,address)"));
    bytes4 internal constant DIR_EXISTS = bytes4(keccak256("directoryExists(bytes32)"));
    bytes4 internal constant FILE_EXISTS = bytes4(keccak256("fileExists(bytes32)"));

    DeployProjects internal d;
    RawStub internal abx;
    RawStub internal renderer;
    RawStub internal seed;
    RawStub internal dir;
    RawStub internal files;
    DWPresentation internal presentation;

    function setUp() public {
        d = new DeployProjects();
        abx = new RawStub();
        renderer = new RawStub();
        seed = new RawStub();
        dir = new RawStub();
        files = new RawStub();
        abx.ret(PREDICT, abi.encode(address(0x1234)));
        abx.ret(IMPL, abi.encode(address(this))); // an address with code
        abx.ret(IS_CLONE, abi.encode(false));
        renderer.ret(SPEC, abi.encode(uint256(12)));
        seed.ret(SEED, abi.encode(bytes32(uint256(7))));
        dir.ret(DIR_EXISTS, abi.encode(false));
        files.ret(FILE_EXISTS, abi.encode(false));
        presentation = new DWPresentation(address(dir), address(files), "https://fs.abx.io");
        vm.chainId(999);
    }

    function _in() internal view returns (DeployProjects.Inputs memory) {
        return DeployProjects.Inputs(address(abx), address(renderer), address(seed), address(dir), address(files), address(presentation), "https://fs.abx.io");
    }

    function _run() internal view {
        d.preflight(_in(), true, true);
    }

    function _fails(string memory what, address at) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, what, at));
        _run();
    }

    function test_theRigPasses() public view {
        _run();
    }

    /// @dev The probes' own arguments are part of what they check (`seed` must not revert for THIS input, and so on): pin
    ///      each call, once.
    function test_theProbesAskExactlyThese() public {
        vm.expectCall(address(abx), abi.encodeWithSelector(PREDICT, bytes32(uint256(1))), 1);
        vm.expectCall(address(abx), abi.encodeWithSelector(IMPL), 1);
        vm.expectCall(address(abx), abi.encodeWithSelector(IS_CLONE, address(0xdead)), 1);
        vm.expectCall(address(renderer), abi.encodeWithSelector(SPEC), 1);
        vm.expectCall(address(seed), abi.encodeWithSelector(SEED, uint256(1), address(0xdead)), 1);
        vm.expectCall(address(dir), abi.encodeWithSelector(DIR_EXISTS, bytes32(0)), 1);
        vm.expectCall(address(dir), abi.encodeWithSelector(FILE_EXISTS, bytes32(0)), 1);
        vm.expectCall(address(files), abi.encodeWithSelector(FILE_EXISTS, bytes32(0)), 1);
        vm.expectCall(address(files), abi.encodeWithSelector(DIR_EXISTS, bytes32(0)), 1);
        _run();
    }

    // ─── ABX factory ─────────────────────────────────────────────────────────

    function test_predictDeterministicAddress_mustAnswerANonzeroAddressWord() public {
        string memory what = "ABX_SERIES_CODE_FACTORY.predictDeterministicAddress";
        abx.ret(PREDICT, abi.encode(uint256(0)));
        _fails(what, address(abx));
        abx.ret(PREDICT, abi.encode(uint256(1) << 160)); // the lowest value that is not an address
        _fails(what, address(abx));
        abx.ret(PREDICT, abi.encode(type(uint256).max));
        _fails(what, address(abx));
        abx.ret(PREDICT, "");
        _fails(what, address(abx));
        abx.ret(PREDICT, new bytes(31));
        _fails(what, address(abx));
        abx.ret(PREDICT, abi.encode(address(0x1234), uint256(1))); // two words: not "one word"
        _fails(what, address(abx));
        abx.boom(PREDICT);
        _fails(what, address(abx));
        // The edges that pass: 1 and the largest address.
        abx.ret(PREDICT, abi.encode(uint256(1)));
        _run();
        abx.ret(PREDICT, abi.encode((uint256(1) << 160) - 1));
        _run();
    }

    function test_implementation_mustBeANonzeroAddressWithCode() public {
        string memory what = "ABX_SERIES_CODE_FACTORY.implementation";
        abx.ret(IMPL, abi.encode(uint256(0)));
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode(uint256(1) << 160));
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode(address(0xDEAD))); // no code
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode(address(1))); // a precompile: an address, nonzero, and no code
        _fails(what, address(abx));
        abx.ret(IMPL, "");
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode(address(this), uint256(1)));
        _fails(what, address(abx));
        abx.boom(IMPL);
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode(address(abx)));
        _run(); // any address with code, including itself
    }

    /// @dev "An address" is the low 160 bits and nothing above: a word with a bit above them is not one, even if its low
    ///      160 bits name a contract; and an address with its top bit set is as good as any.
    function test_implementation_theWordMustBeExactlyAnAddress() public {
        string memory what = "ABX_SERIES_CODE_FACTORY.implementation";
        abx.ret(IMPL, abi.encode((uint256(1) << 160) | uint256(uint160(address(this)))));
        _fails(what, address(abx));
        abx.ret(IMPL, abi.encode((uint256(1) << 255) | uint256(uint160(address(this)))));
        _fails(what, address(abx));
        address high = address(0x8000000000000000000000000000000000000001); // bit 159 set
        vm.etch(high, address(this).code);
        abx.ret(IMPL, abi.encode(high));
        _run();
        address top = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
        vm.etch(top, address(this).code);
        abx.ret(IMPL, abi.encode(top));
        _run();
    }

    /// @dev The same for the predicted address: any nonzero word that is an address, none that is not.
    function test_predictDeterministicAddress_theWordMustBeExactlyAnAddress() public {
        string memory what = "ABX_SERIES_CODE_FACTORY.predictDeterministicAddress";
        abx.ret(PREDICT, abi.encode((uint256(1) << 160) | uint256(1)));
        _fails(what, address(abx));
        abx.ret(PREDICT, abi.encode(uint256(1) << 255));
        _fails(what, address(abx));
        abx.ret(PREDICT, abi.encode(address(0x8000000000000000000000000000000000000001)));
        _run();
    }

    function test_isAbxClone_mustAnswerFalseForAnAddressThatIsNotAClone() public {
        string memory what = "ABX_SERIES_CODE_FACTORY.isAbxClone";
        abx.ret(IS_CLONE, abi.encode(true));
        _fails(what, address(abx));
        abx.ret(IS_CLONE, abi.encode(uint256(2)));
        _fails(what, address(abx));
        abx.ret(IS_CLONE, abi.encode(type(uint256).max));
        _fails(what, address(abx));
        abx.ret(IS_CLONE, "");
        _fails(what, address(abx));
        abx.ret(IS_CLONE, abi.encode(false, false));
        _fails(what, address(abx));
        abx.boom(IS_CLONE);
        _fails(what, address(abx));
    }

    // ─── Renderer and seed ───────────────────────────────────────────────────

    function test_specVersion_mustBeANonzeroWord() public {
        string memory what = "ABX_METADATA_RENDERER.specVersion";
        renderer.ret(SPEC, abi.encode(uint256(0)));
        _fails(what, address(renderer));
        renderer.ret(SPEC, "");
        _fails(what, address(renderer));
        renderer.ret(SPEC, abi.encode(uint256(1), uint256(1)));
        _fails(what, address(renderer));
        renderer.boom(SPEC);
        _fails(what, address(renderer));
        renderer.ret(SPEC, abi.encode(uint256(1)));
        _run();
        renderer.ret(SPEC, abi.encode(type(uint256).max));
        _run();
    }

    function test_seed_mustAnswerOneWordButAnyWord() public {
        string memory what = "ABX_SEED_SOURCE.seed";
        seed.ret(SEED, "");
        _fails(what, address(seed));
        seed.ret(SEED, new bytes(31));
        _fails(what, address(seed));
        seed.ret(SEED, new bytes(64));
        _fails(what, address(seed));
        seed.boom(SEED);
        _fails(what, address(seed));
        seed.ret(SEED, abi.encode(bytes32(0)));
        _run(); // zero is a word like any other
    }

    // ─── The stores ──────────────────────────────────────────────────────────

    function test_theDirectoryStore_mustAnswerFalseForTheZeroRoot() public {
        string memory what = "ABXFS_DIRECTORY_STORE.directoryExists(0)";
        dir.ret(DIR_EXISTS, abi.encode(true));
        _fails(what, address(dir));
        dir.ret(DIR_EXISTS, abi.encode(uint256(2)));
        _fails(what, address(dir));
        dir.ret(DIR_EXISTS, "");
        _fails(what, address(dir));
        dir.ret(DIR_EXISTS, new bytes(64));
        _fails(what, address(dir));
        dir.boom(DIR_EXISTS);
        _fails(what, address(dir));
    }

    function test_theFileStore_mustAnswerFalseForTheZeroRoot() public {
        string memory what = "ABXFS_FILE_STORE.fileExists(0)";
        files.ret(FILE_EXISTS, abi.encode(true));
        _fails(what, address(files));
        files.ret(FILE_EXISTS, abi.encode(uint256(2)));
        _fails(what, address(files));
        files.ret(FILE_EXISTS, "");
        _fails(what, address(files));
        files.ret(FILE_EXISTS, new bytes(33));
        _fails(what, address(files));
        files.boom(FILE_EXISTS);
        _fails(what, address(files));
    }

    /// @dev A swapped pair is caught because each store must NOT answer the other's predicate. Any one-word answer to
    ///      the other predicate (true, false or garbage) counts as answering; no answer of any other shape does.
    function test_aStoreThatAnswersTheOtherStoresPredicateIsRefused() public {
        string memory dirWhat = "ABXFS_DIRECTORY_STORE answers fileExists";
        string memory fileWhat = "ABXFS_FILE_STORE answers directoryExists";
        bytes[3] memory words = [abi.encode(false), abi.encode(true), abi.encode(uint256(99))];
        for (uint256 i; i < words.length; ++i) {
            dir.ret(FILE_EXISTS, words[i]);
            _fails(dirWhat, address(dir));
            dir.ret(FILE_EXISTS, "");
            files.ret(DIR_EXISTS, words[i]);
            _fails(fileWhat, address(files));
            files.ret(DIR_EXISTS, "");
        }
        // Not answering takes many forms; none of them is a one-word answer.
        dir.boom(FILE_EXISTS);
        files.boom(DIR_EXISTS);
        _run();
        dir.ret(FILE_EXISTS, new bytes(31));
        files.ret(DIR_EXISTS, new bytes(64));
        _run();
    }

    /// @dev One address for both stores answers both predicates, so the cross-answer check refuses it. (A separate
    ///      same-address check used to follow; only a callee answering two identical staticcalls differently could
    ///      reach it, and on a listed chain the table names both stores anyway, so it was removed.)
    function test_theSameAddressForBothStoresIsRefused() public {
        DeployProjects.Inputs memory i = _in();
        RawStub both = new RawStub();
        both.ret(DIR_EXISTS, abi.encode(false));
        both.ret(FILE_EXISTS, abi.encode(false));
        i.directoryStore = address(both);
        i.fileStore = address(both);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, "ABXFS_DIRECTORY_STORE answers fileExists", address(both)));
        d.preflight(i, true, true);
    }

    // ─── Missing and codeless addresses, in the order they are checked ──────

    function test_everyDependencyMustBeNonzeroAndHaveCode() public {
        string[5] memory names =
            ["ABX_SERIES_CODE_FACTORY", "ABX_METADATA_RENDERER", "ABX_SEED_SOURCE", "ABXFS_DIRECTORY_STORE", "ABXFS_FILE_STORE"];
        for (uint256 k; k < 5; ++k) {
            DeployProjects.Inputs memory i = _in();
            address[5] memory a = [i.abx, i.renderer, i.seed, i.directoryStore, i.fileStore];
            a[k] = address(0);
            i = DeployProjects.Inputs(a[0], a[1], a[2], a[3], a[4], i.presentation, i.gatewayBase);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.MissingAddress.selector, names[k]));
            d.preflight(i, true, true);

            a[k] = address(0xC0DE);
            i = DeployProjects.Inputs(a[0], a[1], a[2], a[3], a[4], i.presentation, i.gatewayBase);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, names[k], address(0xC0DE)));
            d.preflight(i, true, true);
        }
        // The first one missing is the one named, whatever follows.
        DeployProjects.Inputs memory all = DeployProjects.Inputs(address(0), address(0), address(0), address(0), address(0), address(0), "x");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.MissingAddress.selector, "ABX_SERIES_CODE_FACTORY"));
        d.preflight(all, true, true);
    }

    /// @dev Presence is checked for all five before any probe runs.
    function test_codeIsCheckedBeforeTheProbes() public {
        DeployProjects.Inputs memory i = _in();
        i.abx = address(dir); // answers nothing the ABX factory should: a probe failure...
        i.fileStore = address(0xC0DE); // ...but a missing store is reported first
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, "ABXFS_FILE_STORE", address(0xC0DE)));
        d.preflight(i, true, true);
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The allow-table and the gateway
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptTableTest is Test {
    DeployHarness internal d;
    DeployProjects.Inputs internal e;

    function setUp() public {
        d = new DeployHarness();
        e = d.expected();
        // The table's addresses answer as what they are: put stand-ins at them.
        vm.etch(e.abx, address(new DWAbxFactory()).code);
        vm.etch(e.renderer, address(new DWRenderer()).code);
        DWPresentation presentation = new DWPresentation(e.directoryStore, e.fileStore, e.gatewayBase);
        vm.etch(e.presentation, address(presentation).code);
        DWPresentation(e.presentation).setDependencies(presentation.reader(), presentation.ipfsResolver());
        vm.etch(e.seed, address(new DWSeed()).code);
        vm.etch(e.directoryStore, address(new DWDirectoryStore()).code);
        vm.etch(e.fileStore, address(new DWFileStore()).code);
    }

    function _table() internal view returns (DeployProjects.Inputs memory) {
        return e;
    }

    /// @dev Independent of the content layer's build (`test_storeAllowTableIsTheContentLayersPrediction` compares the
    ///      stores against it): the whole table as literals.
    function test_theTableIsExactlyThese() public view {
        assertEq(e.abx, 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616);
        assertEq(e.renderer, 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27);
        assertEq(e.seed, 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A);
        assertEq(e.directoryStore, 0x4273E4E078F47303Ca15b11959eeb61F3FC94c11);
        assertEq(e.fileStore, 0x8b6077a1d6953D96687005B9408D56A655b4d155);
        assertEq(e.gatewayBase, "https://fs.abx.io");
    }

    function test_theEightListedChainsAndNoOthers() public view {
        uint256[8] memory yes = [uint256(8453), 84532, 1, 11155111, 42161, 421614, 4663, 46630];
        for (uint256 i; i < yes.length; ++i) {
            assertTrue(d.listed(yes[i]), "listed");
        }
        uint256[10] memory no = [uint256(0), 2, 10, 137, 999, 31337, 8454, 84533, 11155112, 421615];
        for (uint256 i; i < no.length; ++i) {
            assertFalse(d.listed(no[i]), "not listed");
        }
    }

    function test_everyListedChainAcceptsTheTableWithNoOverrides() public {
        uint256[8] memory ids = [uint256(8453), 84532, 1, 11155111, 42161, 421614, 4663, 46630];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            d.preflight(_table(), false, false);
        }
    }

    function test_anUnlistedChainNeedsTheOverrideAndNamesItself() public {
        uint256[5] memory ids = [uint256(2), 10, 137, 999, 421615];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, ids[i]));
            d.preflight(_table(), false, false);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedChain.selector, ids[i]));
            d.preflight(_table(), false, true); // the gateway override does not excuse the chain
            // With the chain override the table is not consulted and the (empty) gateway list needs its own override.
            d.preflight(_table(), true, true);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, "https://fs.abx.io"));
            d.preflight(_table(), true, false);
        }
    }

    /// @dev Each of the five addresses, alone, wrong while well-behaved: named, with what was given and what was expected.
    function test_eachAddressIsComparedWithTheTableAndNamed() public {
        vm.chainId(84532);
        string[5] memory names =
            ["ABX_SERIES_CODE_FACTORY", "ABX_METADATA_RENDERER", "ABX_SEED_SOURCE", "ABXFS_DIRECTORY_STORE", "ABXFS_FILE_STORE"];
        address[5] memory alt =
            [address(new DWAbxFactory()), address(new DWRenderer()), address(new DWSeed()), address(new DWDirectoryStore()), address(new DWFileStore())];
        address[5] memory want = [e.abx, e.renderer, e.seed, e.directoryStore, e.fileStore];
        for (uint256 k; k < 5; ++k) {
            address[5] memory a = [want[0], want[1], want[2], want[3], want[4]]; // a copy: memory arrays alias
            a[k] = alt[k];
            DeployProjects.Inputs memory i = DeployProjects.Inputs(a[0], a[1], a[2], a[3], a[4], address(new DWPresentation(a[3], a[4], e.gatewayBase)), e.gatewayBase);
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnexpectedAddress.selector, names[k], alt[k], want[k]));
            d.preflight(i, false, false);
            // The chain override is the only way past it.
            d.preflight(i, true, false);
        }
        // Several wrong at once: the first in order is the one reported.
        DeployProjects.Inputs memory many =
            DeployProjects.Inputs(alt[0], alt[1], alt[2], alt[3], alt[4], address(new DWPresentation(alt[3], alt[4], e.gatewayBase)), e.gatewayBase);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnexpectedAddress.selector, names[0], alt[0], want[0]));
        d.preflight(many, false, false);
    }

    /// @dev On a listed chain the gateway must equal the table's, byte for byte; an unlisted chain has no list.
    function test_theGatewayListIsPerChainAndExact() public view {
        uint256[8] memory ids = [uint256(8453), 84532, 1, 11155111, 42161, 421614, 4663, 46630];
        string[6] memory bad = [
            "https://fs.abx.io/",
            "https://fs.abx.io.x",
            "http://fs.abx.io",
            "https://FS.abx.io",
            "https://fs.abx.i",
            ""
        ];
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(d.gatewayAllowed(ids[i], "https://fs.abx.io"));
            for (uint256 k; k < bad.length; ++k) {
                assertFalse(d.gatewayAllowed(ids[i], bad[k]));
            }
        }
        assertFalse(d.gatewayAllowed(999, "https://fs.abx.io"), "an unlisted chain has no list");
        assertFalse(d.gatewayAllowed(0, "https://fs.abx.io"));
    }

    function test_theTwoOverridesAreIndependent() public {
        vm.chainId(84532);
        DeployProjects.Inputs memory odd = _table();
        odd.gatewayBase = "https://gateway.example";
        DWPresentation(odd.presentation).setBase(odd.gatewayBase);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, "https://gateway.example"));
        d.preflight(odd, false, false);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnlistedGateway.selector, "https://gateway.example"));
        d.preflight(odd, true, false); // the chain override does not excuse the gateway
        d.preflight(odd, false, true); // the gateway override alone passes the gate (a run then stops, below)
        d.preflight(odd, true, true);
        // The gateway override never excuses a malformed base.
        odd.gatewayBase = "https://gateway.example/";
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.BadGatewayBase.selector, "trailing slash"));
        d.preflight(odd, true, true);
    }

    /// @dev `runWith` on a listed chain, end to end, against the table's own addresses and no overrides: everything
    ///      lands at its CREATE2 prediction (here the pins, by construction of the harness) and the result reads back.
    function test_runWithOnAListedChainNeedsNoOverrides() public {
        DeployBuildPinnedHarness p = new DeployBuildPinnedHarness();
        vm.chainId(84532);
        DeployProjects.Addresses memory want = p.predict(_table());
        (address factory, address lens) = p.runWith(_table(), false, false);
        assertEq(factory, want.factory);
        assertEq(lens, want.lens);
        assertEq(address(OrgFactory(factory).abx()), e.abx);
        assertEq(address(Lens(lens).factory()), factory);
        assertTrue(OrgFactory(factory).componentsDeployed());
        OrgFactory f = OrgFactory(factory);
        assertEq(f.orgMeta(), want.orgMeta);
        assertEq(address(f.hook()), want.hook);
        assertEq(address(f.enumeration()), want.enumeration);
        assertEq(address(f.minter()), want.minter);
        assertEq(address(f.card()), want.card);
        assertEq(address(f.traits()), want.traits);
        // A second run finds everything in place and returns the same addresses.
        (address factory2, address lens2) = p.runWith(_table(), false, false);
        assertEq(factory2, factory);
        assertEq(lens2, lens);
    }

    /// @dev A new gateway base on a listed chain moves `OrgMeta` and every address after it, so the gateway override
    ///      alone can never complete a run there: it is refused by name before anything is deployed.
    function test_aNewGatewayOnAListedChainIsANewBuildNotAnOverride() public {
        DeployBuildPinnedHarness p = new DeployBuildPinnedHarness();
        vm.chainId(84532);
        DeployProjects.Inputs memory odd = _table();
        odd.gatewayBase = "https://gateway.example";
        DWPresentation(odd.presentation).setBase(odd.gatewayBase);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.GatewayMovesThePins.selector, "https://gateway.example"));
        p.runWith(odd, false, true);
        assertEq(p.predict(odd).orgMeta.code.length, 0, "nothing was deployed");
        // The chain override is still the escape hatch: with both flags the new base deploys, unpinned.
        (address factory,) = p.runWith(odd, true, true);
        assertEq(factory, p.predict(odd).factory, "the override deploys the new build");
    }

    /// @dev On a listed chain nothing is broadcast unless EVERY address the run would deploy to is pinned: a build that
    ///      moved any one of them is refused, by name, before the first transaction.
    function test_runWithOnAListedChainRefusesAnUnpinnedBuild() public {
        string[8] memory names =
            ["OrgMeta", "OrgFactory", "ProjectHook", "ProjectEnumeration", "OrgMinter", "ProjectCard", "ProjectTraits", "Lens"];
        vm.chainId(84532);
        for (uint256 k; k < 8; ++k) {
            DeployMispinnedHarness m = new DeployMispinnedHarness(k);
            DeployProjects.Addresses memory got = m.predict(_table());
            address[8] memory gotAt =
                [got.orgMeta, got.factory, got.hook, got.enumeration, got.minter, got.card, got.traits, got.lens];
            vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnexpectedAddress.selector, names[k], gotAt[k], address(0xBAD)));
            m.runWith(_table(), false, false);
            assertEq(got.orgMeta.code.length, 0, "nothing was deployed");
        }
    }

    /// @dev The chain override is the one escape hatch, and it covers the pins too; an unlisted chain is not pinned.
    function test_theChainOverrideBypassesThePins() public {
        DeployMispinnedHarness m = new DeployMispinnedHarness(1);
        vm.chainId(84532);
        (address factory,) = m.runWith(_table(), true, false);
        assertEq(factory, m.predict(_table()).factory);
        vm.chainId(999);
        DeployMispinnedHarness m2 = new DeployMispinnedHarness(7);
        (address factory2,) = m2.runWith(_table(), true, true);
        assertEq(factory2, factory, "the same inputs predict the same addresses on any chain");
    }

    /// @dev `requirePinned` against the script's own `pinned()`, and `predict` is a function of the inputs alone.
    function test_requirePinnedComparesEveryAddress() public {
        DeployBuildPinnedHarness p = new DeployBuildPinnedHarness();
        DeployProjects.Addresses memory a = p.predict(_table());
        p.requirePinned(a);
        a.traits = address(1);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.UnexpectedAddress.selector, "ProjectTraits", address(1), p.pinned().traits));
        p.requirePinned(a);
        DeployProjects.Inputs memory other = _table();
        other.gatewayBase = "https://other.example";
        assertTrue(p.predict(other).orgMeta != p.predict(_table()).orgMeta, "the gateway base is OrgMeta's argument");
        assertTrue(p.predict(other).factory != p.predict(_table()).factory, "and OrgMeta the factory's");
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The gateway base format
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptGatewayBaseTest is Test {
    DeployProjects internal d;

    function setUp() public {
        d = new DeployProjects();
    }

    function _bad(string memory base, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.BadGatewayBase.selector, reason));
        d.validateGatewayBase(base);
    }

    function _filled(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        bytes memory p = "https://";
        for (uint256 i; i < n; ++i) {
            b[i] = i < 8 ? p[i] : bytes1("a");
        }
        return string(b);
    }

    function test_eachRuleNamesItsReason() public {
        _bad(_filled(129), "longer than 128 bytes");
        _bad("", "must be https:// followed by a host");
        _bad("https://", "must be https:// followed by a host");
        _bad("https:/a", "must be https:// followed by a host"); // 8 bytes
        _bad("http://abc", "must start with https://");
        _bad("HTTPS://abc", "must start with https://");
        _bad("https:/xabc", "must start with https://");
        _bad("hxtps://abc", "must start with https://");
        _bad("https:///abc", "empty host");
        _bad("https://a/", "trailing slash");
        _bad("https://a.example/path/", "trailing slash");
        _bad("https://a b", "whitespace, control or non-ASCII byte");
        _bad("https://a.example/\x01", "whitespace, control or non-ASCII byte");
        _bad("https://a.example/\x7f", "whitespace, control or non-ASCII byte");
        _bad(unicode"https://é.example", "whitespace, control or non-ASCII byte");
        _bad('https://a"b', "character that breaks JSON or markup");
        _bad("https://a&b", "character that breaks JSON or markup");
        _bad("https://a'b", "character that breaks JSON or markup");
        _bad("https://a<b", "character that breaks JSON or markup");
        _bad("https://a>b", "character that breaks JSON or markup");
        _bad("https://a\\b", "character that breaks JSON or markup");
        _bad("https://a`b", "character that breaks JSON or markup");
        // More than one thing wrong: the first rule in the list is the one reported.
        _bad(string.concat(_filled(129), "/"), "longer than 128 bytes");
        _bad("http://a b/", "must start with https://");
        _bad("https:///a b", "empty host");
    }

    function test_theLengthBoundaries() public view {
        d.validateGatewayBase("https://a"); // 9: the shortest
        d.validateGatewayBase(_filled(128)); // 128: the longest
    }

    /// @dev Every byte value in the middle of an otherwise good base: allowed iff 0x21..0x7e and none of the seven.
    function test_everyByteValue() public {
        for (uint256 c; c < 256; ++c) {
            string memory base = string(abi.encodePacked("https://a", bytes1(uint8(c)), "b"));
            bool unsafe = c == 0x22 || c == 0x26 || c == 0x27 || c == 0x28 || c == 0x29 || c == 0x3c || c == 0x3e
                || c == 0x5b || c == 0x5c || c == 0x5d || c == 0x5e || c == 0x60 || c == 0x7b || c == 0x7c || c == 0x7d;
            if (c <= 0x20 || c >= 0x7f) {
                _bad(base, "whitespace, control or non-ASCII byte");
            } else if (unsafe) {
                _bad(base, "character that breaks JSON or markup");
            } else {
                d.validateGatewayBase(base);
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// OrgMeta, probed before the factory freezes it into every org
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptOrgMetaProbeTest is Test {
    bytes4 internal constant GATEWAY_BASE = bytes4(keccak256("gatewayBase()"));
    bytes4 internal constant LINKS = bytes4(keccak256("links()"));
    bytes4 internal constant CONTRACT_URI = bytes4(keccak256("contractURI(address)"));
    bytes4 internal constant RENDER = bytes4(keccak256("render(address,uint256,bytes32)"));
    string internal constant BASE = "https://fs.abx.io";
    string internal constant PREFIX = "data:application/json;base64,";

    DeployProjects internal d;
    RawStub internal meta;
    RawStub internal links;

    function setUp() public {
        d = new DeployProjects();
        meta = new RawStub();
        links = new RawStub();
        meta.ret(GATEWAY_BASE, abi.encode(BASE));
        meta.ret(LINKS, abi.encode(address(links)));
        meta.ret(CONTRACT_URI, abi.encode(string.concat(PREFIX, "e30=")));
        meta.ret(RENDER, abi.encode("text/plain", bytes("Untitled org #0")));
        links.ret(GATEWAY_BASE, abi.encode(BASE));
    }

    function _fails(string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.ProbeFailed.selector, what, address(meta)));
        d.probeOrgMeta(address(meta), BASE);
    }

    function _wiring(string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, what));
        d.probeOrgMeta(address(meta), BASE);
    }

    function test_aWellBehavedMetaPasses() public view {
        d.probeOrgMeta(address(meta), BASE);
    }

    /// @dev The two probe calls, with the inputs that make the answer a known one: a token that is nothing.
    function test_theProbesAskExactlyThese() public {
        vm.expectCall(address(meta), abi.encodeWithSelector(CONTRACT_URI, address(0xdead)), 1);
        vm.expectCall(address(meta), abi.encodeWithSelector(RENDER, address(0xdead), uint256(0), bytes32("name")), 1);
        d.probeOrgMeta(address(meta), BASE);
    }

    /// @dev A collection document answer that is too short to be a string is a probe failure, named; not a revert from
    ///      decoding it. 63 bytes: an offset, then a length word one byte short.
    function test_aTooShortDocumentAnswerIsAProbeFailureNotADecodeRevert() public {
        meta.ret(CONTRACT_URI, abi.encodePacked(uint256(0x20), new bytes(31)));
        _fails("OrgMeta.contractURI");
        meta.ret(CONTRACT_URI, abi.encodePacked(uint256(0x20), _filled31()));
        _fails("OrgMeta.contractURI");
    }

    function _filled31() internal pure returns (bytes memory b) {
        b = new bytes(31);
        for (uint256 i; i < 31; ++i) {
            b[i] = 0xff;
        }
    }

    /// @dev A name answer decodes only from 128 bytes (two heads and two lengths). 127 bytes that WOULD decode, with both
    ///      offsets at one string, are still refused as too short; one more byte and they pass.
    function test_theNameAnswerNeedsAtLeast128Bytes() public {
        bytes memory name = bytes("Untitled org #0"); // 15 bytes
        bytes memory b127 = abi.encodePacked(uint256(0x40), uint256(0x40), uint256(15), name, new bytes(16));
        assertEq(b127.length, 127);
        meta.ret(RENDER, b127);
        _fails("OrgMeta.render");
        bytes memory b128 = abi.encodePacked(b127, hex"00");
        meta.ret(RENDER, b128);
        d.probeOrgMeta(address(meta), BASE);
    }

    function test_noCodeIsNamed() public {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, "OrgMeta", address(0xDEAD)));
        d.probeOrgMeta(address(0xDEAD), BASE);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.NoCode.selector, "OrgMeta", address(0)));
        d.probeOrgMeta(address(0), BASE);
    }

    function test_theBaseItWasBuiltWithMustMatch() public {
        meta.ret(GATEWAY_BASE, abi.encode("https://fs.abx.io/"));
        _wiring("orgMeta.gatewayBase");
        meta.ret(GATEWAY_BASE, abi.encode(""));
        _wiring("orgMeta.gatewayBase");
    }

    function test_theLinksRendererMustHaveCodeAndTheSameBase() public {
        meta.ret(LINKS, abi.encode(address(0xDEAD)));
        _wiring("orgMeta.links code");
        meta.ret(LINKS, abi.encode(address(0)));
        _wiring("orgMeta.links code");
        meta.ret(LINKS, abi.encode(address(links)));
        links.ret(GATEWAY_BASE, abi.encode("https://other.example"));
        _wiring("orgMeta.links.gatewayBase");
        links.ret(GATEWAY_BASE, abi.encode(""));
        _wiring("orgMeta.links.gatewayBase");
    }

    /// @dev The collection document must come back as a `data:application/json;base64,` URI with something after it.
    function test_theCollectionDocumentMustBeAJsonDataUri() public {
        string[6] memory bad = [
            "", // nothing
            "data:application/json;base64", // short of the prefix
            PREFIX, // exactly the prefix: nothing after it
            "data:application/json;base64;e30=", // the right length, one byte wrong
            "Data:application/json;base64,e30=", // the first byte wrong
            "xdata:application/json;base64,e30=" // shifted
        ];
        for (uint256 i; i < bad.length; ++i) {
            meta.ret(CONTRACT_URI, abi.encode(bad[i]));
            _fails("OrgMeta.contractURI");
        }
        // It did not answer at all, or not with a string.
        meta.boom(CONTRACT_URI);
        _fails("OrgMeta.contractURI");
        meta.ret(CONTRACT_URI, "");
        _fails("OrgMeta.contractURI");
        meta.ret(CONTRACT_URI, abi.encode(uint256(1))); // 32 bytes: short of a string head
        _fails("OrgMeta.contractURI");
        // One character after the prefix is enough.
        meta.ret(CONTRACT_URI, abi.encode(string.concat(PREFIX, "e")));
        d.probeOrgMeta(address(meta), BASE);
    }

    /// @dev The token-name renderer must answer the fallback for a token that is nothing.
    function test_theNameRendererMustAnswerTheFallback() public {
        meta.ret(RENDER, abi.encode("text/plain", bytes("Untitled org #1")));
        _fails("OrgMeta.render");
        meta.ret(RENDER, abi.encode("text/plain", bytes("")));
        _fails("OrgMeta.render");
        meta.ret(RENDER, abi.encode("text/plain", bytes("untitled org #0")));
        _fails("OrgMeta.render");
        meta.ret(RENDER, abi.encode("text/plain", bytes("Untitled org #0 ")));
        _fails("OrgMeta.render");
        meta.boom(RENDER);
        _fails("OrgMeta.render");
        meta.ret(RENDER, "");
        _fails("OrgMeta.render"); // an empty success: the name is empty
        meta.ret(RENDER, new bytes(127)); // one byte short of two heads and two lengths
        _fails("OrgMeta.render");
        // The content type is not inspected, only the name.
        meta.ret(RENDER, abi.encode("anything", bytes("Untitled org #0")));
        d.probeOrgMeta(address(meta), BASE);
    }

    function test_theRealOrgMetaPasses() public {
        OrgMeta real = new OrgMeta(BASE);
        d.probeOrgMeta(address(real), BASE);
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// _verify: the deployment read back
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptVerifyTest is Test {
    bytes4 internal constant ABX = bytes4(keccak256("abx()"));
    bytes4 internal constant RENDERER = bytes4(keccak256("metadataRenderer()"));
    bytes4 internal constant SEED = bytes4(keccak256("seedSource()"));
    bytes4 internal constant LINKS = bytes4(keccak256("links()"));
    bytes4 internal constant HOOK = bytes4(keccak256("hook()"));
    bytes4 internal constant ENUM = bytes4(keccak256("enumeration()"));
    bytes4 internal constant MINTER = bytes4(keccak256("minter()"));
    bytes4 internal constant CARD = bytes4(keccak256("card()"));
    bytes4 internal constant TRAITS = bytes4(keccak256("traits()"));
    bytes4 internal constant ORG_META = bytes4(keccak256("orgMeta()"));
    bytes4 internal constant COMPONENTS = bytes4(keccak256("componentsDeployed()"));
    bytes4 internal constant DIR_STORE = bytes4(keccak256("directoryStore()"));
    bytes4 internal constant FILE_STORE = bytes4(keccak256("fileStore()"));
    bytes4 internal constant FACTORY = bytes4(keccak256("factory()"));
    bytes4 internal constant GATEWAY_BASE = bytes4(keccak256("gatewayBase()"));
    string internal constant BASE = "https://fs.abx.io";

    DeployHarness internal d;

    // The expectations the script is handed.
    address internal abx = address(0xAB01);
    address internal renderer = address(0xAB02);
    address internal seed = address(0xAB03);
    address internal dirStore = address(0xAB04);
    address internal fileStore = address(0xAB05);

    // The factory under test and its parts, all scripted.
    RawStub internal f;
    RawStub internal hook;
    RawStub internal en;
    RawStub internal mi;
    RawStub internal ca;
    RawStub internal tr;
    RawStub internal li;
    RawStub internal me;

    function setUp() public {
        d = new DeployHarness();
        f = new RawStub();
        hook = new RawStub();
        en = new RawStub();
        mi = new RawStub();
        ca = new RawStub();
        tr = new RawStub();
        li = new RawStub();
        me = new RawStub();
        _wireAll();
    }

    function _wireAll() internal {
        _wireFactory(address(f), address(hook), address(en), address(mi), address(ca), address(tr), address(li), address(me));
        _wireParts(address(f), address(hook), address(en), address(mi), address(ca), address(tr));
    }

    function _wireFactory(
        address factory_,
        address hook_,
        address en_,
        address mi_,
        address ca_,
        address tr_,
        address li_,
        address me_
    ) internal {
        RawStub s = RawStub(factory_);
        s.ret(ABX, abi.encode(abx));
        s.ret(RENDERER, abi.encode(renderer));
        s.ret(SEED, abi.encode(seed));
        s.ret(LINKS, abi.encode(li_));
        s.ret(HOOK, abi.encode(hook_));
        s.ret(ENUM, abi.encode(en_));
        s.ret(MINTER, abi.encode(mi_));
        s.ret(CARD, abi.encode(ca_));
        s.ret(TRAITS, abi.encode(tr_));
        s.ret(ORG_META, abi.encode(me_));
        s.ret(COMPONENTS, abi.encode(true));
        if (li_.code.length != 0) RawStub(li_).ret(GATEWAY_BASE, abi.encode(BASE));
        if (me_.code.length != 0) RawStub(me_).ret(LINKS, abi.encode(li_));
    }

    /// @dev Components that exist as stubs answer consistently; a precompile in their place answers by itself.
    function _wireParts(address factory_, address hook_, address en_, address mi_, address ca_, address tr_) internal {
        if (hook_.code.length != 0) {
            RawStub(hook_).ret(DIR_STORE, abi.encode(dirStore));
            RawStub(hook_).ret(FILE_STORE, abi.encode(fileStore));
            RawStub(hook_).ret(FACTORY, abi.encode(factory_));
        }
        if (en_.code.length != 0) RawStub(en_).ret(FACTORY, abi.encode(factory_));
        if (mi_.code.length != 0) RawStub(mi_).ret(FACTORY, abi.encode(factory_));
        if (ca_.code.length != 0) RawStub(ca_).ret(HOOK, abi.encode(hook_));
        if (tr_.code.length != 0) RawStub(tr_).ret(HOOK, abi.encode(hook_));
    }

    function _verify() internal view {
        d.verify(OrgFactory(address(f)), abx, renderer, seed, dirStore, fileStore, BASE);
    }

    function _mismatch(string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, what));
        _verify();
    }

    function test_aConsistentDeploymentPasses() public view {
        _verify();
    }

    /// @dev The last read-back: a factory that says its components are not all deployed is refused, even when every
    ///      component it names has code (a real factory cannot say so then; a stand-in can, and is still refused).
    function test_aFactoryThatSaysItsComponentsAreMissingIsRefused() public {
        f.ret(COMPONENTS, abi.encode(false));
        _mismatch("componentsDeployed");
        f.ret(COMPONENTS, abi.encode(true));
        _verify();
    }

    /// @dev A real factory, real OrgMeta, real components: the script's own happy path.
    function test_aRealFactoryPassesAndEveryArgumentIsCompared() public {
        MockStore dirs = new MockStore();
        MockStore files = new MockStore();
        OrgMeta meta = new OrgMeta(BASE);
        OrgFactory real = OrgComponents.create(abx, renderer, seed, address(dirs), address(files), address(meta));
        d.verify(real, abx, renderer, seed, address(dirs), address(files), BASE);

        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "abx"));
        d.verify(real, address(0xBAD), renderer, seed, address(dirs), address(files), BASE);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "metadataRenderer"));
        d.verify(real, abx, address(0xBAD), seed, address(dirs), address(files), BASE);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "seedSource"));
        d.verify(real, abx, renderer, address(0xBAD), address(dirs), address(files), BASE);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "links.gatewayBase"));
        d.verify(real, abx, renderer, seed, address(dirs), address(files), "https://other.example");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "hook.directoryStore"));
        d.verify(real, abx, renderer, seed, address(0xBAD), address(files), BASE);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "hook.fileStore"));
        d.verify(real, abx, renderer, seed, address(dirs), address(0xBAD), BASE);
    }

    function test_theFactoryMustPointWhereItWasTold() public {
        f.ret(ABX, abi.encode(address(0xBAD)));
        _mismatch("abx");
        f.ret(ABX, abi.encode(abx));
        f.ret(RENDERER, abi.encode(address(0xBAD)));
        _mismatch("metadataRenderer");
        f.ret(RENDERER, abi.encode(renderer));
        f.ret(SEED, abi.encode(address(0xBAD)));
        _mismatch("seedSource");
        f.ret(SEED, abi.encode(seed));
        li.ret(GATEWAY_BASE, abi.encode("https://other.example"));
        _mismatch("links.gatewayBase");
        li.ret(GATEWAY_BASE, abi.encode(BASE));
        _verify();
    }

    function test_theHooksStoresAndFactoryMustMatch() public {
        hook.ret(DIR_STORE, abi.encode(address(0xBAD)));
        _mismatch("hook.directoryStore");
        hook.ret(DIR_STORE, abi.encode(dirStore));
        hook.ret(FILE_STORE, abi.encode(address(0xBAD)));
        _mismatch("hook.fileStore");
        hook.ret(FILE_STORE, abi.encode(fileStore));
        hook.ret(FACTORY, abi.encode(address(0xBAD)));
        _mismatch("hook.factory");
        hook.ret(FACTORY, abi.encode(address(f)));
        _verify();
    }

    function test_everyComponentMustNameTheFactoryOrTheHook() public {
        en.ret(FACTORY, abi.encode(address(0xBAD)));
        _mismatch("enumeration.factory");
        en.ret(FACTORY, abi.encode(address(f)));
        mi.ret(FACTORY, abi.encode(address(0xBAD)));
        _mismatch("minter.factory");
        mi.ret(FACTORY, abi.encode(address(f)));
        ca.ret(HOOK, abi.encode(address(0xBAD)));
        _mismatch("card.hook");
        ca.ret(HOOK, abi.encode(address(hook)));
        tr.ret(HOOK, abi.encode(address(0xBAD)));
        _mismatch("traits.hook");
        tr.ret(HOOK, abi.encode(address(hook)));
        _verify();
    }

    function test_theLinksRendererMustBeTheOneOrgMetaDeployed() public {
        RawStub other = new RawStub();
        other.ret(GATEWAY_BASE, abi.encode(BASE));
        me.ret(LINKS, abi.encode(address(other)));
        _mismatch("links != orgMeta.links");
        me.ret(LINKS, abi.encode(address(li)));
        _verify();
    }

    function test_theFactoryMustReportItsComponentsDeployed() public {
        f.ret(COMPONENTS, abi.encode(false));
        _mismatch("componentsDeployed");
        f.ret(COMPONENTS, abi.encode(true));
        _verify();
    }

    // ─── The "... code" checks ───────────────────────────────────────────────
    //
    // Each is shadowed by the typed call made to the same component just before it: a callee with no code returns
    // nothing, and decoding nothing reverts without a reason. A component can have no code and still answer only if it
    // is a precompile, and the RIPEMD-160 precompile (address 3) answers every call with a 32-byte word that decodes as
    // an address: `ripemd160(selector)`. Wiring a component to it, and choosing the factory (or the hook) to live at
    // the address it will report, reaches each check. That is the only way to, and it is how these are tested.

    address internal constant RIPEMD = address(3);

    function _ripemdOf(bytes4 sel) internal pure returns (address) {
        return address(ripemd160(abi.encodePacked(sel)));
    }

    /// @dev A scripted factory at `at` (which a precompile's answer will name).
    function _stubAt(address at) internal returns (RawStub s) {
        vm.etch(at, address(new RawStub()).code);
        s = RawStub(at);
    }

    function test_theEnumerationMustHaveCode() public {
        RawStub fac = _stubAt(_ripemdOf(FACTORY)); // what `enumeration.factory()` will report
        _wireFactory(address(fac), address(hook), RIPEMD, address(mi), address(ca), address(tr), address(li), address(me));
        _wireParts(address(fac), address(hook), RIPEMD, address(mi), address(ca), address(tr));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "enumeration code"));
        d.verify(OrgFactory(address(fac)), abx, renderer, seed, dirStore, fileStore, BASE);
    }

    function test_theMinterMustHaveCode() public {
        RawStub fac = _stubAt(_ripemdOf(FACTORY));
        _wireFactory(address(fac), address(hook), address(en), RIPEMD, address(ca), address(tr), address(li), address(me));
        _wireParts(address(fac), address(hook), address(en), RIPEMD, address(ca), address(tr));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "minter code"));
        d.verify(OrgFactory(address(fac)), abx, renderer, seed, dirStore, fileStore, BASE);
    }

    function test_theHookMustHaveCode() public {
        RawStub fac = _stubAt(_ripemdOf(FACTORY));
        // The hook answers its stores and factory as `ripemd160(selector)`: hand the script those as its expectations.
        address dirAsked = _ripemdOf(DIR_STORE);
        address fileAsked = _ripemdOf(FILE_STORE);
        _wireFactory(address(fac), RIPEMD, address(en), address(mi), address(ca), address(tr), address(li), address(me));
        _wireParts(address(fac), RIPEMD, address(en), address(mi), address(ca), address(tr));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "hook code"));
        d.verify(OrgFactory(address(fac)), abx, renderer, seed, dirAsked, fileAsked, BASE);
    }

    function test_theCardMustHaveCode() public {
        // The card reports `ripemd160(hook())` as its hook, so that is where the hook must be.
        RawStub hk = _stubAt(_ripemdOf(HOOK));
        _wireFactory(address(f), address(hk), address(en), address(mi), RIPEMD, address(tr), address(li), address(me));
        _wireParts(address(f), address(hk), address(en), address(mi), RIPEMD, address(tr));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "card code"));
        _verify();
    }

    function test_theTraitsMustHaveCode() public {
        RawStub hk = _stubAt(_ripemdOf(HOOK));
        _wireFactory(address(f), address(hk), address(en), address(mi), address(ca), RIPEMD, address(li), address(me));
        _wireParts(address(f), address(hk), address(en), address(mi), address(ca), RIPEMD);
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "traits code"));
        _verify();
    }

    /// @dev What the shadowing looks like from outside: a component with no code is refused, but by a bare revert from
    ///      the decode, before the named check could run. For the links renderer this is the only outcome: its answer is a
    ///      `string`, and no precompile answers a 4-byte call with something that decodes as the expected one, so the
    ///      `links code` check at the end of `_verify` is not reachable at all.
    function test_aComponentWithNoCodeIsRefusedByABareRevert() public {
        address[6] memory none = [address(0xDEAD), address(0xDEAD), address(0xDEAD), address(0xDEAD), address(0xDEAD), address(0xDEAD)];
        for (uint256 k; k < 6; ++k) {
            // k: 0 hook, 1 enumeration, 2 minter, 3 card, 4 traits, 5 links
            address[6] memory c = [address(hook), address(en), address(mi), address(ca), address(tr), address(li)];
            c[k] = none[k];
            _wireFactory(address(f), c[0], c[1], c[2], c[3], c[4], c[5], address(me));
            try d.verify(OrgFactory(address(f)), abx, renderer, seed, dirStore, fileStore, BASE) {
                revert("a component with no code must be refused");
            } catch (bytes memory err) {
                // `forge test -vvv` (CI) rewrites a bare revert that follows a call to a code-less address into its own
                // diagnostic, `abi.encode("call to non-contract address <addr>")`; either is the decode, not a WiringMismatch.
                bool bare = err.length == 0
                    || keccak256(err) == keccak256(abi.encode(string.concat("call to non-contract address ", vm.toString(none[k]))));
                assertTrue(bare, "a bare revert: the decode of an empty answer, not a WiringMismatch");
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// _env and run()
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptEnvTest is Test {
    DeployHarness internal d;

    function setUp() public {
        d = new DeployHarness();
    }

    /// @dev Variable names no other test touches: `vm.setEnv` is process-global and forge runs tests in parallel, so a
    ///      test that sets a variable another one reads would race. These two are this test's alone.
    function test_anEnvAddressMustBeNonzero() public {
        vm.setEnv("ABXFS_COVERAGE_TEST_ZERO_ADDRESS", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.MissingAddress.selector, "ABXFS_COVERAGE_TEST_ZERO_ADDRESS"));
        d.env("ABXFS_COVERAGE_TEST_ZERO_ADDRESS");

        vm.setEnv("ABXFS_COVERAGE_TEST_SOME_ADDRESS", "0x00000000000000000000000000000000deadbeef");
        assertEq(d.env("ABXFS_COVERAGE_TEST_SOME_ADDRESS"), address(0xDeaDBeef));
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// runWith reusing what is already deployed
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

contract DeployScriptReuseTest is Test {
    bytes4 internal constant ABX = bytes4(keccak256("abx()"));
    bytes4 internal constant RENDERER = bytes4(keccak256("metadataRenderer()"));
    bytes4 internal constant SEED = bytes4(keccak256("seedSource()"));
    bytes4 internal constant LINKS = bytes4(keccak256("links()"));
    bytes4 internal constant HOOK = bytes4(keccak256("hook()"));
    bytes4 internal constant ENUM = bytes4(keccak256("enumeration()"));
    bytes4 internal constant MINTER = bytes4(keccak256("minter()"));
    bytes4 internal constant CARD = bytes4(keccak256("card()"));
    bytes4 internal constant TRAITS = bytes4(keccak256("traits()"));
    bytes4 internal constant ORG_META = bytes4(keccak256("orgMeta()"));
    bytes4 internal constant COMPONENTS = bytes4(keccak256("componentsDeployed()"));
    bytes4 internal constant SALT = bytes4(keccak256("COMPONENT_SALT()"));
    bytes4 internal constant DEPLOYER = bytes4(keccak256("CREATE2_DEPLOYER()"));
    bytes4 internal constant DIR_STORE = bytes4(keccak256("directoryStore()"));
    bytes4 internal constant FILE_STORE = bytes4(keccak256("fileStore()"));
    bytes4 internal constant FACTORY = bytes4(keccak256("factory()"));
    bytes4 internal constant GATEWAY_BASE = bytes4(keccak256("gatewayBase()"));

    address internal constant KEYLESS = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    string internal constant BASE = "https://fs.abx.io";

    DeployProjects.Inputs internal i;
    address internal meta;
    address internal predicted;
    RawStub internal fac;
    RawStub internal li;
    RawStub internal otherMeta;

    /// @dev Stand-ins for everything a reused factory is read back through, all consistent with `i`, and a stand-in
    ///      factory at the address the script will find occupied.
    function _rig() internal {
        i = DeployProjects.Inputs(address(new DWAbxFactory()), address(new DWRenderer()), address(new DWSeed()), address(new DWDirectoryStore()), address(new DWFileStore()), address(0), BASE);
        i.presentation = address(new DWPresentation(i.directoryStore, i.fileStore, BASE));
        meta = vm.computeCreate2Address(
            keccak256("abx-fs/org-meta"), keccak256(abi.encodePacked(type(OrgMeta).creationCode, abi.encode(BASE))), KEYLESS
        );
        predicted = vm.computeCreate2Address(
            keccak256("abx-fs/org-factory"),
            keccak256(
                abi.encodePacked(
                    type(OrgFactory).creationCode,
                    abi.encode(i.abx, i.renderer, i.seed, i.directoryStore, i.fileStore, meta, i.presentation)
                )
            ),
            KEYLESS
        );
        vm.etch(predicted, address(new RawStub()).code);
        fac = RawStub(predicted);
        li = new RawStub();
        otherMeta = new RawStub();
        address predictedHook = vm.computeCreate2Address(
            keccak256("abx-fs/org-components"),
            keccak256(
                abi.encodePacked(type(ProjectHook).creationCode, abi.encode(i.directoryStore, i.fileStore, predicted))
            ),
            KEYLESS
        );
        vm.etch(predictedHook, address(new RawStub()).code);
        RawStub hook = RawStub(predictedHook);
        RawStub en = new RawStub();
        RawStub mi = new RawStub();
        RawStub ca = new RawStub();
        RawStub tr = new RawStub();

        fac.ret(ABX, abi.encode(i.abx));
        fac.ret(RENDERER, abi.encode(i.renderer));
        fac.ret(bytes4(keccak256("presentation()")), abi.encode(i.presentation));
        fac.ret(SEED, abi.encode(i.seed));
        fac.ret(LINKS, abi.encode(address(li)));
        fac.ret(HOOK, abi.encode(address(hook)));
        fac.ret(ENUM, abi.encode(address(en)));
        fac.ret(MINTER, abi.encode(address(mi)));
        fac.ret(CARD, abi.encode(address(ca)));
        fac.ret(TRAITS, abi.encode(address(tr)));
        fac.ret(ORG_META, abi.encode(address(otherMeta))); // not the one the script deploys and probes
        fac.ret(COMPONENTS, abi.encode(true));
        fac.ret(SALT, abi.encode(keccak256("abx-fs/org-components")));
        fac.ret(DEPLOYER, abi.encode(KEYLESS));
        hook.ret(DIR_STORE, abi.encode(i.directoryStore));
        hook.ret(FILE_STORE, abi.encode(i.fileStore));
        hook.ret(FACTORY, abi.encode(predicted));
        en.ret(FACTORY, abi.encode(predicted));
        mi.ret(FACTORY, abi.encode(predicted));
        ca.ret(HOOK, abi.encode(address(hook)));
        tr.ret(HOOK, abi.encode(address(hook)));
        li.ret(GATEWAY_BASE, abi.encode(BASE));
        otherMeta.ret(LINKS, abi.encode(address(li))); // consistent in every other respect
    }

    /// @dev Something already sits at the factory's predicted address, which the script reuses without redeploying.
    ///      CREATE2 makes that something the factory built from these exact arguments, so a factory whose `orgMeta`
    ///      differs from the one the script just probed cannot arise from the deployer. A scripted stand-in can be
    ///      one, and the script must still refuse it, after reading everything else back: the last line of defence
    ///      for the one fact the address does not pin on its own.
    function test_aReusedFactoryMustNameTheOrgMetaThatWasJustProbed() public {
        DeployHarness d = new DeployHarness();
        vm.chainId(999);
        _rig();

        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "orgMeta"));
        d.runWith(i, true, true);

        // Pointed at the OrgMeta the script deploys, the same reused factory still has to share its links renderer:
        // the stand-in's is not the one OrgMeta really deployed.
        fac.ret(ORG_META, abi.encode(meta));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "links != orgMeta.links"));
        d.runWith(i, true, true);
    }

    /// @dev A reused factory that names a hook other than the predicted one binds the lens to it, so the lens lands
    ///      away from its predicted address and the run refuses before reading anything else back.
    function test_aReusedFactoryNamingAnotherHookPutsTheLensElsewhere() public {
        DeployHarness d = new DeployHarness();
        vm.chainId(999);
        _rig();
        RawStub stray = new RawStub();
        stray.ret(DIR_STORE, abi.encode(i.directoryStore));
        stray.ret(FILE_STORE, abi.encode(i.fileStore));
        stray.ret(FACTORY, abi.encode(predicted));
        fac.ret(HOOK, abi.encode(address(stray)));
        vm.expectRevert(abi.encodeWithSelector(DeployProjects.WiringMismatch.selector, "lens address != predicted"));
        d.runWith(i, true, true);
    }
}
