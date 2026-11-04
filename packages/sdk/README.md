# @abxfs/sdk

TypeScript SDK for reading from and writing to the ABX FS contracts ([`specs/abx-fs.md`](../../specs/abx-fs.md),
[`specs/abx-fs-orgs.md`](../../specs/abx-fs-orgs.md)). Used by `@abxfs/cli` and `@abxfs/gateway`.

> **Not on npm yet.** Until the packages are published, build it from a checkout:
> `pnpm install && pnpm --filter @abxfs/sdk build`.

## Layout

| Module | Purpose |
| --- | --- |
| `cid.ts` | Chunk ids (`chunkId(backend, inputHash, dataHash, size)`) and IPFS CID derivation |
| `names.ts` | Directory entry names as bytes: `DirectoryEntry.nameBytes` and the lossless text form (`\xHH` for bytes that are not valid UTF-8): `decodeEntryName`, `encodeEntryName`, `entryNameBytes` |
| `nodes.ts`, `node-gas.ts` | Canonical, content-defined packing of chunk records / directory entries into node trees, and the local file and directory CIDs (`packFile`, `packDirectory`, `fileCid`, `directoryCid`, `EMPTY_DIRECTORY`) |
| `plan.ts` | The whole write pipeline with no chain: codec, chunking, a backend per chunk (FastLZ where it shrinks a chunk, raw otherwise), ids, trees, CIDs (`planFile`, `planUploadOffline`, `planBackendsFor`) |
| `fastlz.ts` | FastLZ compress / decompress, byte-identical to Solady's `LibZip` (the on-chain `FastLzSstore2Backend` inflates with it) |
| `content-write.ts` | The one write pipeline: probe what exists, build stages (chunks, chunk nodes, files, entry nodes, directories), run them with settle waits and node-level progress |
| `stores.ts` | The content stores of an address book (`contentStores`) and whether a hook is bound to them (`hookAcceptsContent`) |
| `chunking/` | Content-defined chunking (FastCDC): `chunkBytes` |
| `compression.ts` | File codecs (off chain): `bytes32` labels (`codecLabel`, `CODEC_GZIP`, …) and a registry of decoders (`autoRegisterNodeCodecs` on Node; `registerWebCodecs` in `web-codecs.ts` for browsers) |
| `upload.ts` | High-level `uploadFiles` / `planUpload` flows (chunking, dedup probes, multicall bundling) |
| `read.ts` | Read files and directories, paged at 100: every chunk through `ChunkStore.read` (checked on chain against its record), a file codec decoded and checked against `outputHash`, byte seeks (`locateByte`) and path lookups (`resolvePath`) |
| `update.ts` | Diff + publish helpers for project version updates |
| `verify.ts` | Derive a root's IPFS CID on chain (`IpfsCidResolver`) and locally, and compare; a file codec the chain cannot decode is `CodecNotSupportedOnChainError` |
| `canonical.ts` | The canonical deployment per chain: addresses, RPC endpoints, and what each network has |
| `project.ts` | A project: read its head, history and tags, publish a version, transfer it |
| `org.ts` | Orgs: create one, find the ones an address administers or holds, mint into one, hand it on, and read the cross-org publish ledger |
| `abxfs.ts` | `AbxfsClient` — the convenient one-stop wrapper most callers want |

Reads trust the RPC they go through, as any dapp does; the contracts check what an honest node returns. Use a keyed
endpoint you trust (`ABXFS_RPC_URL_<chainId>` in the tools).

## Projects live in orgs

An org is its own ABX collection, created by one immutable factory that renounces ownership at
creation. A project is a token in it, so a project is named by **chain + org + token id** (token ids
repeat across orgs). The org's admin only decides who may mint into it; a project is governed by
`ownerOf` and nothing else.

```ts
import { AbxfsClient, requireCanonicalAddresses } from "@abxfs/sdk";

const addresses = requireCanonicalAddresses(await publicClient.getChainId()); // the network your clients use
const client = new AbxfsClient({ publicClient, walletClient, addresses });

const { org, firstTokenId } = await client.createOrg({ name: "My studio" }); // one tx: org + first project
const project = client.forOrg(org);                                         // project methods need an org

await project.publishVersion(firstTokenId, rootCid);
const { tokenId } = await project.mintProject();                            // the admin, or anyone if the org is open
const head = await project.readProject(tokenId);

const mine = await client.myOrgs(account);                                  // administered or held, newest first
```

`forOrg` is for an org created in this process. For an org that comes from a URL or a list, use
`await client.resolveOrg(org)`, which finds the factory that made it.

Everything is an `eth_call`; nothing reads `eth_getLogs`. To follow **everything published**, keep an
index into the cross-org ledger — one address, one cursor:

```ts
const total = await client.globalPublishCount();
const page = await client.globalPublishes({ start: lastSeen, count: 100 }); // OrgPublish[]
```

ABX FS is deployed on production networks and their testnets, and `CANONICAL_DEPLOYMENTS` (`canonical.ts`) lists them:
`requireCanonicalAddresses` throws for a chain with no addresses on record (`isCanonicallyDeployed(chainId)` says
which). A local chain passes its own `ContractAddresses`.

## Publishing and tagging

`project.publishAndTag(tokenId, rootCid, { tag })` (`publishRootAndTag` as a function) is the one
implementation behind the draft path and the CLI's `upload` and `update`. It reads the version count
**before** publishing (and refuses to publish if it cannot), takes the version number from the publish
receipt's own `ProjectVersionPublished` event, then proves `versionAt(v).cid === rootCid` through a settled
read. A tag is written only against a version proven that way; otherwise it throws and writes no tag. Every
transaction wait goes through `waitForSuccessfulReceipt`, which throws `TransactionRevertedError` for a mined
but reverted transaction, so a revert is never reported as success.

## Safety helpers and limits

| Export | What it does |
| --- | --- |
| `assertSafeRecipient(addr, { forbid })` / `recipientProblem` | Strict EIP-55 checksum; no zero, burn (`0x…dEaD` and look-alikes), precompile (0x01 to 0x0a) or all-ones address, nothing in `forbid` (the org, the project hook). Used by `transferProject`, `transferAdmin` and `mintInOrg`. |
| `isSafeExternalUrl` / `externalUrlProblem` | https only, no credentials, no `localhost`, no private/loopback/link-local IP literal, at most 512 characters. `setPreferredGateway` throws on anything else. |
| `isUsableViewUrl` | The on-chain `abxfs.view` rule: https, visible ASCII, at most 512 bytes, none of `" ' & < > \`, the backtick, `( ) [ ] { } \| ^`. |
| `sanitizeDisplayName` / `stripTerminalControl` | Printable-ASCII display names without bidi or format characters; terminal output without C0/C1 controls or ANSI/OSC sequences. |
| `walkDirectory`, `walkDirectoryTree`, `verifyLocalIpfsCid` (and `pinRoot` / `pinDirectory` in `@abxfs/pinning`, via its `limits` option) | Read each distinct node once however often a DAG links it; capped at 100,000 nodes and 1 GiB (`LimitExceededError`, override with `{ maxNodes, maxBytes }`; a `limits` option in `@abxfs/pinning`). |
| `readFile`, `readChunkSlices` | Data is capped at 1 GiB (`maxStoredBytes`) and 200,000 chunks (`maxChunks`); decoding a file codec is capped at 256 MiB (`maxInflateBytes`) and aborts. Reading the chunks has a call budget (`maxCalls`, a positive integer or `Infinity`; default `defaultMaxChunkReadCalls(n)` = `ceil(n/4) + ceil(n/256) + 8`, enough for a node that simulates 2^24 gas per `eth_call`: after a call refused for gas (`isChunkReadGasRefusal`: `RetrieveFailed`, an empty revert, or the node's own out-of-gas words; never a node's `internal error` or `header not found`) the read re-plans at half the gas, and after a result longer than the node returns (`resultLimitOf`: Erigon's `--rpc.returndata.limit`, 100,000 bytes by default) it plans within that length; `LimitExceededError` with `limit: "calls"`). |
| `verifyOnChainIpfsCid` | Passes an explicit gas limit and remembers a failing root for the session (`clearResolverFailureCache`). |
| `projectVersions`, `projectVersionsPage`, `tagPage`, `listTags` | 200 rows per `eth_call` by default (`limit` up to 1,000), newest first, with a cursor (`nextBefore`) for "load more". `readOrgsAdministered` and `readOrgsHeld` read 200 per call and return at most 2,000 orgs (a non-enumerable `truncated` says there are more); `readOwnedProjects` returns at most 5,000 projects (`iterateOwnedProjects` walks past that). The swap-and-pop lists (orgs, owned tokens, tags) are read at one block, so a change between pages cannot skip or repeat an entry. |

`mintInOrg` / `mintProject` take `addresses` (the `AbxfsClient` method supplies it) and check the org against the
factory before sending anything.

## Chunking (FastCDC)

Files are split with **content-defined chunking** (FastCDC, Xia et al., USENIX ATC '16), so inserting or deleting a
byte near the start of a large file only changes the chunk(s) at the edit site; every later chunk deduplicates against
what is already stored. Fixed-stride chunking would rewrite every chunk after the edit.

For the backends' input cap `M` (24,575 for both launch backends), applied to the file's data:

- `min = floor(M * 0.50)` — no boundary inside `[0, min)`
- `target = floor(M * 0.75)` — the boundary mask switches from strict to loose here
- `hardMax = M` — a forced cut

The headroom between `target` and `hardMax` lets a small in-place insert grow a chunk without splitting it into two
new chunks (each new chunk is a new contract deployment, which is real gas).

FastCDC needs the whole file in memory (at least one `hardMax` window), so a stream-as-you-receive upload path would
need a different design.

**Frozen.** The gear table is generated at module load by a Mulberry32 PRNG seeded with `0xba5e5eed`. The seed, the
PRNG, the ratios above and the masks are part of every CID: changing any of them gives identical bytes new chunk ids,
and so new file and directory CIDs. `test/chunking/fastcdc.test.ts` asserts that single-byte edits preserve most
chunks; if it breaks, the chunking changed.

## Tests

```bash
pnpm --filter @abxfs/sdk test
```

## Token links

`await project.setViewUrl(tokenId, "https://my-site.example/")` sets `abxfs.view`: both of the token's
marketplace links become exactly that URL. `""` clears it and the default (a path on `https://fs.abx.io`) applies
again. `readProject(...).viewUrl` reads it. `isUsableViewUrl(url)` is the check the token itself applies, but
`setViewUrl` also applies `externalUrlProblem` (https, no credentials, no localhost or private IP), so validate with
`viewUrlProblem(url)` (null means OK) before sending. See the docs page "Token links and your own gateway".
