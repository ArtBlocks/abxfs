// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OrgFactory} from "../../src/OrgFactory.sol";
import {OrgComponents} from "../../script/OrgComponents.sol";
import {OrgMeta} from "../../src/OrgMeta.sol";
import {Lens} from "../../src/Lens.sol";
import {OrgMinter} from "../../src/OrgMinter.sol";
import {AbxInitParams, AbxContractField, AbxTokenField} from "../../src/interfaces/IAbxOrgDeploy.sol";
import {Battery} from "./Battery.sol";
import {ContentLayer, CONTENT_DIRECTORY_STORE, CONTENT_FILE_STORE} from "./ContentLayer.sol";

interface IColl {
    function owner() external view returns (address);
    function paramHooks() external view returns (address, address, address);
    function paramHooksLocked() external view returns (bool);
    function paramSchemaKeys() external view returns (bytes32[] memory);
    function ownerOf(uint256) external view returns (address);
    function tokenURI(uint256) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function tokenParam(uint256, bytes32) external view returns (bytes32, bool, bool);
    function tokenParamData(uint256, bytes32) external view returns (bytes memory);
    function configureTokenParam(uint256, bytes32, bytes32) external;
    function configureTokenParamData(uint256, bytes32, bytes calldata) external;
    function transferFrom(address, address, uint256) external;
    function mint(address) external returns (uint256);
    function maxInvocations() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function name() external view returns (string memory);
    function minter() external view returns (address);
    function initialize(AbxInitParams calldata p) external;
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
}

interface IAbxFactoryView {
    function isAbxClone(address) external view returns (bool);
    function implementation() external view returns (address);
}

/// @dev Runs against the REAL ABX contracts and ABX FS content stores on Base Sepolia. It is the
///      test that says the mock in `AbxMocks.sol` is honest, and the only one that can say what the
///      renounced state of a real collection is.
///
///      Skipped unless `ABXFS_RPC_URL_84532` is set, so CI without a node is unaffected:
///        ABXFS_RPC_URL_84532=… forge test   (the whole suite: fork tests also live outside test/fork)
///
///      Addresses are the canonical ones from the SDK registry (`packages/sdk/src/canonical.ts`) and the ABX SDK.
contract OrgForkTest is Test {
    using LibString for string;

    address constant ABX_SERIES_CODE_FACTORY = 0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616;
    address constant ABX_RENDERER = 0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27;
    address constant ABX_SEED = 0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A;
    address constant DIRECTORY_STORE = CONTENT_DIRECTORY_STORE;
    address constant FILE_STORE = CONTENT_FILE_STORE;
    /// @dev A previous collection that has published roots. We borrow one real CID that exists in the
    ///      stores, because the hook refuses to publish a root the stores do not hold.
    address constant PUBLISHED_COLLECTION = 0x7015Ab36fA7d62dAf286561114E7f3c250511E31;

    OrgFactory factory;
    Lens lens;
    address admin = makeAddr("admin");
    address stranger = makeAddr("stranger");
    address org;

    function setUp() public {
        string memory url = vm.envOr("ABXFS_RPC_URL_84532", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        ContentLayer.deploy();

        factory = OrgComponents.create(
            ABX_SERIES_CODE_FACTORY, ABX_RENDERER, ABX_SEED, DIRECTORY_STORE, FILE_STORE, address(new OrgMeta("https://fs.abx.io"))
        );
        lens = new Lens(address(factory), address(factory.hook()));
        vm.prank(admin);
        org = factory.createOrg("Fork Org", "", bytes32(0));
    }

    /// @dev A real directory in the content stores on the fork, so the hook accepts it because the stores hold it.
    function _publishedCid() internal returns (bytes32) {
        return ContentLayer.realDirectory("fork");
    }

    function test_realAbxIsFrozenAfterCreateOrg() public view {
        IColl c = IColl(org);
        assertTrue(IAbxFactoryView(ABX_SERIES_CODE_FACTORY).isAbxClone(org), "a canonical ABX clone");
        assertEq(c.owner(), address(0), "renounced");
        (address cfg, address aug, address xfer) = c.paramHooks();
        assertEq(cfg, address(factory.hook()));
        assertEq(aug, address(0));
        assertEq(xfer, address(factory.enumeration()));
        assertTrue(c.paramHooksLocked());
        assertEq(c.paramSchemaKeys().length, 5);
        assertEq(c.maxInvocations(), 1_000_000);
        assertEq(c.totalSupply(), 1);
        assertEq(c.ownerOf(0), admin);
    }

    function test_realMintRulesAfterRenounce() public {
        OrgFactory f = factory;
        OrgMinter m = f.minter(); // read first: a getter call would consume the prank
        vm.prank(stranger);
        vm.expectRevert();
        m.mint(org, stranger);

        // No one can mint around the minter, the admin included.
        vm.prank(admin);
        vm.expectRevert();
        IColl(org).mint(admin);

        vm.prank(admin);
        f.setOpen(org, true);
        vm.prank(stranger);
        uint256 id = m.mint(org, stranger);
        assertEq(IColl(org).ownerOf(id), stranger);
    }

    function test_realPublishFlowsThroughEveryIndex() public {
        bytes32 cid = _publishedCid();
        IColl c = IColl(org);

        vm.prank(admin);
        c.configureTokenParam(0, "abxfs.cid", cid);
        vm.prank(admin);
        c.configureTokenParamData(0, "abxfs.meta", bytes('{"v":1}'));

        assertEq(factory.hook().versionCount(org, 0), 1);
        assertEq(factory.hook().globalPublishCount(), 1);
        Lens.Published[] memory page = lens.publishRange(0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].org, org);
        assertEq(page[0].record.cid, cid);

        Lens.Resolution memory r = lens.resolve(org, 0);
        assertTrue(r.registered);
        assertEq(r.cid, cid);
        assertEq(r.owner, admin);

        // A transfer moves the org-held index and the authority with it.
        vm.prank(admin);
        c.transferFrom(admin, stranger, 0);
        assertEq(factory.enumeration().orgsHeldBy(admin).length, 0);
        assertEq(factory.enumeration().orgsHeldBy(stranger).length, 1);
    }

    /// @dev The check the mock cannot make: that ABX's own metadata renderer accepts the field
    ///      encoding the factory sends, and that the card it calls shows the org's name.
    function test_realTokenURIRendersOurCardWithTheOrgName() public {
        string memory uri = IColl(org).tokenURI(0);
        string memory prefix = "data:application/json;base64,";
        assertTrue(uri.startsWith(prefix), "on-chain metadata");
        string memory json = string(Base64.decode(uri.slice(bytes(prefix).length)));
        assertTrue(json.contains("Fork Org") || json.contains("ABX FS"), "name present");

        string memory marker = "data:image/svg+xml;base64,";
        uint256 at = json.indexOf(marker);
        assertTrue(at != LibString.NOT_FOUND, "the image is our on-chain card");
        string memory rest = json.slice(at + bytes(marker).length);
        uint256 end = rest.indexOf('"');
        string memory svg = string(Base64.decode(rest.slice(0, end)));
        assertTrue(svg.contains("Fork Org"), "the card header is the org's name");

        // The two link fields, computed by ProjectLinks and landing verbatim as URLs — not
        // wrapped in a `data:` URI, which no marketplace would dereference.
        string memory orgHex = LibString.toHexString(org);
        assertTrue(
            json.contains(
                string.concat('"animation_url":"https://fs.abx.io/g/p/84532/', orgHex, '/0/latest/"')
            ),
            "animation_url is the live project"
        );
        assertTrue(
            json.contains(
                string.concat('"external_url":"https://fs.abx.io/projects/84532/', orgHex, '/0"')
            ),
            "external_url is the project page"
        );

        // The collection surface must render too: a revert there bricks contractURI.
        assertGt(bytes(IColl(org).contractURI()).length, 0);

        // The owner's own URL replaces BOTH fields, through the real ABX renderer, with nothing added.
        vm.prank(admin);
        IColl(org).configureTokenParamData(0, "abxfs.view", bytes("https://my-site.example/"));
        string memory uri2 = IColl(org).tokenURI(0);
        string memory json2 = string(Base64.decode(uri2.slice(bytes(prefix).length)));
        assertTrue(json2.contains('"animation_url":"https://my-site.example/"'), "animation_url is the owner's");
        assertTrue(json2.contains('"external_url":"https://my-site.example/"'), "external_url is the owner's");

        // A value we will not emit falls back to the default instead of reaching the metadata.
        vm.prank(admin);
        IColl(org).configureTokenParamData(0, "abxfs.view", bytes("javascript:alert(1)"));
        string memory json3 =
            string(Base64.decode(IColl(org).tokenURI(0).slice(bytes(prefix).length)));
        assertFalse(json3.contains("javascript:"), "an unusable value never reaches the metadata");
        assertTrue(json3.contains('"animation_url":"https://fs.abx.io/g/p/'), "falls back");
    }

    function test_realDeterministicAddressMatchesPrediction() public {
        bytes32 salt = bytes32(abi.encodePacked(admin, uint96(42)));
        address predicted = factory.predictOrg(salt);
        vm.prank(admin);
        address made = factory.createOrg("Deterministic", "", salt);
        assertEq(made, predicted);

        vm.prank(stranger);
        vm.expectRevert();
        factory.createOrg("Squat", "", salt);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("SaltSenderMismatch()"));
        factory.createOrg("Squat", "", salt);
    }

    /// Caller-scoped no-ops that grant nothing: the handover cannot complete because
    /// `completeOwnershipHandover` is owner-only, and the owner is zero.
    function _callerScoped(string memory sig) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(sig));
        return h == keccak256("approve(address,uint256)") || h == keccak256("setApprovalForAll(address,bool)")
            || h == keccak256("cancelOwnershipHandover()") || h == keccak256("requestOwnershipHandover()")
            || h == keccak256("multicall(bytes[])");
    }

    /// @dev The minter is the org's mint authority, so a mint from its address is not a finding: no code path reaches
    ///      that address but `OrgMinter.mint`, after `mayMint`.
    function _minterMint(address actor, string memory sig) internal view returns (bool) {
        bytes32 h = keccak256(bytes(sig));
        return actor == address(factory.minter())
            && (h == keccak256("mint(address)") || h == keccak256("mintMany(address,uint256)"));
    }

    /// @dev Every state-changing selector on the real collection, from every plausible actor, with
    ///      zero-valued arguments. Generated from ABX's own ABI (the sdk package's `gen:battery` script),
    ///      so a mutator ABX adds later shows up in a diff instead of slipping past a hand-kept list. The actors
    ///      include ABX's own side: its factory, the clone's implementation, its metadata renderer and seed source,
    ///      the org's minter and hooks, and the org itself.
    function test_realEveryMutatorIsClosed() public {
        address[12] memory actors = [
            admin,
            stranger,
            address(factory),
            address(this),
            ABX_SERIES_CODE_FACTORY,
            IAbxFactoryView(ABX_SERIES_CODE_FACTORY).implementation(),
            ABX_RENDERER,
            ABX_SEED,
            address(factory.minter()),
            address(factory.hook()),
            address(factory.enumeration()),
            org
        ];
        uint256 open;
        for (uint256 i; i < Battery.count(); ++i) {
            for (uint256 a; a < actors.length; ++a) {
                uint256 snap = vm.snapshotState();
                vm.prank(actors[a]);
                (bool ok,) = org.call(Battery.data(i));
                if (ok && !_callerScoped(Battery.name(i)) && !_minterMint(actors[a], Battery.name(i))) {
                    ++open;
                    console2.log("OPEN:", Battery.name(i), a);
                }
                vm.revertToState(snap);
            }
        }
        assertEq(open, 0, "no mutator may succeed for any actor");
    }

    /// @dev A renounced org cannot be re-initialized, not even with VALID parameters (a zero-valued `initialize`, as in
    ///      the battery, could fail for an unrelated reason), by anyone: ABX's side, the factory and its components, the
    ///      org itself, directly or through its own `multicall`.
    function test_realReinitializeWithValidParamsIsClosedToEveryone() public {
        address mallory = makeAddr("mallory");
        AbxInitParams memory p;
        p.owner = mallory;
        p.name = "pwned";
        p.symbol = "PWN";
        p.tokenURIRenderer = ABX_RENDERER;
        p.royaltyReceiver = mallory;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.primaryPayee = mallory;
        p.minter = mallory;
        p.seedSource = ABX_SEED;
        p.contractFields = new AbxContractField[](0);
        p.tokenFields = new AbxTokenField[](0);

        address[11] memory actors = [
            mallory,
            admin,
            ABX_SERIES_CODE_FACTORY,
            IAbxFactoryView(ABX_SERIES_CODE_FACTORY).implementation(),
            address(factory),
            address(factory.minter()),
            address(factory.hook()),
            address(factory.enumeration()),
            ABX_RENDERER,
            ABX_SEED,
            org
        ];
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(IColl.initialize, (p));
        for (uint256 a; a < actors.length; ++a) {
            vm.prank(actors[a]);
            (bool ok,) = org.call(abi.encodeCall(IColl.initialize, (p)));
            assertFalse(ok, "initialize");
            vm.prank(actors[a]);
            (ok,) = org.call(abi.encodeCall(IColl.multicall, (inner)));
            assertFalse(ok, "initialize through multicall");
        }
        IColl c = IColl(org);
        assertEq(c.owner(), address(0));
        assertEq(c.minter(), address(factory.minter()));
        assertEq(c.name(), "Fork Org");
        assertEq(c.maxInvocations(), 1_000_000);
    }
}
