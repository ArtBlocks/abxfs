/** Solidity ABI; checked against its source by abi-drift.test.ts. */
export const iProjectPresentationAbi = [
  {
    "type": "function",
    "name": "config",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IProjectPresentation.Config",
        "components": [
          {
            "name": "selection",
            "type": "uint8",
            "internalType": "enum IProjectPresentation.Selection"
          },
          {
            "name": "method",
            "type": "uint8",
            "internalType": "enum IProjectPresentation.Method"
          },
          {
            "name": "locks",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "version",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "frozenRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "tag",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "path",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "chainBase",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "ipfsBase",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lock",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "mask",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "expectedCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "lockCommitment",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "mask",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "preview",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "status",
        "type": "uint8",
        "internalType": "enum IProjectPresentation.Status"
      },
      {
        "name": "contentType",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "render",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "field",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "contentType",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setEndpoints",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "chainBase",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "ipfsBase",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMethod",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "method",
        "type": "uint8",
        "internalType": "enum IProjectPresentation.Method"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTarget",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "selection",
        "type": "uint8",
        "internalType": "enum IProjectPresentation.Selection"
      },
      {
        "name": "version",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "path",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "target",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "root",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "path",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EndpointsChanged",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MethodChanged",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "method",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum IProjectPresentation.Method"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PresentationLocked",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "locks",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "frozenRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TargetChanged",
    "inputs": [
      {
        "name": "org",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidConfiguration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidOrg",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Locked",
    "inputs": [
      {
        "name": "dimension",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotProjectOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleCommitment",
    "inputs": [
      {
        "name": "expected",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "actual",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  }
] as const;
