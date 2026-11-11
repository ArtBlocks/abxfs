// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {OrgFactory} from "../src/OrgFactory.sol";
import {OrgMeta} from "../src/OrgMeta.sol";
import {Lens} from "../src/Lens.sol";
import {ProjectHook} from "../src/ProjectHook.sol";
import {ProjectEnumeration} from "../src/ProjectEnumeration.sol";
import {OrgMinter} from "../src/OrgMinter.sol";
import {ProjectCard} from "../src/ProjectCard.sol";
import {ProjectTraits} from "../src/ProjectTraits.sol";
import {OrgComponents} from "./OrgComponents.sol";
import {PresentationChecks} from "./PresentationChecks.sol";

/// @title Deploy — contracts-projects (the ABX FS org layer; `specs/abx-fs-orgs.md`)
/// @notice Deploys `OrgMeta` (which deploys the links renderer), then the ABX FS org factory, then its five
///         components (the configure hook, the enumeration hook, the minter, the card and the traits renderer),
///         then the lens. The factory computes each component's address itself (`OrgFactory`), so nothing is
///         wired by hand: each component is one CREATE2 through the keyless deployer, in its own transaction,
///         and lands where the factory said or the run reverts. Every org is then one `createOrg` call.
///
/// @dev    The factory has no owner and no upgrade path, and neither does anything it deploys. A
///         changed factory is a new address, never an edit: register it in the SDK and leave the old one
///         alone.
///
///         Everything, the lens included, is CREATE2 through Foundry's keyless deployer with fixed salts, matching
///         contracts-core, and no constructor argument depends on the sender: any key deploys every contract at
///         the same address on every chain. The address depends on the constructor arguments below, so the ABX
///         addresses, both store addresses and `OrgMeta` (itself CREATE2 with a fixed salt, from the gateway base)
///         are part of the factory's identity: the same salt with different inputs is a different factory. The
///         lens takes the factory and its hook, so it lands at one address per factory as well.
///
///         Env:
///           ABXFS_DIRECTORY_STORE   the content layer's `DirectoryStore` (contracts-core `Deploy.predict()`)
///           ABXFS_FILE_STORE        the content layer's `FileStore` (contracts-core `Deploy.predict()`)
///           ABX_SERIES_CODE_FACTORY ABX's canonical SeriesCode factory on this chain
///           ABX_METADATA_RENDERER   ABX's canonical metadata renderer
///           ABX_SEED_SOURCE         ABX's canonical seed source
///           ABXFS_PRESENTATION      the predeployed immutable presentation companion
///           ABXFS_GATEWAY_BASE      the site tokens link to: https://fs.abx.io — no trailing
///                                   slash. FROZEN into every org's metadata, so it must be a domain
///                                   this project owns for as long as any org exists.
///         The three ABX values come from the ABX SDK deployment registry.
///
///         Everything is validated BEFORE anything is broadcast, because all of it is frozen into every
///         org. `preflight` is the whole gate on the inputs:
///           1. every dependency address is nonzero and has code;
///           2. every dependency ANSWERS as what it is claimed to be (staticcall probes), so a renderer
///              that is really a FileStore, or a directory/file store pair swapped, is caught;
///           3. every ABX and store address equals an in-script allow-table keyed by `block.chainid`;
///           4. the gateway base is on the chain's allow-list and has a valid format (`https://` + a
///              host, no trailing slash, whitespace or markup/JSON breakers, at most 128 bytes).
///         and on a listed chain `runWith` then refuses to broadcast unless every address it would deploy to is
///         `pinned()`: a changed source, library or remapping is refused, not deployed.
///         Escape hatches are explicit env flags, never defaults:
///           ABXFS_ALLOW_UNLISTED_CHAIN=1    chain not in the table, an address that differs from it, or a build
///                                           whose addresses are not the pinned ones
///           ABXFS_ALLOW_UNLISTED_GATEWAY=1  a gateway base not on the chain's list (always needed on an
///                                           unlisted chain, whose list is empty)
///         The probes (2) and the format check (4) run even with the flags set.
///         After deploying, the script reads the result back and reverts unless the factory points where
///         it was told to and its address is the predicted one. These checks live here, not in the
///         constructor, to keep the factory's initcode headroom. See docs/deploy-runbook.md.
contract DeployProjects is Script {
    error MissingAddress(string name);
    error NoCode(string name, address at);
    error BadGatewayBase(string reason);
    error WiringMismatch(string what);
    error ProbeFailed(string what, address at);
    error UnlistedChain(uint256 chainId);
    error UnexpectedAddress(string name, address got, address expected);
    error UnlistedGateway(string gatewayBase);
    /// @notice A gateway base other than the table's, on a listed chain without the chain override. The base is
    ///         `OrgMeta`'s constructor argument, so it moves `OrgMeta` and with it every pinned address: a new domain
    ///         there is a new build (a reviewed re-pin and table change), not a gateway override.
    error GatewayMovesThePins(string gatewayBase);

    struct Inputs {
        address abx;
        address renderer;
        address seed;
        address directoryStore;
        address fileStore;
        address presentation;
        string gatewayBase;
    }

    /// @notice Every address a run deploys to, in deployment order (the links renderer is `OrgMeta`'s, and moves with
    ///         it).
    struct Addresses {
        address orgMeta;
        address factory;
        address hook;
        address enumeration;
        address minter;
        address card;
        address traits;
        address lens;
    }

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // Not secrets; fixed so addresses are reproducible per chain.
    bytes32 internal constant SALT_ORG_FACTORY = keccak256("abx-fs/org-factory");
    bytes32 internal constant SALT_ORG_META = keccak256("abx-fs/org-meta");
    bytes32 internal constant SALT_LENS = keccak256("abx-fs/lens");
    /// @dev `OrgFactory.COMPONENT_SALT`: the factory names each component's address under it.
    bytes32 internal constant SALT_COMPONENT = keccak256("abx-fs/org-components");

    function _env(string memory name) internal view returns (address a) {
        a = vm.envAddress(name);
        if (a == address(0)) revert MissingAddress(name);
    }

    function _requireCode(string memory name, address a) internal view {
        if (a == address(0)) revert MissingAddress(name);
        if (a.code.length == 0) revert NoCode(name, a);
    }

    /// @notice Reverts unless `base` is usable as the frozen default gateway base: `https://` + a host,
    ///         at most 128 bytes, no trailing slash, no whitespace, control, non-ASCII or any character
    ///         `ProjectLinks` refuses in a project's own URL (`" & ' ( ) < > [ \ ] ^ \` { | }`): the base is
    ///         emitted in the same two fields.
    function validateGatewayBase(string memory base) public pure {
        PresentationChecks.gatewayBase(base);
    }

    function _predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Allow-table. The ABX addresses are ABX's canonical CREATE2 set (identical on every chain ABX
    // supports; `@artblocks/abx-sdk` DEPLOYMENTS) and the stores are the ABX FS content layer's
    // `FileStore` / `DirectoryStore` (contracts-core `script/Deploy.s.sol`, `predict()`), which land at the
    // same CREATE2 addresses on every chain. `test/DeployScript.t.sol` recomputes the store pair from the core
    // creation code and fails if this table drifts from it. Add a chain here in the same change that adds it to
    // the SDK registry.
    // ---------------------------------------------------------------------------------------------

    function _isListedChain(uint256 chainId) internal pure returns (bool) {
        return chainId == 8453 || chainId == 84532 || chainId == 1 || chainId == 11155111 || chainId == 42161
            || chainId == 421614 || chainId == 4663 || chainId == 46630;
    }

    /// @notice The allow-table entry for every listed chain (they all bind the same set).
    function expected() public pure returns (Inputs memory e) {
        e.abx = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
        e.renderer = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
        e.seed = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
        // The hook asks only `fileExists` / `directoryExists`, so a root is publishable only if it lives in THESE
        // stores (any storage backend: the stores accept chunks from any backend).
        e.directoryStore = 0x4273E4E078F47303Ca15b11959eeb61F3FC94c11; // DirectoryStore
        e.fileStore = 0x8b6077a1d6953D96687005B9408D56A655b4d155; // FileStore
        e.presentation = 0x5F7801b644596d68c3bbcf2f08ac56641745775F;
        e.gatewayBase = "https://fs.abx.io";
    }

    function _gatewayAllowed(uint256 chainId, string memory base) internal pure returns (bool) {
        if (_isListedChain(chainId)) {
            return keccak256(bytes(base)) == keccak256(bytes(expected().gatewayBase));
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------
    // Probes. Each is a raw staticcall with a decoded result: it never reverts on the callee's behalf
    // and says exactly which dependency failed.
    // ---------------------------------------------------------------------------------------------

    function _word(address to, bytes memory data) internal view returns (bool ok, uint256 w) {
        bytes memory ret;
        (ok, ret) = to.staticcall(data);
        if (ok && ret.length == 32) w = abi.decode(ret, (uint256));
        else ok = false;
    }

    /// @dev Whether the call answered at all with one 32-byte word.
    function _answers(address to, bytes memory data) internal view returns (bool ok) {
        (ok,) = _word(to, data);
    }

    function _probe(Inputs memory i) internal view {
        // ABX factory: the views the factory and the SDK rely on.
        (bool ok, uint256 w) =
            _word(i.abx, abi.encodeWithSignature("predictDeterministicAddress(bytes32)", bytes32(uint256(1))));
        if (!ok || w == 0 || w >> 160 != 0) {
            revert ProbeFailed("ABX_SERIES_CODE_FACTORY.predictDeterministicAddress", i.abx);
        }
        (ok, w) = _word(i.abx, abi.encodeWithSignature("implementation()"));
        if (!ok || w == 0 || w >> 160 != 0 || address(uint160(w)).code.length == 0) {
            revert ProbeFailed("ABX_SERIES_CODE_FACTORY.implementation", i.abx);
        }
        (ok, w) = _word(i.abx, abi.encodeWithSignature("isAbxClone(address)", address(0xdead)));
        if (!ok || w != 0) revert ProbeFailed("ABX_SERIES_CODE_FACTORY.isAbxClone", i.abx);

        // Metadata renderer: `specVersion()` is pure and nonzero, and no other contract here has it.
        (ok, w) = _word(i.renderer, abi.encodeWithSignature("specVersion()"));
        if (!ok || w == 0) revert ProbeFailed("ABX_METADATA_RENDERER.specVersion", i.renderer);

        // Seed source: `seed(uint256,address)` returns one word and does not revert for a probe input.
        if (!_answers(i.seed, abi.encodeWithSignature("seed(uint256,address)", uint256(1), address(0xdead)))) {
            revert ProbeFailed("ABX_SEED_SOURCE.seed", i.seed);
        }

        // Stores: each must answer its OWN predicate for the zero root with false...
        (ok, w) = _word(i.directoryStore, abi.encodeWithSignature("directoryExists(bytes32)", bytes32(0)));
        if (!ok || w != 0) revert ProbeFailed("ABXFS_DIRECTORY_STORE.directoryExists(0)", i.directoryStore);
        (ok, w) = _word(i.fileStore, abi.encodeWithSignature("fileExists(bytes32)", bytes32(0)));
        if (!ok || w != 0) revert ProbeFailed("ABXFS_FILE_STORE.fileExists(0)", i.fileStore);
        // ...and must NOT answer the other one's, which is what a swapped (or duplicated) pair does.
        if (_answers(i.directoryStore, abi.encodeWithSignature("fileExists(bytes32)", bytes32(0)))) {
            revert ProbeFailed("ABXFS_DIRECTORY_STORE answers fileExists", i.directoryStore);
        }
        // One address for both stores answers both predicates, so the cross-check above refuses it too.
        if (_answers(i.fileStore, abi.encodeWithSignature("directoryExists(bytes32)", bytes32(0)))) {
            revert ProbeFailed("ABXFS_FILE_STORE answers directoryExists", i.fileStore);
        }
    }

    function _same(string memory name, address got, address want) internal pure {
        if (got != want) revert UnexpectedAddress(name, got, want);
    }

    /// @notice The whole pre-broadcast gate; see the contract docs. A view with no env access so every
    ///         scenario is directly testable.
    function preflight(Inputs memory i, bool allowUnlistedChain, bool allowUnlistedGateway) public view {
        _requireCode("ABX_SERIES_CODE_FACTORY", i.abx);
        _requireCode("ABX_METADATA_RENDERER", i.renderer);
        _requireCode("ABX_SEED_SOURCE", i.seed);
        _requireCode("ABXFS_DIRECTORY_STORE", i.directoryStore);
        _requireCode("ABXFS_FILE_STORE", i.fileStore);
        _requireCode("ABXFS_PRESENTATION", i.presentation);

        _probe(i);

        if (_isListedChain(block.chainid)) {
            if (!allowUnlistedChain) {
                Inputs memory e = expected();
                _same("ABX_SERIES_CODE_FACTORY", i.abx, e.abx);
                _same("ABX_METADATA_RENDERER", i.renderer, e.renderer);
                _same("ABX_SEED_SOURCE", i.seed, e.seed);
                _same("ABXFS_DIRECTORY_STORE", i.directoryStore, e.directoryStore);
                _same("ABXFS_FILE_STORE", i.fileStore, e.fileStore);
                _same("ABXFS_PRESENTATION", i.presentation, e.presentation);
            }
        } else if (!allowUnlistedChain) {
            revert UnlistedChain(block.chainid);
        }

        validateGatewayBase(i.gatewayBase);
        if (!allowUnlistedGateway && !_gatewayAllowed(block.chainid, i.gatewayBase)) {
            revert UnlistedGateway(i.gatewayBase);
        }
        probePresentation(i.presentation, i.directoryStore, i.fileStore, i.gatewayBase);
    }

    /// @notice Cross-check every immutable presentation dependency even when address allow-list overrides are set.
    function probePresentation(
        address presentation,
        address directoryStore,
        address fileStore,
        string memory gatewayBase
    ) public view {
        PresentationChecks.presentation(presentation, directoryStore, fileStore, gatewayBase);
    }

    function run() external returns (address factory, address lens) {
        Inputs memory i = Inputs({
            abx: _env("ABX_SERIES_CODE_FACTORY"),
            renderer: _env("ABX_METADATA_RENDERER"),
            seed: _env("ABX_SEED_SOURCE"),
            directoryStore: _env("ABXFS_DIRECTORY_STORE"),
            fileStore: _env("ABXFS_FILE_STORE"),
            presentation: _env("ABXFS_PRESENTATION"),
            gatewayBase: vm.envString("ABXFS_GATEWAY_BASE")
        });
        return
            runWith(i, vm.envOr("ABXFS_ALLOW_UNLISTED_CHAIN", false), vm.envOr("ABXFS_ALLOW_UNLISTED_GATEWAY", false));
    }

    /// @notice Where a run with inputs `i` deploys everything: a function of this build's creation code, the salts and
    ///         the inputs only.
    function predict(Inputs memory i) public pure returns (Addresses memory a) {
        a.orgMeta = _predict(SALT_ORG_META, abi.encodePacked(type(OrgMeta).creationCode, abi.encode(i.gatewayBase)));
        a.factory = _predict(
            SALT_ORG_FACTORY,
            abi.encodePacked(
                type(OrgFactory).creationCode,
                abi.encode(i.abx, i.renderer, i.seed, i.directoryStore, i.fileStore, a.orgMeta, i.presentation)
            )
        );
        a.hook = _predict(
            SALT_COMPONENT,
            abi.encodePacked(type(ProjectHook).creationCode, abi.encode(i.directoryStore, i.fileStore, a.factory))
        );
        a.enumeration =
            _predict(SALT_COMPONENT, abi.encodePacked(type(ProjectEnumeration).creationCode, abi.encode(a.factory)));
        a.minter = _predict(SALT_COMPONENT, abi.encodePacked(type(OrgMinter).creationCode, abi.encode(a.factory)));
        a.card = _predict(SALT_COMPONENT, abi.encodePacked(type(ProjectCard).creationCode, abi.encode(a.hook)));
        a.traits = _predict(SALT_COMPONENT, abi.encodePacked(type(ProjectTraits).creationCode, abi.encode(a.hook)));
        a.lens = _predict(SALT_LENS, abi.encodePacked(type(Lens).creationCode, abi.encode(a.factory, a.hook)));
    }

    /// @notice Complete verified production generation retained for existing orgs; never relabel candidate pins as deployed.
    function previousPinned() public pure returns (Addresses memory a) {
        a.orgMeta = 0xB21e65DE1c241B9BaE8b7077b6f2E8f2c3Bc0F5D;
        a.factory = 0xC5aBF9fBd94659cdfc173AF30c6052700Fa62798;
        a.hook = 0x3828Dd35AbF6a42F0d92E0F3311bd70593BD6E7B;
        a.enumeration = 0x2b2a84df4d62d18329899b66c744E6C643cDC065;
        a.minter = 0xc009135a8b9DdB14De53868773Fc1dc97963De1e;
        a.card = 0x0296686ED7193D27b945F121835177D6969208f0;
        a.traits = 0x087dfB523e4085A5Ae2E600c4Fc899813fB7AA3F;
        a.lens = 0x2Ef71C4780e70F64507F04BD1Fde35eC3713269e;
    }

    /// @notice Where the pinned build lands on every listed chain: they all bind the same table (`expected()`),
    ///         so `predict(expected())` is one set of addresses. `test/DeployFactoryPin.t.sol` fails when it drifts from
    ///         this, and `runWith` refuses to broadcast on a listed chain unless it holds. Re-pin deliberately, and only
    ///         before a deployment.
    /// @dev Candidate pins for the new factory generation; the SDK retains deployed previousPinned addresses until verification.
    function pinned() public view virtual returns (Addresses memory a) {
        a.orgMeta = 0xB21e65DE1c241B9BaE8b7077b6f2E8f2c3Bc0F5D;
        a.factory = 0xb057b5b6641717EB85E9D8b3Ba23988E0A6d147A;
        a.hook = 0x73E2E4945b54D0D98F0A81932b831B32Ed7edecb;
        a.enumeration = 0x6928e670C7e92e8d3824209447cC7Bd10d77db7A;
        a.minter = 0x53383C2a4c36Ab9fbc5fe3D2BEEA7D23D72cc69f;
        a.card = 0x67beCeAe265A81FFa5375355417B0C6755E25766;
        a.traits = 0x3eaFef43e76c627db2A99A13f53b7f88C4f6CFE5;
        a.lens = 0x28f30bB97Fb2a29Bf19b3AB04323B186ba461DE5;
    }

    /// @notice Reverts `UnexpectedAddress` unless every address in `a` is `pinned()`.
    function requirePinned(Addresses memory a) public view {
        Addresses memory p = pinned();
        _same("OrgMeta", a.orgMeta, p.orgMeta);
        _same("OrgFactory", a.factory, p.factory);
        _same("ProjectHook", a.hook, p.hook);
        _same("ProjectEnumeration", a.enumeration, p.enumeration);
        _same("OrgMinter", a.minter, p.minter);
        _same("ProjectCard", a.card, p.card);
        _same("ProjectTraits", a.traits, p.traits);
        _same("Lens", a.lens, p.lens);
    }

    /// @notice `run()` with its inputs given rather than read from the environment. Tests call this: `vm.setEnv` is
    ///         process-global and forge runs tests in parallel, so tests that set env vars race each other.
    function runWith(Inputs memory i, bool allowUnlistedChain, bool allowUnlistedGateway)
        public
        returns (address factory, address lens)
    {
        // Nothing below is reversible once an org exists, so nothing is broadcast until all of it holds.
        preflight(i, allowUnlistedChain, allowUnlistedGateway);

        // On a listed chain the inputs are the table's (preflight), so the addresses are this build's alone: the build
        // under audit is the only one that may be broadcast there. A gateway the gateway override let through still
        // moves every pin; refuse it here by name rather than at the first `UnexpectedAddress`.
        if (_isListedChain(block.chainid) && !allowUnlistedChain && !_gatewayAllowed(block.chainid, i.gatewayBase)) {
            revert GatewayMovesThePins(i.gatewayBase);
        }
        Addresses memory a = predict(i);
        if (_isListedChain(block.chainid) && !allowUnlistedChain) requirePinned(a);

        // Idempotent by predicted address: CREATE2 reverts `CreateCollision` on a re-run otherwise.
        address orgMeta = a.orgMeta;
        address predicted = a.factory;
        factory = predicted;

        vm.startBroadcast();
        if (orgMeta.code.length == 0) {
            if (address(new OrgMeta{salt: SALT_ORG_META}(i.gatewayBase)) != orgMeta) {
                revert WiringMismatch("orgMeta address != predicted");
            }
        } else {
            console2.log("OrgMeta already deployed, reusing");
        }
        // Before the factory freezes it into every org: it must answer, and never revert.
        probeOrgMeta(orgMeta, i.gatewayBase);
        if (factory.code.length == 0) {
            factory = address(
                new OrgFactory{salt: SALT_ORG_FACTORY}(
                    i.abx, i.renderer, i.seed, i.directoryStore, i.fileStore, orgMeta, i.presentation
                )
            );
            if (factory != predicted) revert WiringMismatch("factory address != predicted");
        } else {
            console2.log("OrgFactory already deployed, reusing");
        }
        // One transaction each, skipping any already there (anyone may have deployed them). Each lands where the
        // factory says or the run reverts; the lens is bound to the hook the factory names, so it lands at its
        // predicted address only if that hook is the predicted one.
        OrgComponents.deploy(OrgFactory(factory), i.directoryStore, i.fileStore);
        lens = a.lens;
        if (lens.code.length == 0) {
            if (address(new Lens{salt: SALT_LENS}(factory, address(OrgFactory(factory).hook()))) != lens) {
                revert WiringMismatch("lens address != predicted");
            }
        } else {
            console2.log("Lens already deployed, reusing");
        }
        vm.stopBroadcast();

        OrgFactory f = OrgFactory(factory);
        _verify(f, i.abx, i.renderer, i.seed, i.directoryStore, i.fileStore, i.gatewayBase);
        if (f.presentation() != i.presentation) revert WiringMismatch("presentation");
        if (f.orgMeta() != orgMeta) revert WiringMismatch("orgMeta");
        console2.log("chain id              ", block.chainid);
        console2.log("gateway base          ", i.gatewayBase);
        console2.log("OrgMeta          ", orgMeta);
        console2.log("OrgFactory       ", factory);
        console2.log("  hook                ", address(f.hook()));
        console2.log("  enumeration         ", address(f.enumeration()));
        console2.log("  minter              ", address(f.minter()));
        console2.log("  card                ", address(f.card()));
        console2.log("  traits              ", address(f.traits()));
        console2.log("  links               ", address(f.links()));
        console2.log("Lens             ", lens);
        console2.log("");
        console2.log(
            "Before announcing any address: rehearse a throwaway org AND a throwaway publish on this exact build."
        );
        console2.log("Prove on the paired testnet before any production chain; see docs/deploy-runbook.md.");
    }

    /// @notice Reverts unless `orgMeta` is a `OrgMeta` for `gatewayBase` whose links renderer shares that
    ///         base, and whose collection document for a token that is nothing (no code) still comes back as a
    ///         JSON data URI rather than a revert.
    function probeOrgMeta(address orgMeta, string memory gatewayBase) public view {
        if (orgMeta.code.length == 0) revert NoCode("OrgMeta", orgMeta);
        OrgMeta m = OrgMeta(orgMeta);
        if (keccak256(bytes(m.gatewayBase())) != keccak256(bytes(gatewayBase))) {
            revert WiringMismatch("orgMeta.gatewayBase");
        }
        if (address(m.links()).code.length == 0) revert WiringMismatch("orgMeta.links code");
        if (keccak256(bytes(m.links().gatewayBase())) != keccak256(bytes(gatewayBase))) {
            revert WiringMismatch("orgMeta.links.gatewayBase");
        }
        (bool ok, bytes memory ret) = orgMeta.staticcall(abi.encodeCall(OrgMeta.contractURI, (address(0xdead))));
        bytes memory prefix = "data:application/json;base64,";
        bytes memory uri = ok && ret.length >= 64 ? bytes(abi.decode(ret, (string))) : bytes("");
        if (uri.length <= prefix.length) revert ProbeFailed("OrgMeta.contractURI", orgMeta);
        for (uint256 j; j < prefix.length; ++j) {
            if (uri[j] != prefix[j]) revert ProbeFailed("OrgMeta.contractURI", orgMeta);
        }
        // The token-name renderer answers too, with the fallback for a token that is nothing.
        (ok, ret) = orgMeta.staticcall(abi.encodeCall(OrgMeta.render, (address(0xdead), 0, bytes32("name"))));
        bytes memory name_;
        if (ok && ret.length >= 128) (, name_) = abi.decode(ret, (string, bytes));
        if (keccak256(name_) != keccak256("Untitled org #0")) revert ProbeFailed("OrgMeta.render", orgMeta);
    }

    /// @dev Read the deployment back. An idempotent re-run reuses whatever sits at the predicted address,
    ///      which is only trustworthy if it says what we meant.
    function _verify(
        OrgFactory f,
        address abx,
        address renderer,
        address seed,
        address directoryStore,
        address fileStore,
        string memory gatewayBase
    ) internal view {
        if (address(f.abx()) != abx) revert WiringMismatch("abx");
        if (f.metadataRenderer() != renderer) revert WiringMismatch("metadataRenderer");
        if (f.seedSource() != seed) revert WiringMismatch("seedSource");
        if (keccak256(bytes(f.links().gatewayBase())) != keccak256(bytes(gatewayBase))) {
            revert WiringMismatch("links.gatewayBase");
        }
        if (address(f.hook().directoryStore()) != directoryStore) revert WiringMismatch("hook.directoryStore");
        if (address(f.hook().fileStore()) != fileStore) revert WiringMismatch("hook.fileStore");
        if (address(f.hook().factory()) != address(f)) revert WiringMismatch("hook.factory");
        if (address(f.enumeration().factory()) != address(f)) revert WiringMismatch("enumeration.factory");
        if (address(f.minter().factory()) != address(f)) revert WiringMismatch("minter.factory");
        if (address(f.card().hook()) != address(f.hook())) revert WiringMismatch("card.hook");
        if (address(f.traits().hook()) != address(f.hook())) revert WiringMismatch("traits.hook");
        if (address(f.hook()).code.length == 0) revert WiringMismatch("hook code");
        if (address(f.enumeration()).code.length == 0) revert WiringMismatch("enumeration code");
        if (address(f.minter()).code.length == 0) revert WiringMismatch("minter code");
        if (address(f.card()).code.length == 0) revert WiringMismatch("card code");
        if (address(f.traits()).code.length == 0) revert WiringMismatch("traits code");
        if (address(f.links()).code.length == 0) revert WiringMismatch("links code");
        if (address(f.links()) != address(OrgMeta(f.orgMeta()).links())) {
            revert WiringMismatch("links != orgMeta.links");
        }
        if (!f.componentsDeployed()) revert WiringMismatch("componentsDeployed");
    }
}
