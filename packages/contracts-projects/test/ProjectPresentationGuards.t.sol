// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProjectPresentation} from "../src/ProjectPresentation.sol";
import {IProjectPresentation} from "../src/interfaces/IProjectPresentation.sol";
import {
    PresentationFactoryMock,
    PresentationHookMock,
    PresentationOrgMock,
    PresentationReaderMock
} from "./ProjectPresentation.t.sol";

/// @dev An IPFS resolver whose answer is set by the test, for the directory and the file derivation alike.
contract ScriptedCidResolver {
    address public fileStore;
    address public directoryStore;
    string public cid;

    constructor(address files, address dirs, string memory cid_) {
        fileStore = files;
        directoryStore = dirs;
        cid = cid_;
    }

    function setCid(string calldata cid_) external {
        cid = cid_;
    }

    function computeIpfsCid(bytes32) external view returns (string memory) {
        return cid;
    }

    function computeFileCid(bytes32) external view returns (string memory) {
        return cid;
    }
}

/// @dev The presentation's input checks, one rule at a time: the org's stores, the target's selection, version, tag
///      and path, the self-call-only entry points, and the shape of a CID before it becomes a URI.
contract ProjectPresentationGuardsTest is Test {
    address internal constant FILES = address(0x100);
    address internal constant DIRS = address(0x200);
    address internal constant OTHER = address(0x1234);
    /// @dev The empty directory's IPFS CID (`specs/abx-fs.md`): CIDv1, base32, 59 characters.
    string internal constant CID = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";

    IProjectPresentation.Selection internal constant LATEST = IProjectPresentation.Selection.Latest;
    IProjectPresentation.Selection internal constant VERSION = IProjectPresentation.Selection.Version;
    IProjectPresentation.Selection internal constant TAG = IProjectPresentation.Selection.Tag;

    ProjectPresentation internal p;
    PresentationFactoryMock internal factory;
    PresentationOrgMock internal org;
    PresentationReaderMock internal reader;
    ScriptedCidResolver internal ipfs;

    function setUp() public {
        vm.etch(FILES, hex"00");
        vm.etch(DIRS, hex"00");
        factory = new PresentationFactoryMock();
        org = _orgWithStores(FILES, DIRS);
        reader = new PresentationReaderMock(FILES, DIRS);
        ipfs = new ScriptedCidResolver(FILES, DIRS, CID);
        p = new ProjectPresentation(address(reader), address(ipfs), "https://fs.abx.io");
    }

    function _orgWithStores(address files, address dirs) internal returns (PresentationOrgMock) {
        PresentationHookMock hook = new PresentationHookMock(address(factory), files, dirs);
        return new PresentationOrgMock(address(hook), address(this));
    }

    function _preview() internal view returns (IProjectPresentation.Status status, bytes memory data) {
        (status,, data) = p.preview(address(org), 0);
    }

    // ─── The org's hook must read this presentation's stores ────────────────

    /// @dev A registered org whose hook names other stores (either one, both, or the two swapped) resolves its roots
    ///      against content this presentation does not read. It is refused exactly like an unregistered org: every
    ///      write and every target read says InvalidOrg, and rendering reports an invalid target, reading nothing.
    function test_anOrgWhoseHookNamesOtherStoresIsRefused() public {
        address elsewhere = address(0x300);
        vm.etch(elsewhere, hex"00");
        PresentationOrgMock[4] memory orgs = [
            _orgWithStores(elsewhere, DIRS),
            _orgWithStores(FILES, elsewhere),
            _orgWithStores(DIRS, FILES),
            _orgWithStores(elsewhere, elsewhere)
        ];
        for (uint256 i; i < orgs.length; ++i) {
            address o = address(orgs[i]);
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.setTarget(o, 0, LATEST, 0, "", "");
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.setMethod(o, 0, IProjectPresentation.Method.Embedded);
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.setEndpoints(o, 0, "", "");
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.lock(o, 0, 2, bytes32(0));
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.target(o, 0);
            vm.expectRevert(IProjectPresentation.InvalidOrg.selector);
            p.lockCommitment(o, 0, 1);

            (IProjectPresentation.Status status,, bytes memory data) = p.preview(o, 0);
            assertEq(uint256(status), uint256(IProjectPresentation.Status.InvalidTarget));
            assertEq(data.length, 0);
            (, data) = p.render(o, 0, "animation_url");
            assertEq(data.length, 0);
            assertEq(p.config(o, 0).configuredFlags, 0, "nothing was configured");
        }

        // The same org shape with this presentation's stores is accepted.
        PresentationOrgMock same = _orgWithStores(FILES, DIRS);
        p.setMethod(address(same), 0, IProjectPresentation.Method.Embedded);
        (IProjectPresentation.Status ready,, bytes memory content) = p.preview(address(same), 0);
        assertEq(uint256(ready), uint256(IProjectPresentation.Status.Ready));
        assertEq(string(content), "<html>on chain</html>");
    }

    // ─── setTarget: selection, version and tag agree ────────────────────────

    function _refused(IProjectPresentation.Selection selection, uint32 version, string memory tag, string memory path)
        internal
    {
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.setTarget(address(org), 0, selection, version, tag, path);
    }

    function _accepted(IProjectPresentation.Selection selection, uint32 version, string memory tag, string memory path)
        internal
    {
        p.setTarget(address(org), 0, selection, version, tag, path);
        IProjectPresentation.Config memory c = p.config(address(org), 0);
        assertEq(uint256(c.selection), uint256(selection));
        assertEq(c.version, version);
        assertEq(c.tag, tag);
        assertEq(c.path, path);
    }

    /// @dev Each selection reads exactly one of version and tag, or neither, and the other must be left empty, so a
    ///      stored target never carries a value the renderer ignores. Versions are numbered from 1.
    function test_setTargetRefusesAVersionOrTagItsSelectionDoesNotUse() public {
        _refused(LATEST, 1, "", "");
        _refused(LATEST, 0, "stable", "");
        _refused(LATEST, 1, "stable", "");
        _refused(VERSION, 0, "", "");
        _refused(VERSION, 1, "stable", "");
        _refused(VERSION, 0, "stable", "");
        _refused(TAG, 0, "", "");
        _refused(TAG, 1, "stable", "");
        _refused(TAG, 1, "", "");
        assertEq(p.config(address(org), 0).configuredFlags, 0, "a refused target changes nothing");
    }

    function test_setTargetAcceptsEachSelectionWithOnlyItsOwnValue() public {
        _accepted(LATEST, 0, "", "");
        assertEq(p.config(address(org), 0).configuredFlags, 1);
        _accepted(VERSION, 1, "", "index.html");
        _accepted(VERSION, type(uint32).max, "", "");
        _accepted(TAG, 0, "stable", "nested/index.html");
        _accepted(LATEST, 0, "", "index.html");
    }

    function _tag(string memory tag) internal {
        _accepted(TAG, 0, tag, "");
    }

    function _badTag(string memory tag) internal {
        _refused(TAG, 0, tag, "");
    }

    /// @dev A tag is 1..64 bytes of lowercase letters and digits, with `.`, `_` and `-` allowed after the first byte:
    ///      the hook's tag name shape (`^[a-z0-9][a-z0-9._-]{0,63}$`), so a target can name any tag a project has.
    function test_setTargetTagCharacterSet() public {
        _tag("a");
        _tag("z");
        _tag("0");
        _tag("9");
        _tag("v1.2.3");
        _tag("release_candidate-2");
        _tag("a.");
        _tag("x-_.");
        _tag(_repeat("a", 64));

        _badTag("");
        _badTag(_repeat("a", 65));
        _badTag(".a");
        _badTag("_a");
        _badTag("-a");
        _badTag("Stable");
        _badTag("staBle");
        _badTag("A");
        _badTag("Z");
        _badTag("v1 2");
        _badTag("a/b");
        _badTag("a+b");
        _badTag("a~b");
        _badTag("a:b");
        _badTag("a@b");
        _badTag("a`b");
        _badTag("a\x00b");
        _badTag("a\x7fb");
        _badTag(unicode"café");
        assertEq(p.config(address(org), 0).tag, _repeat("a", 64), "the last accepted tag stands");
    }

    function _segments(uint256 count, uint256 length) internal pure returns (string memory path) {
        for (uint256 i; i < count; ++i) {
            path = i == 0 ? _repeat("a", length) : string.concat(path, "/", _repeat("a", length));
        }
    }

    /// @dev A path is relative, 1..32 segments of 1..255 bytes, at most 2048 bytes in all, with no `.` or `..`
    ///      segment, backslash or control byte. Other names, dotted ones included, are names like any other.
    function test_setTargetPathRules() public {
        _accepted(LATEST, 0, "", "a/b/c");
        _accepted(LATEST, 0, "", ".well-known/x");
        _accepted(LATEST, 0, "", ".../..a/a..");
        _accepted(LATEST, 0, "", _segments(1, 255));
        _accepted(LATEST, 0, "", _segments(32, 1));
        _accepted(LATEST, 0, "", string.concat(_segments(7, 255), "/", _repeat("a", 254), "/a"));
        assertEq(bytes(p.config(address(org), 0).path).length, 2048);

        _refused(LATEST, 0, "", ".");
        _refused(LATEST, 0, "", "..");
        _refused(LATEST, 0, "", "a/./b");
        _refused(LATEST, 0, "", "a/..");
        _refused(LATEST, 0, "", "/a");
        _refused(LATEST, 0, "", "a/");
        _refused(LATEST, 0, "", "a//b");
        _refused(LATEST, 0, "", "/");
        _refused(LATEST, 0, "", "a\\b");
        _refused(LATEST, 0, "", "a\x00b");
        _refused(LATEST, 0, "", "a\x1fb");
        _refused(LATEST, 0, "", "a\x7fb");
        _refused(LATEST, 0, "", _segments(1, 256));
        _refused(LATEST, 0, "", _segments(33, 1));
        _refused(LATEST, 0, "", string.concat(_segments(8, 255), "/a"));
    }

    // ─── evaluate and ipfsUri answer only the presentation itself ───────────

    /// @dev Both are external only so `preview` can catch their failures through a self-call. Called by anyone else,
    ///      with any arguments, they refuse.
    function test_evaluateAndIpfsUriRefuseEveryCallerButThePresentation() public {
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.evaluate(address(org), 0);
        vm.prank(OTHER);
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.evaluate(address(org), 0);

        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.ipfsUri(bytes32(uint256(1)), true, true, "", "");
        vm.prank(OTHER);
        vm.expectRevert(IProjectPresentation.InvalidConfiguration.selector);
        p.ipfsUri(bytes32(uint256(1)), false, false, "index.html", "https://dweb.link");

        // Through the presentation's own call both answer.
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        (IProjectPresentation.Status status, bytes memory data) = _preview();
        assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
        assertEq(string(data), string.concat("ipfs://", CID, "/"));
    }

    // ─── A CID must be a base32 CIDv1 before it becomes a URI ───────────────

    function _replace(string memory s, uint256 at, bytes1 b) internal pure returns (string memory) {
        bytes memory out = bytes.concat(bytes(s));
        out[at] = b;
        return string(out);
    }

    function _malformedCids() internal pure returns (string[] memory m) {
        m = new string[](23);
        m[0] = "";
        m[1] = "b";
        m[2] = string(bytes.concat(bytes(CID), "a")); // one byte too long
        m[3] = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf35"; // one byte too short
        m[4] = _replace(CID, 0, "B"); // base32 upper multibase prefix
        m[5] = _replace(CID, 0, "z"); // base58btc multibase prefix
        m[6] = _replace(CID, 0, "f"); // base16 multibase prefix
        m[7] = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"; // CIDv0
        m[8] = _replace(CID, 30, "A");
        m[9] = _replace(CID, 58, "Z");
        m[10] = _replace(CID, 30, "0");
        m[11] = _replace(CID, 30, "1");
        m[12] = _replace(CID, 30, "8");
        m[13] = _replace(CID, 30, "9");
        m[14] = _replace(CID, 30, "/");
        m[15] = _replace(CID, 58, ".");
        m[16] = _replace(CID, 30, "@");
        m[17] = _replace(CID, 30, "?");
        m[18] = _replace(CID, 30, "#");
        m[19] = _replace(CID, 30, ":");
        m[20] = _replace(CID, 30, " ");
        m[21] = _replace(CID, 30, 0x00);
        m[22] = _replace(CID, 30, 0xff);
    }

    /// @dev The resolver is a dependency, and its answer is spliced into a URI (as `ipfs://<cid>` or as the host label
    ///      of `https://<cid>.ipfs.<gateway>`). Anything other than 59 bytes of `b` followed by base32 lowercase is
    ///      an IPFS failure: preview says IpfsFailed, render reverts RenderFailed, the method stays IPFS and no other
    ///      locator is substituted. This holds for a directory root and a file root, with and without a gateway.
    function test_aResolverAnswerThatIsNotABase32CidV1IsAnIpfsFailure() public {
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        string[] memory malformed = _malformedCids();
        for (uint256 round; round < 4; ++round) {
            reader.setDirectory(round % 2 == 0);
            p.setEndpoints(address(org), 0, "", round < 2 ? "" : "https://dweb.link");
            for (uint256 i; i < malformed.length; ++i) {
                ipfs.setCid(malformed[i]);
                (IProjectPresentation.Status status, string memory mime, bytes memory data) = p.preview(address(org), 0);
                assertEq(uint256(status), uint256(IProjectPresentation.Status.IpfsFailed), vm.toString(i));
                assertEq(mime, "text/plain");
                assertEq(data.length, 0);
                vm.expectRevert(
                    abi.encodeWithSelector(
                        IProjectPresentation.RenderFailed.selector, IProjectPresentation.Status.IpfsFailed
                    )
                );
                p.render(address(org), 0, "animation_url");
            }
            assertEq(uint256(p.config(address(org), 0).method), uint256(IProjectPresentation.Method.Ipfs));
        }
    }

    /// @dev The edges of the accepted alphabet: `a`..`z` and `2`..`7` after the `b` prefix.
    function test_aBase32CidV1IsUsedAsItIs() public {
        p.setMethod(address(org), 0, IProjectPresentation.Method.Ipfs);
        string memory edges = string.concat("b", _repeat("az27", 14), "za");
        assertEq(bytes(edges).length, 59);
        string[2] memory valid = [CID, edges];
        for (uint256 i; i < valid.length; ++i) {
            ipfs.setCid(valid[i]);
            p.setEndpoints(address(org), 0, "", "");
            (IProjectPresentation.Status status, bytes memory data) = _preview();
            assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
            assertEq(string(data), string.concat("ipfs://", valid[i], "/"));
            p.setEndpoints(address(org), 0, "", "https://dweb.link");
            (status, data) = _preview();
            assertEq(uint256(status), uint256(IProjectPresentation.Status.Ready));
            assertEq(string(data), string.concat("https://", valid[i], ".ipfs.dweb.link/"));
        }
    }

    function _repeat(string memory unit, uint256 n) internal pure returns (string memory s) {
        for (uint256 i; i < n; ++i) {
            s = string.concat(s, unit);
        }
    }
}
