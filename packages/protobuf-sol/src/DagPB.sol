// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Protobuf} from "./Protobuf.sol";

/// @title DagPB
/// @notice Serialize dag-pb PBNode and PBLink per IPLD spec.
///
/// @dev PBLink: field 1 Hash(bytes), field 2 Name(string), field 3 Tsize(uint64).
/// @dev PBNode: field 2 Links (repeated PBLink) BEFORE field 1 Data (bytes), the canonical dag-pb
///      order (IPLD dag-pb specification).
library DagPB {
    struct Link {
        bytes hash;   // binary CID bytes
        string name;
        uint256 tsize;
    }

    /// @dev Serialize a single PBLink: Hash(1), Name(2), Tsize(3).
    function encodeLink(Link memory link) internal pure returns (bytes memory out) {
        bytes memory a = Protobuf.encodeLengthDelimited(1, link.hash);
        bytes memory b = Protobuf.encodeLengthDelimited(2, bytes(link.name));
        bytes memory c = Protobuf.encodeVarintField(3, link.tsize);
        out = bytes.concat(a, b, c);
    }

    /// @dev Serialize a PBNode. Links first (field 2), then Data (field 1).
    ///      Links are emitted in the order given; for a directory the caller sorts them by name in
    ///      unsigned byte order.
    function encodeNode(Link[] memory links, bytes memory data) internal pure returns (bytes memory out) {
        // Encode each link into its own Links-field entry (field 2, length-delimited).
        bytes memory linksBytes;
        for (uint256 i = 0; i < links.length; i++) {
            bytes memory linkBlob = encodeLink(links[i]);
            linksBytes = bytes.concat(linksBytes, Protobuf.encodeLengthDelimited(2, linkBlob));
        }

        bytes memory dataField;
        if (data.length > 0) {
            dataField = Protobuf.encodeLengthDelimited(1, data);
        }

        out = bytes.concat(linksBytes, dataField);
    }
}
