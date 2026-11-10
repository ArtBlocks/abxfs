/** Solidity ABI; checked against its source by abi-drift.test.ts. */
export const contentReaderAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "directoryStore_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fileStore_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "directoryStore",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IDirectoryStore"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fileStore",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IFileStore"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "projectRoot",
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
        "name": "version",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tag",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "readFile",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "maxBytes",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxChunks",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "mimeType",
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
    "name": "readFileRange",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "start",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxBytes",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxChunks",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "mimeType",
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
    "name": "readPath",
    "inputs": [
      {
        "name": "root",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "path",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "maxBytes",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxChunks",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "mimeType",
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
    "name": "readProject",
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
        "name": "version",
        "type": "uint256",
        "internalType": "uint256"
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
        "name": "maxBytes",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxChunks",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "mimeType",
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
    "name": "resolve",
    "inputs": [
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
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "isDirectory",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "ByteLimitExceeded",
    "inputs": [
      {
        "name": "bytesRequired",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxBytes",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ChunkLimitExceeded",
    "inputs": [
      {
        "name": "chunksRequired",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxChunks",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CodecNotSupported",
    "inputs": [
      {
        "name": "codec",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "ConfigureHookNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidFileLength",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidProjectSelector",
    "inputs": []
  },
  {
    "type": "error",
    "name": "IsDirectory",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotDirectory",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "RangeOutOfBounds",
    "inputs": [
      {
        "name": "start",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "size",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "RootNotFound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "StoreMismatch",
    "inputs": []
  }
] as const;
