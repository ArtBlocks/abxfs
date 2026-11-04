// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectCard} from "../../src/ProjectCard.sol";
import {ProjectHook} from "../../src/ProjectHook.sol";
import {MockStore, MockAbxToken} from "../mocks/Mocks.sol";

/// @dev Writes real renderer output to `out/preview-*.svg` so the card can be reviewed by eye.
///      Not an assertion suite — `forge test --match-contract Preview` is a dev affordance.
contract PreviewTest is Test {
    function test_WritePreviews() public {
        MockStore dirStore = new MockStore();
        MockStore fileStore = new MockStore();
        ProjectHook hook = new ProjectHook(address(dirStore), address(fileStore), address(0));
        ProjectCard card = new ProjectCard(address(hook));
        MockAbxToken token = new MockAbxToken(address(hook));

        address alice = address(0xA11CE);
        token.setOwner(1, alice);
        token.setOwner(2, alice);

        bytes32 cidA = keccak256("dir-a");
        bytes32 cidB = keccak256("another-project-root");
        dirStore.add(cidA);
        dirStore.add(cidB);

        // 1: published, three versions.
        vm.startPrank(alice);
        token.configure(1, "abxfs.cid", cidA);
        token.configure(1, "abxfs.cid", cidB);
        token.configure(1, "abxfs.cid", cidA);
        token.configureData(1, "abxfs.name", "my-cool-art");

        // 2: published once, long name to show truncation.
        token.configure(2, "abxfs.cid", cidB);
        token.configureData(2, "abxfs.name", "a-very-long-project-name-that-will-not-fit");
        vm.stopPrank();

        _write(card, address(token), 1, "out/preview-published.svg");
        _write(card, address(token), 2, "out/preview-truncated.svg");
        _write(card, address(token), 3, "out/preview-unpublished.svg");
        _write(card, address(token), type(uint256).max, "out/preview-collection.svg");
    }

    function _write(ProjectCard card, address token, uint256 tokenId, string memory path)
        internal
    {
        (, bytes memory data) = card.render(token, tokenId, "image");
        vm.writeFile(path, string(data));
    }
}
