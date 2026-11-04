/**
 * `ProjectEnumeration` — the ABX transfer hook that indexes ownership on-chain.
 *
 * Generated from the Solidity contract; `test/abi-drift.test.ts` fails if this drifts from
 * `packages/contracts-projects/src/ProjectEnumeration.sol`.
 *
 * Mirrored from the CONTRACT rather than an interface because the views are the contract's own
 * surface — there is no `IProjectEnumeration` to implement, and inventing one solely to
 * generate an ABI would add a file that could itself drift.
 */
export const iProjectEnumerationAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "factory_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "balanceOfTracked",
    "inputs": [
      {
        "name": "collection",
        "type": "address"
      },
      {
        "name": "owner",
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
    "name": "onTokenTransfer",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "name": "from",
        "type": "address"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "orgsHeldBy",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "orgsHeldCount",
    "inputs": [
      {
        "name": "owner",
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
    "name": "orgsHeldSlice",
    "inputs": [
      {
        "name": "owner",
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
        "name": "window",
        "type": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokenOfOwnerByIndex",
    "inputs": [
      {
        "name": "collection",
        "type": "address"
      },
      {
        "name": "owner",
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
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokensOfOwner",
    "inputs": [
      {
        "name": "collection",
        "type": "address"
      },
      {
        "name": "owner",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokensOfOwnerSlice",
    "inputs": [
      {
        "name": "collection",
        "type": "address"
      },
      {
        "name": "owner",
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
        "name": "window",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "trackedOwnerOf",
    "inputs": [
      {
        "name": "collection",
        "type": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  }
] as const;
