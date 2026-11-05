# ABX FS: the content layer

Status: **specified, implemented, and deployed** (build `abx-fs-freeze-3`) on production networks and their testnets,
at the addresses in `packages/sdk/src/canonical.ts`. The project and org layer built on top of it is [`abx-fs-orgs.md`](./abx-fs-orgs.md).

Solidity comments cite sections of this document by number (§3, §4, §5, §6, §8). Those comments are part of each
contract's address (§1, principle 8), so keep the numbering.

## 1. Principles

1. **Content addressing.** Every chunk, node, file and directory is named by a keccak256 hash of its full definition.
   An id can only ever be satisfied by one byte string, whatever backend holds it.
2. **Pluggable storage.** A storage backend is any contract. It decides where a chunk's bytes live and whether the EVM
   can read them back. Nothing registers backends. The backend's address is part of every chunk id, so no backend can
   affect content stored through another.
3. **Integrity is checked wherever it can be.** The chain checks a chunk's bytes at write time and on every read when its
   backend is EVM-readable. Otherwise the chunk's claims are bound into its id and a reader of that backend checks
   them. Integrity never depends on how a backend behaves.
4. **Availability is declared, never certified.** Backends say whether and how their bytes can be read (`readable()`,
   `retrieval()`). Any backend can stop serving at any time; what an id means can never change.
5. **Self-sovereign configuration.** A backend per chunk, an off-chain codec per file, a link override per project. The
   SDK recommends defaults; the protocol only permits.
6. **No roles, no registries, no ETH.** No contract has an owner, admin, registrar or upgrade path, and none accepts
   ETH.
7. **Neutral names in code.** Contracts carry no brand (`ChunkStore`, `OrgFactory`, …). Comments and user-visible
   strings say ABX FS.
8. **Addresses depend on the exact source.** Every contract is deployed with CREATE2 through the keyless deployer
   (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a fixed salt and no sender-dependent constructor argument, so
   any key deploys it at the same address on every chain. The build keeps solc's metadata hash, so the bytecode commits
   to the exact source text (comments and NatSpec included), the source paths and the remappings: NatSpec is frozen
   with the code, and Sourcify can report an exact match. Consequences:
   - every edit to a contract's source, a comment included, moves its address;
   - every `foundry.toml` sets `auto_detect_remappings = false`, because auto-detection adds absolute paths of the
     checkout to the metadata;
   - the Solidity package folder names and remapping names are frozen at deployment.

   Tests pin the predicted addresses, so any such change fails loudly.

## 2. Layers and contracts

| Layer | Contracts | Role |
| --- | --- | --- |
| Chunks | `ChunkStore`, `IStorageBackend`, `Sstore2Backend`, `FastLzSstore2Backend` | content-addressed chunk records; bytes live in backends |
| Index | `NodeTree` (abstract), `FileStore`, `DirectoryStore` | trees of immutable nodes listing chunks and entries |
| IPFS | `IpfsCidResolver` | view-only IPFS CIDv1 derivation from on-chain content |
| Projects and orgs | `OrgFactory`, `OrgMeta`, `OrgMinter`, `ProjectHook`, `ProjectEnumeration`, `ProjectCard`, `ProjectTraits`, `ProjectLinks`, `Lens` | [`abx-fs-orgs.md`](./abx-fs-orgs.md) |

Hash prefixes:

| Prefix | Hash |
| --- | --- |
| `0x30` | chunk id |
| `0x31` | file CID |
| `0x32` | directory CID |
| `0x41` | chunk node id |
| `0x42` | entry node id |

CREATE2 salts:

| Salt | Contracts |
| --- | --- |
| `keccak256("abx-fs/content")` | `ChunkStore`, `Sstore2Backend`, `FastLzSstore2Backend`, `FileStore`, `DirectoryStore` |
| `keccak256("abx-fs/ipfs-cid-resolver")` | `IpfsCidResolver` |
| `keccak256("abx-fs/org-meta")` | `OrgMeta` |
| `keccak256("abx-fs/org-factory")` | `OrgFactory` |
| `keccak256("abx-fs/org-components")` | the factory's five components (`ProjectHook`, `ProjectEnumeration`, `OrgMinter`, `ProjectCard`, `ProjectTraits`), at addresses the factory computes (`COMPONENT_SALT`) |
| `keccak256("abx-fs/lens")` | `Lens` |

## 3. Storage backends

```solidity
interface IStorageBackend {
    /// Thrown by `retrieve` when the backend is not EVM-readable.
    error NotEvmReadable();

    /// Store `input` and return an opaque pointer that this backend resolves later. May revert to refuse. `caller` is
    /// the account that called `ChunkStore.write`; a backend that acts on it must check `msg.sender` is the ChunkStore.
    function store(bytes calldata input, address caller) external returns (bytes32 pointer);

    /// Whether `retrieve` returns a chunk's bytes from chain state.
    function readable() external view returns (bool);

    /// The chunk's bytes, after any decoding this backend performs (e.g. FastLZ inflation).
    /// MUST revert `NotEvmReadable()` when `readable()` is false.
    function retrieve(bytes32 pointer) external view returns (bytes memory data);

    /// Best-effort, untrusted description of how to fetch this backend's bytes off chain.
    /// `scheme` is a lowercase ASCII token, left-aligned and zero-padded (SDK convention, e.g. "evm").
    function retrieval() external view returns (bytes32 scheme, string memory instructions);

    /// The largest `input` `store` accepts. For planners only: `ChunkStore` does not call it.
    function maxInputSize() external view returns (uint256);
}
```

- Anyone can deploy a backend and use it immediately. Backends may compress, may hold bytes in state, in logs, in
  blobs or elsewhere, and may change behaviour at any time (any code can).
- **Only `ChunkStore` ever calls a backend.** The index stores, the hook and the renderers never do.
- Backend schemes and their read procedures are documented per backend and implemented as SDK readers. A reader is
  safe to apply to any backend that declares a scheme it knows, because the result is checked against the chunk's
  claims.

### Launch backends

Both are readable, store `0x00 ‖ input` as contract code through CREATE2 (a leading STOP so the code cannot run), and
accept 1 to 24,575 bytes of input (the EIP-170 limit minus the STOP byte). The cap is a constant, not a constructor
argument, so each backend has the same address on every chain. A chain with a larger code limit gets a further backend
at its own address.

| Backend | `retrieve` returns | Use |
| --- | --- | --- |
| `Sstore2Backend` | the stored bytes | media and anything incompressible; data a file codec already compressed |
| `FastLzSstore2Backend` | `LibZip.flzDecompress(stored bytes)` (Solady) | compressible text: stored compressed, inflated on chain on every read |

Pointer placement (`CodeStore`, shared with the index stores): one CREATE2 whose init code carries the data, under
salt 0, then 1, … up to 7.

- An address that already holds exactly `0x00 ‖ input` is reused. CREATE2 commits to the init code, so only this
  deployer could have put it there.
- An address holding anything else (planted code, an EIP-7702 delegation) is skipped. Getting code there needs a key
  for a CREATE2 address of chosen data, about 2^80 work.
- Occupancy is checked **before** deploying, because a CREATE2 into an occupied address does not fail cheaply: it
  behaves like an invalid opcode in the new contract and consumes the 63/64 of the remaining gas forwarded to it.
  Content addressing makes re-writing existing data the common case (re-uploads, shared libraries, resumed uploads),
  so the check is what makes deduplication free.
- What remains: an account with a nonce but no code at a candidate address cannot be seen from the EVM, and deploying
  onto it reverts the call. That needs the same 2^80 attack and denies only the one data string it targets.
- A single CREATE2 rather than Solady's CREATE3 saves one contract creation per chunk and per node.

FastLZ only references back 8 KiB (`0x1fff`), so compressing each chunk on its own costs almost nothing against
compressing the whole file. The SDK picks the raw backend for any chunk FastLZ would not shrink.

## 4. ChunkStore

A chunk's id binds the backend, the exact input given to it, and the claimed hash and size of the chunk's data (what
`retrieve` returns, or what an off-chain reader obtains by following the backend's scheme):

```
id = keccak256(0x30 ‖ backend:20 ‖ keccak256(input):32 ‖ dataHash:32 ‖ size:6)
```

`write(address backend, bytes input, bytes32 dataHash, uint48 size) → bytes32 id`:

1. `backend` must have code (`InvalidBackend`); `size` must be at least 1 (`EmptyChunk`).
2. Compute `id`. If a record exists, return `id` without calling the backend (dedup).
3. `pointer = backend.store(input, msg.sender)`. The call is untrusted and may re-enter; if a record for `id` now exists, it stands
   and `id` is returned.
4. If `backend.readable()`: read `data = backend.retrieve(pointer)` and require `keccak256(data) == dataHash` and
   `data.length == size` (`DataMismatch`). This is the write-time check: a readable chunk is recorded only after the
   chain has seen its data.
5. Store the record and emit `ChunkWritten(id, backend, pointer, keccak256(input), dataHash, size)`.

The record is three slots:

| Slot | Contents | Read by |
| --- | --- | --- |
| 0 | `backend` (160 bits) ‖ `size` (48) | every read; `FileStore` leaf checks |
| 1 | `pointer` | every read |
| 2 | `dataHash` | every read's check |

A reader trusts the RPC it reads through, as any dapp does; the contracts check what an honest node returns. The record
does not keep `keccak256(input)`. Binding a record to its id off chain would only help a reader that also checked the
file's chunk-id list against its root, node by node; a reader that trusts its RPC for that list gains nothing from
checking the last hop, and the slot would cost every chunk about 22k gas. The input hash is in `ChunkWritten` for anyone
recomputing ids from logs.

Also not stored: a readable flag (the backend answers live) and a block number (a backend that needs one for retrieval
puts it in its own pointer).

Reads:

- `read(id) → bytes`: a raw `staticcall` to `retrieve(pointer)` with the result hand-decoded. Any failure or malformed
  result reverts `RetrieveFailed(id, backend)`, so a caller can ask that backend's `retrieval()` what to do instead.
  The result must match the record's `dataHash` and `size` (`DataMismatch`).
- `exists(id)`, `sizeOf(id)` (reverts `ChunkNotFound`), `recordOf(id) → (backend, size, pointer, dataHash)`.

Why the claims cannot be abused: for a readable backend the chain checks them. For any other backend a false claim only
produces an id that no honest writer would compute, because the input hash and the claims are both inside it: nobody can
occupy an id someone else will use with different bytes or different claims.

`ChunkStore` inherits Solady `Multicallable` (which refuses ETH) and accepts no ETH anywhere. A backend that charges for
storage holds its own deposit.

## 5. Index: FileStore and DirectoryStore

A file or directory is a **tree of nodes**, built bottom-up over any number of transactions and bound by one finalising
call. A node is one immutable blob, created by any caller in any order and identified by the hash of its bytes; there
is no builder state, no owner and nothing to resume except "which nodes exist?", and creating an existing node is a
no-op.

**Nodes.** `nodeId = keccak256(prefix ‖ blob)`, blob 1 to 24,575 bytes, levels 0 to 3. Each node is one storage slot
(`pointer:160 ‖ level:8 ‖ count:32 ‖ bytes:48`: the total leaf items under it and, for files, the total data bytes).
The store writes each blob itself through `CodeStore` (§3), never through a backend, so a node id can only ever map to
the bytes that hash to it, and the index is always readable on chain. The chain reads the index to validate new nodes
(counts, byte totals, name order), answer lookups and byte seeks in one call, and let the hook confirm a root exists.
The 24,575-byte cap limits a node only, never a chunk or a file. `NodeCreated(nodeId, level, count, size)`.

**Branch** (`level k ≥ 1`, both kinds): `k ‖ n:2 ‖ (childId:32 ‖ cumulativeCount:4 [‖ cumulativeBytes:6]) × n`,
`2 ≤ n ≤ 128` (a one-child wrapper would give one object many CIDs). `cumulativeBytes` is present in file branches only.
Every child must exist with `level == k − 1`, and the cumulative fields must match the children's own totals
(`CountMismatch`, `BytesMismatch`).

### Files

**Chunk leaf** (`level 0`): `0x00 ‖ (chunkId:32 ‖ size:6) × n`, `1 ≤ n ≤ 646`. Every `chunkId` must exist in
`ChunkStore` with exactly that `size` (`ChunkSizeMismatch`). Any backend is accepted. Because sizes are recorded and
branches carry cumulative bytes, `locateByte` finds the chunk holding any offset in one descent and `getFileInfo`
reports the length before any chunk is read.

`putChunkNode(bytes blob) → nodeId`, idempotent.

`createFile(bytes32 rootNode, string mimeType, bytes32 codec, bytes32 outputHash) → cid`:

- `mimeType` 1..127 bytes, describing the file's final content.
- `codec == 0` if and only if `outputHash == 0` (§6, `InvalidCodec`).
- `rootNode == 0` is the **empty file**: zero chunks, zero bytes. It requires `codec == 0`.
- `cid = keccak256(0x31 ‖ rootNode ‖ keccak256(mimeType) ‖ codec ‖ outputHash)`.
- Existence is recorded explicitly, because the root may be zero. `codec` and `outputHash` are written only when non-zero.

Reads: `fileExists`, `getFileInfo` (root, root level, chunk count, `size` = total bytes of the joined chunk data, mime,
codec, outputHash), `chunkCount`, `getChunkId`, `getChunkIds(cid, start, end)` (callers page), `locateByte(cid, offset)
→ (index, chunkStart, chunkId, chunkSize)`, `readChunk(cid, i)` (through `ChunkStore.read`), `getNode`, `nodeExists`.

### Directories

**Entry leaf** (`level 0`): `0x00 ‖ count:2 ‖ offset:2 × count ‖ records`, record = `nameLen:1 ‖ name ‖ isDirectory:1 ‖
cid:32`, offsets measured from the start of the records area. Validation, exactly:

- `count ≥ 1`; records are consumed exactly (no trailing bytes, no `nameLen` overrun); offsets match.
- Names are 1..255 bytes, not `.` or `..`, with no `/` and no `\`. Nothing else is checked: NUL, control characters
  and invalid UTF-8 are allowed. A name is bytes, so readers must decode it as bytes (the ABI types it `string`, and a
  default UTF-8 decoder drops a leading U+FEFF and turns invalid sequences into U+FFFD, which renames entries and
  merges distinct ones). The SDK carries the exact bytes and shows a name as its UTF-8 text with `\xHH` for each byte
  that is not part of a well-formed sequence; since no name holds a `\`, that text form maps back to exactly one name.
- Names strictly increase in unsigned byte order, a shorter prefix first, so duplicates are impossible
  (`EntriesNotSorted`).
- `isDirectory` is exactly 0 or 1. A file child must exist in the `FileStore` this store was built over; a directory
  child must exist in this store (`CidNotFound`).

An **entry branch** additionally requires order across children: the store reads each child's first and last name
(descending at most the tree's depth) and requires `last(child_i) < first(child_{i+1})`. Names are therefore not stored
in branches.

`putEntryNode(bytes blob) → nodeId`, idempotent.

`createDirectory(bytes32 rootNode) → cid`, `cid = keccak256(0x32 ‖ rootNode)`. `rootNode == 0` is the **empty
directory**, `EMPTY_DIRECTORY`, which exists without being created.

Reads: `directoryExists`, `rootOf`, `entryCount`, `getEntry`, `getEntries(cid, start, end)` (callers page),
`lookup(cid, name)` (binary search over each level, then the leaf), `resolvePath(root, path)` (at most 32 segments per
call; readers chain calls from the directory the last one ended at), `getNode`, `nodeExists`.

### Rules

- **Existence means complete.** `fileExists` / `directoryExists` implies every node, chunk record and child existed when
  it was created. Chunk data was checked on chain at write time when its backend was readable; otherwise only its
  claims are bound.
- **Immutable, ownerless, permissionless and idempotent.** A node created by anyone is byte-identical to the one anyone
  else would create, so there is nothing to squat.
- **No calls to untrusted code.** The index stores call only the immutable `ChunkStore` and each other, never a
  backend.
- **Packing is a client convention, not a contract rule.** The contracts accept any valid tree. A different packing of
  the same content is a different CID.

### Canonical packing (SDK: `packages/sdk/src/node-gas.ts`, `chunking/`)

The SDK packs deterministically, so identical content yields identical CIDs. Every constant below is part of every
CID: changing one forks the content-address space.

**Chunk boundaries** are content-defined (FastCDC over the file's data, which is the encoded stream when there is a
codec), with parameters minimum 12,287, target 18,431 and maximum 24,575 (half, three quarters and all of the
backends' input cap), and the gear table and masks fixed in `packages/sdk/src/chunking/`. Exactly: the rolling hash
starts afresh at offset `min` of each chunk, `h = ((h << 1) ^ gear[byte]) mod 2^32`, and a chunk ends AFTER the byte at
which the hash's LOW bits are all zero: the low 15 bits before offset `target`, the low 13 bits from there on, and
otherwise at `max`. The cut includes the matching byte, so a chunk that is not a file's last is at least 12,288 bytes
(with this gear table no single byte matches the 15-bit mask from a fresh hash, so the shortest that occurs is 12,289);
a remainder of at most 12,287 bytes is one final chunk. An edit changes the chunks around it; the rest
deduplicate against what is already stored.

**Node boundaries** are content-defined too (the idea of prolly trees): a node ends after an item whose hash falls under
a threshold, between a minimum and a maximum. Filling nodes front to back would make one inserted entry or chunk shift
every later node, so adding one file near the start of a 50,000-entry directory would rewrite every leaf after it. With
content-defined boundaries an edit rewrites the leaf it lands in (rarely its neighbour too) and one branch per level
above it.

| Node | Ends after an item when | Minimum | Maximum |
| --- | --- | --- | --- |
| chunk leaf | top 32 bits of the chunk id < 2^32 / 128 | 32 records | 512 records (the contracts accept 646) |
| entry leaf | top 32 bits of `keccak256(name)` < `recordBytes × 2^32 / 4096`, `recordBytes = 36 + nameLen` | a 4,096-byte blob | 24,575 bytes, or the frozen packing cost below 7,000,000 |
| branch | top 32 bits of the child's node id < 2^32 / 32 | 2 children | 128 children |

- An entry's key is its NAME only, so changing a file's contents (its CID) never moves a boundary: it rewrites one leaf.
- Entry boundaries are weighted by record bytes, so the expected leaf is about 8 KB whatever the names.
- The entry-leaf maximum uses a FROZEN cost model, `75,000 + 205 × blobBytes + 11,000 × records + 170 × nameBytes`
  (`ENTRY_LEAF_PACKING`). It is a separate copy of the tunable gas estimate (`NODE_GAS`) and must never be edited to
  track a measurement.
- A trailing branch of one child joins the branch before it or, if that one is full, takes one child from it (127 then
  2), because the contracts refuse one-child branches.
- Typical content is one leaf: a directory with under about 4 KB of records (about 70 entries with 20-byte names), a
  file of under 32 chunks.
- Capacity: the level cap is 3. At the expected sizes (about 160 records per chunk leaf, about 34 children per
  branch) three levels hold about 39,000 leaves: about 6M entries, or 6M chunks (about 100 GB). Because boundaries come
  from hashes, the levels a tree needs depend on its ids, not only its size: the top level must be ONE branch, so a
  tree a few times smaller can occasionally need a fourth level. The planner checks the packed tree and refuses past
  the cap before anything is sent.

`packages/sdk/test/nodes.test.ts` pins the vectors and measures edit locality; `GoldenVectors.t.sol` re-derives the
same boundaries independently in Solidity and must produce the same node ids.

### Gas

Measured with `forge test --isolate` (every call its own transaction, so cold), under the pre-EIP-8037 schedule:

| Node | Gas |
| --- | --- |
| chunk leaf, 646 records (24,549 bytes, the contract maximum) | 13.1M |
| entry leaf, 300 entries with 9-byte names | 5.3M |
| entry leaf, 84 entries with 255-byte names (blob at the 24,575-byte limit) | 9.4M |
| branch, 128 children | 4.2M |

Each fits under the 2^24 per-transaction gas cap, so the SDK sends one node per transaction, or several small ones
through `multicall`. Under EIP-8037 (Glamsterdam), state creation (code bytes, new slots, contract creation) is
repriced into a separate state-gas dimension that the cap does not cover; the SDK prices writes per chain's schedule
(§11). Simulated on Sepolia (EIP-8037) and Ethereum mainnet (old schedule) with `eth_simulateV1`, 2026-10-29:

| Write | Old schedule | EIP-8037 total | of which state |
| --- | --- | --- | --- |
| chunk, 24,575 bytes raw | 5.6M | 38.7M | 38.1M |
| chunk, 500 bytes raw | 0.25M | 1.34M | 1.24M |
| chunk leaf, 646 records (contract maximum) | 10.9M | 43.8M | 37.8M |
| chunk leaf, 512 records (SDK maximum) | 8.6M | 34.8M | 30.1M |
| entry leaf, 60 entries with 255-byte names | 9.8M | 33.3M | 27.0M |
| directory branch, level 3, 128 children with 255-byte edge names | 13.0M | 19.8M | 7.3M |
| `createFile` (127-byte MIME type and a codec) | 0.21M | 0.91M | 0.78M |
| `createDirectory` | 0.05M | 0.13M | 0.10M |

Every write fits one transaction under both schedules: under EIP-8037 the execution part stays under 2^24 and the
total under a 60M block.

## 6. File-level codecs (off chain)

Two decoding steps, each pinned by a hash:

- **Per chunk, by the backend** (e.g. FastLZ): pinned by `dataHash` and checked by the chain for readable backends.
- **Per file, by the reader** (e.g. gzip): the file's *data* is its chunks joined; its *content* is
  `decode(codec, data)`, and readers MUST check `keccak256(content) == outputHash`.

`codec` is a `bytes32` lowercase ASCII token, left-aligned and zero-padded; zero means none. The convention is the IANA
HTTP Content Coding registry (`gzip`, `br`, `zstd`, `deflate`, …), so a gateway that has checked a file can pass the
stored bytes through with `Content-Encoding`. Readers refuse a token they do not know. The contract enforces only the
zero rule. The CLI and the site offer only `gzip`, the one codec every reader decodes natively (browsers and the
gateway through the Compression Streams API, Node through `node:zlib`).

Why `outputHash` is required: the same stored bytes can decode differently in different decoders (gzip allows several
members back to back, which some decoders join and others stop after the first; some ignore bytes after the stream ends
and others fail). Without a pinned output, one file could show one thing on a gateway and another in a browser or a
mirror. With it, every reader produces exactly those bytes or refuses. Without a codec there is no decoding step, so the
hash must be zero: an optional redundant hash would give one file two CIDs.

Consequences: byte ranges are supported when `codec == 0` (offsets index the joined chunk data, which is then the
content; that includes FastLZ chunks). With a codec there are no ranges, no on-chain reads of the content and no
on-chain IPFS-CID derivation (§8).

SDK defaults: `codec = 0` with the FastLZ backend per chunk (raw where FastLZ does not help). Opt-in: `gzip` with the
raw backend.

## 7. Integrity and availability summary

| | Bound by the id | Checked on chain | Checked by readers |
| --- | --- | --- | --- |
| Chunk on a readable backend | always | at write and on every `ChunkStore.read` | no: a reader trusts its RPC to relay the checked read |
| Chunk on any other backend | always | no | yes, by a reader of that backend's scheme: data against `dataHash` and `size` |
| Nodes, files, directories | always | at creation (structure, totals, order, existence) | no |
| File content with a codec | always (`outputHash`) | no | yes |

A misbehaving backend can make its own chunks unavailable or expensive to read. It cannot change what any id means, and
it cannot affect any chunk stored through another backend.

**Existence can be proven on another chain, and nothing here has to change for it.** Every contract sits at the same
address on every chain, and every id is a function of content and backend address only, so a CID names the same bytes
wherever it exists. Whether it exists is one storage word, at a layout that can never change because the contracts are
immutable. A contract on another chain can therefore check it against a state root it trusts, using a storage proof
(`eth_getProof`) against an L1 block hash on an L2, a light client or a bridge; or a bridge can relay the answer:

| Question | Contract | Word | Exists when |
| --- | --- | --- | --- |
| Is file `cid` there? | `FileStore` | `_mimeTypes[cid]` (mapping at slot 1) | nonzero: a MIME type is 1 to 127 bytes |
| Is directory `cid` there? | `DirectoryStore` | `_roots[cid]` (mapping at slot 1) | nonzero, or `cid == EMPTY_DIRECTORY` |
| Is chunk `id` recorded? | `ChunkStore` | word 0 of `_records[id]` (mapping at slot 0) | nonzero: it packs the backend address and the size |

A word's position is `keccak256(abi.encode(key, slot))`. Such a verifier, a relay, or a ZK proof of IPFS CID linkage is
an add-on that only reads this layer. The one thing that would need a new factory is a project whose content lives on
another chain: a project's hook asks its own chain's stores (§9).

## 8. IPFS CID derivation

`IpfsCidResolver` derives the IPFS CIDv1 of any file or directory from its content on chain. It is view-only, with no
state and no roles. Every implementation (the resolver, the SDK's local derivation, pinning and the mirror) uses this
profile, which is what `ipfs add -r --cid-version=1 --hidden` gives with Kubo's default import settings:

| Parameter | Value |
| --- | --- |
| CID version | CIDv1, sha2-256 multihash, base32 (`b…`) |
| Leaves | raw (`0x55`), 262,144 bytes (256 KiB) |
| Files up to 256 KiB | one raw block |
| Larger files | a balanced dag-pb (`0x70`) DAG of at most 174 links per node, each node's UnixFS data carrying the file size and every child's file-data size (`blocksizes`) |
| Directories | flat dag-pb nodes, links in unsigned byte order of name, UnixFS type Directory; each link's `Name` is the entry name's exact bytes, UTF-8 or not |
| Sharded directories | none: a directory Kubo would shard into a HAMT (its link estimate passes 262,144 bytes) is refused |
| `PBLink.Tsize` | the CUMULATIVE serialized size of the linked subtree (the target block plus every descendant), as Kubo and `ipfs-unixfs-importer` emit |

Encoding details:

- **CID bytes:** `0x01 ‖ codec varint ‖ 0x12 ‖ 0x20 ‖ sha256`, encoded as lowercase base32 (RFC 4648, no padding)
  with the multibase prefix `b`: `bafkrei…` for raw, `bafybei…` for dag-pb.
- **Tsize:** a raw leaf's is its length, and a file root's is its own block length plus the file's bytes. A
  directory's is its own block length plus its children's `Tsize`. An empty directory's is 4 (the block `0a020801`).
- **PBLink:** `Hash` (field 1), `Name` (field 2, always emitted, possibly empty) and `Tsize` (field 3).
- **PBNode:** Links (field 2) before Data (field 1), as dag-pb defines.
- **UnixFS Data:** `Type` (1; File = 2, Directory = 1), `filesize` (3) and `blocksizes` (4) for files.
- **Names:** a link's `Name` is the entry's name bytes as stored, never decoded as text, as in Kubo. Names that are
  not UTF-8 stay distinct; a tool that decodes them first (as JavaScript strings do) derives another CID.

What is derived, and what is not:

- It derives from file *content*. Chunks on the FastLZ backend are inflated on chain, so a FastLZ file has the same IPFS
  CID as the raw file with the same content (the reason FastLZ is the default).
- Not derivable on chain, by revert: a file with a non-zero `codec` (`CodecNotSupported`, declared in
  `IIpfsCidResolver` so the SDK can decode it into `CodecNotSupportedOnChainError`), and any chunk whose backend is not
  readable (`RetrieveFailed`). The SDK derives these off chain from the decoded content.
- Empty file: `bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`. Empty directory (block `0a020801`):
  `bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354`. Both come out of the normal algorithm with zero input.

Matching `ipfs add`:

- **Flags:** `ipfs add -r --cid-version=1 --hidden <folder>`. `--cid-version=1` implies `--raw-leaves`. `--hidden`
  keeps dotfiles, which ABX FS keeps and Kubo skips by default. Empty folders are kept by default (`--empty-dirs`).
- **Import settings:** the defaults (256 KiB fixed-size chunks, balanced layout, 174 links per node, the "links" HAMT
  estimate at 262,144 bytes). A node configured otherwise gives other CIDs for multi-block files and large
  directories. That includes a CID profile such as `unixfs-v1-2025` (1 MiB chunks, 1,024 links, the "block" estimate),
  and the same holds for `ipfs-unixfs-importer` run with other options.
- **Sharded directories:** Kubo shards a directory into a HAMT when the sum over its entries of name bytes plus CID
  bytes is strictly greater than 262,144 (boxo's default "links" estimate). Every CID here is 36 bytes, so the rule is
  Σ (name bytes + 36) > 262,144. At most 900 entries never pass it (900 × 291 = 261,900), and 7,085 or more always do
  (7,085 × 37 = 262,145). The HAMT form is not implemented, so such a directory has no ABX FS IPFS CID:
  - the resolver reverts `DirectoryNeedsSharding(cid, estimate)` before deriving any child, after counting names only.
    The error is declared in `IIpfsCidResolver` so the SDK can decode it;
  - pinning, the mirror and the SDK's local derivation apply the same rule.

  Exactly at 262,144 a directory stays flat, as in Kubo 0.40 and later (boxo 0.37) and `ipfs-unixfs-importer`.
  Earlier Kubo compared with `>=` and shards it. `ipfs-unixfs-importer` 16 leaves non-empty subdirectories out of its
  estimate (they have no CID yet while it builds the tree), where Kubo counts every entry. The rule follows Kubo, so
  it refuses wherever either shards, and every directory CID ABX FS derives is the one both give.
- **A replaceable companion:** no contract stores the resolver's address, and the SDK takes it as optional
  configuration. HAMT support can ship later as a new resolver at a new address, with no other redeploy.

Cost and limits:

- **Memory stays flat.** The resolver streams chunk data into one reused 256 KiB buffer, and each file and directory
  resolves in a memory arena released when it returns. Cost is therefore linear in the bytes derived, counting a child
  once for every link to it.
- **Shared children cost exponentially.** Nothing is memoised. A directory whose two entries link the same subdirectory,
  nested `d` deep, is `d` nodes on chain but 2^d derivations of what is at the bottom: measured, each level about
  doubles the gas (ten levels over a one-byte file: 50M). Such a tree runs out of gas; it never derives a wrong CID.
- **Measured** (Cancun schedule, `forge test`; derivation is a view call, so EIP-8037's state repricing does not
  apply), with warm storage; each distinct chunk of a real file adds about 8.5k gas of cold access:

  | Content | Gas | Within a 30M / 50M / 500M `eth_call` |
  | --- | --- | --- |
  | raw backend | about 6.1 per byte (a 45,875,200-byte, 175-block file: 278M) | about 4.5 / 7.5 / 75 MiB |
  | FastLZ backend, text-like data | about 9.3 per inflated byte | about 3 / 5 / 50 MiB |
  | FastLZ backend, long runs of one byte | about 59 per inflated byte (Solady's `flzDecompress` alone about 53) | about 0.5 MiB at 30M |
  | directories | linear in their children (16 files cost 3.9 times 4 files) | |
  | a whole call on small content | about 34k for a 6-byte file, 15k for the empty directory | |
  | a refused directory | names only: about 25M for 5,300 names of 14 bytes; 8k once the entry count alone decides | |

- **Nesting:** limited by the EVM stack, because each level is an internal call. At least 32 levels (one `resolvePath`
  call) always derive; measured, 49 directory levels derive above a single-block file and 47 above a two-block file.
- **Larger than one call:** the SDK derives off chain. A permissionless contract that anyone steps through over several
  transactions, recording root → IPFS CID, can be added later; it would only read these stores.
- **Large directories:** a directory's block is held whole to be hashed, and a directory past the HAMT threshold above
  is refused: the resolver reverts `DirectoryNeedsSharding`, the mirror skips it with a log line, and pinning throws
  `DirectoryTooLargeForFlatIpfsError`. Counting stops at the first entry that passes the threshold, so a refusal reads
  at most 7,084 entries however large the directory. The SDK decodes the revert to `DirectoryNeedsShardingError`, the
  error its own derivation throws (`ipfsDirectoryNeedsSharding` is the rule), and a reader that gets it reports the
  directory unsupported: it never falls back to a local derivation, which would produce the same wrong flat CID.

**Pinning** uploads exactly the derived blocks (raw leaves, file nodes and directory nodes, empty directories included)
as a CAR, so the pinned root is the derived root by construction for any tree.

## 9. Projects and orgs

A project is an ABX token in an org, publishing a root from §5 through the `abxfs.cid` param. The org layer, the hook
that validates roots against `FileStore` and `DirectoryStore`, and the token metadata are specified in
[`abx-fs-orgs.md`](./abx-fs-orgs.md). Content does not need a project to exist or resolve.

## 10. Security considerations

- **Poisoning:** the input hash and the claims are inside the chunk id (§4); node and CID ids hash complete definitions.
- **Backends:** called only by `ChunkStore`. `write` uses typed calls, so a reverting or malformed backend fails only
  that write. `read` uses a raw `staticcall` with hand-decoding. A malicious readable backend can waste gas for anyone
  who reads content that chose it; the record's `size` lets readers refuse oversized reads before reading.
- **Re-entrancy:** a backend re-entering `write` can only create records under its own address; a record set during
  the backend call stands.
- **Vetoes:** the hook calls only the immutable stores and the factory. No backend call, no unbounded loop, no
  gas-dependent outcome (no gas stipends, no try/catch around state changes), which also keeps behaviour stable under
  EIP-8037.
- **Planted code:** CREATE2 fallbacks for chunk pointers and node blobs (§3).
- **FastLZ decoder agreement:** a stream is recorded when Solady's on-chain decoder produces the claimed data. The SDK's
  port of the decoder agrees with it on every stream a compliant compressor emits, but it REFUSES some malformed streams
  the chain accepts (a truncated literal or back-reference, a back-reference before the start of the output), where
  Solady reads past the end or before the start of its buffers. No reader decodes FastLZ locally: every read goes
  through `ChunkStore.read`, which inflates on chain, so a stream only the chain accepts reads the same for everyone.
  Integrity is unaffected either way. The SDK's compressor is byte-identical to Solady's `flzCompress` (pinned by golden
  vectors), which matters because the compressed bytes are part of every FastLZ chunk id.
- **Mutable code:** EIP-7702-delegated accounts and proxies count as contracts and may be backends. That is the general
  property in §1: availability may change, integrity cannot.
- **RPC trust:** readers trust their RPC (§4). An honest node cannot return other bytes for a chunk without a revert,
  because `ChunkStore.read` checks them.
- **Decoding:** sizes are known before reads, and the SDK and gateway cap inflated and decoded bytes. Codec ambiguity is
  closed by `outputHash`.
- **No blocklist:** the protocol has none. What a gateway declines to serve is its own choice, made off chain
  (`@abxfs/gateway` takes a filter).

## 11. Tooling and deployment

- **SDK:** computes ids offline per backend (input hash, data hash, size); plans, resumes and deduplicates (only missing
  nodes are sent); one reader per backend scheme; `RetrieveFailed` surfaces the backend's `retrieval()` text, unless that backend says it
  is EVM-readable (scheme `evm`), when the chain can serve the chunk and the node's own error stands.
- **Gas schedules:** EIP-7825 caps a transaction's execution gas at 2^24. Under EIP-8037 (Glamsterdam; live on Sepolia,
  expected on Ethereum) state creation is a separate dimension: code costs 1,530 gas a byte (200 before), a new
  account 183,600 and a new slot 97,920. `tx.gas` covers both dimensions and the block gas limit bounds it. The SDK
  asks the node which schedule a chain runs (`detectGasSchedule`, one estimate of a 1-byte CREATE2, cached per chain),
  prices state per schedule, and packs bundles with execution under its cap and the total under both the node's
  simulation cap (50M by default) and the block limit. A full chunk is a transaction of its own under EIP-8037. The
  worst cases in §5 were measured under both schedules, and no packing constant had to change.
- **Gateway, mirror, CLI:** byte ranges for `codec == 0`, FastLZ chunks included.
- **Order:**
  1. Contracts, with unit, fuzz and invariant tests, adversarial backends, golden vectors in TS and Solidity, address
     pins, the fork test against real ABX, and gas tables under both schedules.
  2. Code freeze: a final comment and NatSpec pass, then re-pin.
  3. An internal audit (`docs/internal-audit-summary.md`), then fixes and a re-pin. An independent audit has not been
     done.
  4. Testnets at the final addresses, with a rehearsal.
  5. Production networks, each after its testnet.
- **Token links:** the default is a path on `https://fs.abx.io`, frozen into every org (`OrgMeta`); where content is
  served stays off chain.

## 12. Decided against

- **A stored input hash per chunk.** It only helps a reader that verifies the whole tree from the root (§4).
- **A decompressor registry or reader-supplied decompressors.** On-chain decoding lives in backends.
- **Required backends, or a per-node backend summary.** Which backends a project uses is derivable off chain.
- **Org-layer decisions** (royalties, supply cap, link bases, admin powers) are listed in
  [`abx-fs-orgs.md`](./abx-fs-orgs.md).

## 13. Test vectors

| Object | Value |
| --- | --- |
| Empty file, IPFS CID | `bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku` |
| Empty directory, IPFS CID | `bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354` (block `0a020801`) |

ABX FS ids (chunk ids, node ids, file and directory CIDs, the empty ones included) are generated with the contracts and
pinned in `GoldenVectors.t.sol` and the SDK's node tests.
