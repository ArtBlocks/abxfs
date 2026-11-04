/**
 * ABIs of the ABX FS content layer (`packages/contracts-core`) and the IPFS resolver (`packages/contracts-companion`).
 *
 * The content ABIs are generated from the compiled contracts (`forge inspect <contract> abi --json`) and checked by
 * `test/abi-drift.test.ts`, so a contract change that is not mirrored here fails a test instead of shipping.
 */

export const storageBackendAbi = [
  {
    "type": "function",
    "name": "maxInputSize",
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
    "name": "readable",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "retrieval",
    "inputs": [],
    "outputs": [
      {
        "name": "scheme",
        "type": "bytes32"
      },
      {
        "name": "instructions",
        "type": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "retrieve",
    "inputs": [
      {
        "name": "pointer",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "data",
        "type": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "store",
    "inputs": [
      {
        "name": "input",
        "type": "bytes"
      },
      {
        "name": "caller",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "pointer",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "error",
    "name": "NotEvmReadable",
    "inputs": []
  }
] as const;

export const chunkStoreAbi = [
  {
    "type": "function",
    "name": "chunkId",
    "inputs": [
      {
        "name": "backend",
        "type": "address"
      },
      {
        "name": "inputHash",
        "type": "bytes32"
      },
      {
        "name": "dataHash",
        "type": "bytes32"
      },
      {
        "name": "size",
        "type": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "exists",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "multicall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes[]"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "read",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "data",
        "type": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recordOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "backend",
        "type": "address"
      },
      {
        "name": "size",
        "type": "uint48"
      },
      {
        "name": "pointer",
        "type": "bytes32"
      },
      {
        "name": "dataHash",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sizeOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "write",
    "inputs": [
      {
        "name": "backend",
        "type": "address"
      },
      {
        "name": "input",
        "type": "bytes"
      },
      {
        "name": "dataHash",
        "type": "bytes32"
      },
      {
        "name": "size",
        "type": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "ChunkWritten",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "backend",
        "type": "address",
        "indexed": true
      },
      {
        "name": "pointer",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "inputHash",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "dataHash",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "size",
        "type": "uint48",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "ChunkNotFound",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "DataMismatch",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "EmptyChunk",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidBackend",
    "inputs": [
      {
        "name": "backend",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "RetrieveFailed",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "backend",
        "type": "address"
      }
    ]
  }
] as const;

export const fileStoreAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "chunkStore_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "chunkCount",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
    "name": "chunkStore",
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
    "name": "createFile",
    "inputs": [
      {
        "name": "rootNode",
        "type": "bytes32"
      },
      {
        "name": "mimeType",
        "type": "string"
      },
      {
        "name": "codec",
        "type": "bytes32"
      },
      {
        "name": "outputHash",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "fileCid",
    "inputs": [
      {
        "name": "rootNode",
        "type": "bytes32"
      },
      {
        "name": "mimeType",
        "type": "string"
      },
      {
        "name": "codec",
        "type": "bytes32"
      },
      {
        "name": "outputHash",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "fileExists",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getChunkId",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getChunkIds",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
        "name": "out",
        "type": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getFileInfo",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "info",
        "type": "tuple",
        "internalType": "struct IFileStore.FileInfo",
        "components": [
          {
            "name": "root",
            "type": "bytes32"
          },
          {
            "name": "rootLevel",
            "type": "uint8"
          },
          {
            "name": "chunkCount",
            "type": "uint256"
          },
          {
            "name": "size",
            "type": "uint256"
          },
          {
            "name": "mimeType",
            "type": "string"
          },
          {
            "name": "codec",
            "type": "bytes32"
          },
          {
            "name": "outputHash",
            "type": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getNode",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "blob",
        "type": "bytes"
      },
      {
        "name": "level",
        "type": "uint8"
      },
      {
        "name": "count",
        "type": "uint32"
      },
      {
        "name": "size",
        "type": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "locateByte",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      },
      {
        "name": "offset",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "index",
        "type": "uint256"
      },
      {
        "name": "chunkStart",
        "type": "uint256"
      },
      {
        "name": "chunkId",
        "type": "bytes32"
      },
      {
        "name": "chunkSize",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "multicall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes[]"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "nodeExists",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "putChunkNode",
    "inputs": [
      {
        "name": "blob",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "readChunk",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "FileCreated",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "root",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "mimeType",
        "type": "string",
        "indexed": false
      },
      {
        "name": "codec",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "outputHash",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "chunkCount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "size",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "NodeCreated",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "level",
        "type": "uint8",
        "indexed": false
      },
      {
        "name": "count",
        "type": "uint32",
        "indexed": false
      },
      {
        "name": "size",
        "type": "uint48",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadNode",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BytesMismatch",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ChunkSizeMismatch",
    "inputs": [
      {
        "name": "chunkId",
        "type": "bytes32"
      },
      {
        "name": "recorded",
        "type": "uint256"
      },
      {
        "name": "claimed",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CountMismatch",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "DataSize",
    "inputs": [
      {
        "name": "size",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FileNotFound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
    "name": "InvalidCodec",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMimeType",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LevelMismatch",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      },
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
    "name": "NoChunkStore",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoFreeAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NodeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NodeMissing",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NodeTooLarge",
    "inputs": [
      {
        "name": "size",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "OffsetOutOfRange",
    "inputs": [
      {
        "name": "offset",
        "type": "uint256"
      },
      {
        "name": "size",
        "type": "uint256"
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
  }
] as const;

export const directoryStoreAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "fileStore_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "EMPTY_DIRECTORY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createDirectory",
    "inputs": [
      {
        "name": "rootNode",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "directoryCid",
    "inputs": [
      {
        "name": "rootNode",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "directoryExists",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "entryCount",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
    "name": "fileStore",
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
    "name": "getEntries",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
        "name": "out",
        "type": "tuple[]",
        "internalType": "struct IDirectoryStore.Entry[]",
        "components": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "isDirectory",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEntry",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
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
        "internalType": "struct IDirectoryStore.Entry",
        "components": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "cid",
            "type": "bytes32"
          },
          {
            "name": "isDirectory",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getNode",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "blob",
        "type": "bytes"
      },
      {
        "name": "level",
        "type": "uint8"
      },
      {
        "name": "count",
        "type": "uint32"
      },
      {
        "name": "size",
        "type": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lookup",
    "inputs": [
      {
        "name": "dirCid",
        "type": "bytes32"
      },
      {
        "name": "name",
        "type": "string"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32"
      },
      {
        "name": "isDirectory",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "multicall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes[]"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "nodeExists",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "putEntryNode",
    "inputs": [
      {
        "name": "blob",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "resolvePath",
    "inputs": [
      {
        "name": "rootCid",
        "type": "bytes32"
      },
      {
        "name": "path",
        "type": "string"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes32"
      },
      {
        "name": "isDirectory",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rootOf",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "DirectoryCreated",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "root",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "entryCount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "NodeCreated",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "level",
        "type": "uint8",
        "indexed": false
      },
      {
        "name": "count",
        "type": "uint32",
        "indexed": false
      },
      {
        "name": "size",
        "type": "uint48",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadNode",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BytesMismatch",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CidNotFound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "CountMismatch",
    "inputs": [
      {
        "name": "index",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "DataSize",
    "inputs": [
      {
        "name": "size",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "DirectoryNotFound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "EntriesNotSorted",
    "inputs": []
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
    "name": "InvalidName",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LevelMismatch",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      },
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
    "name": "NoFileStore",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoFreeAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NodeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NodeMissing",
    "inputs": [
      {
        "name": "nodeId",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NodeTooLarge",
    "inputs": [
      {
        "name": "size",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "OffsetOutOfRange",
    "inputs": [
      {
        "name": "offset",
        "type": "uint256"
      },
      {
        "name": "size",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "PathNotFound",
    "inputs": [
      {
        "name": "path",
        "type": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "PathTooDeep",
    "inputs": [
      {
        "name": "depth",
        "type": "uint256"
      },
      {
        "name": "maxDepth",
        "type": "uint256"
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
  }
] as const;

export const iIpfsCidResolverAbi = [
  {
    "type": "function",
    "name": "computeFileCid",
    "inputs": [
      {
        "name": "fileCid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "ipfsCid",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "computeIpfsCid",
    "inputs": [
      {
        "name": "directoryCid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "ipfsCid",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "directoryLink",
    "inputs": [
      {
        "name": "directoryCid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "codec",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tsize",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fileLink",
    "inputs": [
      {
        "name": "fileCid",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "codec",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tsize",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "BadReturn",
    "inputs": []
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
    "name": "DirectoryNeedsSharding",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "estimate",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "DirectoryNotFound",
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
    "name": "FileNotFound",
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
    "name": "SizeMismatch",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "expected",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "read",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "StoreMismatch",
    "inputs": []
  }
] as const;

