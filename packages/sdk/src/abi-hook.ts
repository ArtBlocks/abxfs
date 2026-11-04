/**
 * `IProjectHook` — ABX FS project integrity, version history, and tags, as an ABX
 * configure hook. Generated from the Solidity interface; `test/abi-drift.test.ts` fails if
 * this drifts from `packages/contracts-projects/src/interfaces/IProjectHook.sol`.
 *
 * The ABX collection's own ABI is NOT hand-maintained here — it comes from
 * `@artblocks/abx-sdk/abi`, so there is nothing to keep in sync for the param surface.
 */
export const iProjectHookAbi = [
  {
    "type": "function",
    "name": "factory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTag",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "tag",
        "type": "string"
      }
    ],
    "outputs": [
      {
        "name": "version",
        "type": "uint256"
      },
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTagAt",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "index",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "tag",
        "type": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTagsRange",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "end",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "tags",
        "type": "string[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "globalPublishAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "org",
        "type": "address"
      },
      {
        "name": "orgIndex",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "globalPublishCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "globalPublishRange",
    "inputs": [
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "orgs",
        "type": "address[]"
      },
      {
        "name": "orgIndexes",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "kindOf",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "kind",
        "type": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "latestVersion",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "version",
        "type": "uint256"
      },
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "listTags",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "tags",
        "type": "string[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "publishAt",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "index",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IProjectHook.PublishRecord",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publisher",
            "type": "address"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "version",
            "type": "uint32"
          },
          {
            "name": "tokenId",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "publishCount",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "publishRange",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct IProjectHook.PublishRecord[]",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publisher",
            "type": "address"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "version",
            "type": "uint32"
          },
          {
            "name": "tokenId",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recentPublishes",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct IProjectHook.PublishRecord[]",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publisher",
            "type": "address"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "version",
            "type": "uint32"
          },
          {
            "name": "tokenId",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recentPublishesBefore",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "beforeIndex",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct IProjectHook.PublishRecord[]",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publisher",
            "type": "address"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "version",
            "type": "uint32"
          },
          {
            "name": "tokenId",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "removeTag",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "tag",
        "type": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTag",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "tag",
        "type": "string"
      },
      {
        "name": "version",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "tagCount",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "versionAt",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "version",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "record",
        "type": "tuple",
        "internalType": "struct IProjectHook.Version",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "publisher",
            "type": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "versionCount",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "versionsRange",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "end",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "records",
        "type": "tuple[]",
        "internalType": "struct IProjectHook.Version[]",
        "components": [
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "publishedAt",
            "type": "uint40"
          },
          {
            "name": "publisher",
            "type": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ProjectTagMoved",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "tag",
        "type": "string",
        "indexed": false
      },
      {
        "name": "fromVersion",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "toVersion",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProjectTagRemoved",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "tag",
        "type": "string",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProjectTagSet",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "tag",
        "type": "string",
        "indexed": false
      },
      {
        "name": "version",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProjectVersionPublished",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "version",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "cid",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false
      },
      {
        "name": "publisher",
        "type": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BlobTooLarge",
    "inputs": [
      {
        "name": "key",
        "type": "bytes32"
      },
      {
        "name": "length",
        "type": "uint256"
      },
      {
        "name": "max",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "IndexOutOfRange",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidTagName",
    "inputs": [
      {
        "name": "tag",
        "type": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidVersion",
    "inputs": [
      {
        "name": "version",
        "type": "uint256"
      },
      {
        "name": "versionCount",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoVersions",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotProjectOwner",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "caller",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "RangeOutOfBounds",
    "inputs": [
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "end",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReservedTag",
    "inputs": [
      {
        "name": "tag",
        "type": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "RootKindLocked",
    "inputs": [
      {
        "name": "expected",
        "type": "uint8"
      },
      {
        "name": "actual",
        "type": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "RootNotFound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "SameRoot",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "TagNotFound",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "tag",
        "type": "string"
      }
    ]
  }
] as const;

