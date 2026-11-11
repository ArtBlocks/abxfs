# Agent Guide for the ABX FS Repo

Orientation for AI coding agents. Humans should find it useful too.

The product is **ABX FS**: packages `@artblocks/abxfs-*`, the `abxfs` CLI, `ABXFS_*` environment variables, `.abxfs.json`
config files. The specs are [`specs/abx-fs.md`](./specs/abx-fs.md) (the content layer and IPFS) and
[`specs/abx-fs-orgs.md`](./specs/abx-fs-orgs.md) (projects and orgs). It is deployed on production networks and their
testnets, with real funds at stake on the production ones: see "Deployed networks" below.

## The one thing to internalize

There are **two independent layers**, and conflating them is the mistake that produces wrong changes:

- **The content layer** (`packages/contracts-core`) is permissionless and immutable. Anyone can write
  bytes; nothing is owned; nothing can be changed. Any stored content is served at `<chain>-<root>.<content domain>/`
  (see "Every project is its own origin" below).
- **The project layer** is an **ABX NFT inside an org**. `ownerOf` is the authorization model for a
  project, in full. Project state lives in ABX PostParams (`abxfs.cid`, `abxfs.name`, `abxfs.gateway`,
  `abxfs.view` and the reserved `abxfs.meta`), and integrity is enforced by `ProjectHook`.

An **org** is its own ABX collection, created by one immutable factory (`OrgFactory`) that
renounces ABX ownership at creation. Nobody — not ABX FS, not the org's admin — can change an org's
schema, hooks, renderers, minter or supply cap afterwards. The org **admin** is a record in the factory
and has exactly three powers: decide who may *mint* into the org, open or close it, and hand the role
on. It has no power over any project. A project is named by chain + org + token id, because token ids
repeat across orgs.

Content does not need a project to exist or resolve. A project is one representation of content, and
anyone can build a different one. Orgs separate the **project** layer only: content is one global permissionless
store, so the same bytes resolve whatever org points at them.

## Where things live

| Trying to… | Read |
| --- | --- |
| Understand the on-chain content protocol | [`specs/abx-fs.md`](./specs/abx-fs.md) |
| Understand orgs, projects, the factory, the hooks, or who can mint | [`specs/abx-fs-orgs.md`](./specs/abx-fs-orgs.md) |
| Understand on-chain IPFS CID derivation | [`specs/abx-fs.md`](./specs/abx-fs.md) §8 and `packages/contracts-companion` (`IpfsCidResolver`) |
| Work on the gateway | `packages/gateway/src/handler.ts` and `resolve.ts` — `abxfs-gateway` and every site built on the package run this code |
| Pin everything published to IPFS | `packages/gateway/src/mirror.ts` (`abxfs-mirror`) — one cursor over the cross-org ledger |
| Work on project reads/writes | `packages/sdk/src/project.ts` (a project) and `packages/sdk/src/org.ts` (orgs, minting, the cross-org feed) |
| Get started locally | [`site/content/docs/using-abxfs/quickstart.mdx`](./site/content/docs/using-abxfs/quickstart.mdx) |
| Change anything a user reads | `site/content/docs/` — the docs site, published at docs.fs.abx.io. There is no second copy; `docs/` holds operator runbooks and the audit record only |
| Deploy to a network | [`docs/deploy-runbook.md`](./docs/deploy-runbook.md) — every step in order, the irreversible ones marked; add one when you invent it |
| Use the CLI | `packages/cli/src/commands/` — config in `~/.config/abxfs/config.json` (a project's `.abxfs.json` is untrusted), key in `ABXFS_PRIVATE_KEY` (never on disk); project commands take `--org` |
| Index everything that is published | `Lens.publishRange` + `hook.globalPublishCount` — one address, one cursor ([`specs/abx-fs-orgs.md`](./specs/abx-fs-orgs.md#indexing-everything)) |

The website at fs.abx.io is Art Blocks' hosted service, built on these packages and maintained separately; nothing here
depends on it.

## Things that will bite you

**RPC batches are checked.** Every viem client uses `strictBatchFetch` (`packages/gateway/src/upstream.ts`): a JSON-RPC
batch whose response ids do not match the request is a 502, never an answer (a mismatched id could otherwise read as a
revert, or hand one call's chunk bytes to another). viem does NOT check ids; it hands out results by position. Every
batch is checked at ANY size (only the ids are scanned); do not reintroduce a size past which it is passed through. An
answer is buffered only up to viem's own `maxResponseBodySize` (10 MiB), past which it is a 502 rather than a pass:
viem would refuse it anyway. The `eth_chainId` check before an endpoint's first read (`chainCheckedFetch`) is one per
chain per process (keep the fetch, do not rebuild it per client), runs on its own timeout, and reads at most 64 KiB. A
right-chain answer is kept for the process's life; a wrong-chain answer is refused for five minutes
(`WRONG_CHAIN_TTL_MS`) and then asked again, so a fixed endpoint recovers without a restart.

**The CID rides a `Uint256Range` param, not `Bytes`.** This looks wrong and is load-bearing. A
`String`/`Bytes` param stores an SSTORE2 blob, and both its event and `tokenParam` carry only `keccak256(payload)`.
Scalar params carry the raw `bytes32`, and an ABX FS root CID is exactly that.

**The configure hook must ignore unknown param keys, never reject them.** Hooks freeze before a
collection renounces ownership, while `setParamSchema` can still add keys until then — so a hook that
rejected what it did not recognize would permanently forbid every future key. There is a test and a
fuzz case guarding this.

**The hook is a veto.** A bug that wrongly reverts freezes publishing for every org built on it, and after
renounce it can never be swapped or cleared. Weight "must NOT revert" cases as heavily as "must
revert" ones.

**Ordinary malformed and semantic field states must remain safe to render.** The card and legacy field
renderers handle no-code, short and malformed dependency responses deliberately. A staticcall to a no-code address
succeeds with empty returndata, and a return-data decoding failure is not catchable, so external reads in
`ProjectCard`, `ProjectTraits`, `ProjectLinks` and `OrgMeta` are hand-decoded. The current presentation renderer is
a deliberate exception to a blanket never-revert rule: actual content/IPFS read failure is surfaced as a typed
render failure, and Embedded can naturally exhaust its caller's gas. Do not add fixed byte/chunk/gas product caps
or silently change delivery method to hide those failures. Semantic missing/unpublished targets may return neutral
output; use diagnostic preview to distinguish them from resource or dependency failure. Native preview eligibility
does not prove the complete ABX `tokenURI` can be serialized within an RPC caller budget.

**Param keys are packed ASCII, not hashed.** `bytes32("abxfs.cid")` must equal
`stringToHex(key, {size: 32})`. Divergence is silent and total — every read returns "unset", every
write lands on a key nobody reads — so the bytes are pinned as literals in both
`packages/sdk/test/project-keys.test.ts` and `packages/contracts-projects/test/ParamKeys.t.sol`.
If you touch key encoding, both must move together.

**A contract's address is a function of its exact source, and a code change forks the content-address space.**
Every contract is deployed with CREATE2 through the keyless deployer (`0x4e59…956C`) with fixed salts
(`keccak256("abx-fs/content")` for the five content contracts; `abx-fs/ipfs-cid-resolver`, `abx-fs/org-meta`,
`abx-fs/org-factory`, `abx-fs/org-components` and `abx-fs/lens` for the rest), and every chunk id commits to its storage backend's ADDRESS. So
changed code means a changed address, and for a backend or a store that silently forks the content-address space
rather than failing.

The build keeps solc's metadata hash (by design: NatSpec is frozen with the code), so the bytecode commits to the
exact source text, comments included, to the source paths and to the remappings. Three consequences: every comment edit
in a pinned contract moves its address; `auto_detect_remappings = false` in every `foundry.toml`, because auto-detection
adds absolute paths of the checkout to the metadata and addresses would then depend on where the repo lives; and the
Solidity package folder names and remapping names (`@abxfs/core/…`) are frozen at deployment (they are Solidity
remappings, not npm packages: the npm packages are `@artblocks/abxfs-*`, and renaming a remapping moves every
address). The library sources a contract compiles are part of its address too (Solady's `LibZip`, `SSTORE2`,
`Multicallable`, `LibString`, `LibBytes`,
`Base64`): install them only with `scripts/install-forge-deps.sh`, which checks each tag's commit, and never edit or
format `lib/` (every `foundry.toml` has `[fmt] ignore = ["lib/**"]`). A locally reformatted Solady once moved the
factory's address while every logic byte stayed the same. The changes are made loud
by pins: `Deploy.t.sol::test_predictedAddressesArePinned` (the five content contracts),
`contracts-projects/test/DeployFactoryPin.t.sol` (factory, `OrgMeta` and lens creation-code hashes, and the
predicted addresses of `OrgMeta`, the factory, its five components and the lens, in its script's `pinned()`, which
refuses to broadcast anything else on a listed chain) and `contracts-companion/test/DeployPin.t.sol` (the resolver's creation-code hash and its address over the
pinned stores, in its script's `pinned()`, which a re-pinned content layer moves). Re-pin deliberately, and only before
a deployment. Solidity comments cite spec sections by number (`specs/abx-fs.md` §3, §4, §5, §6, §8), so do not
renumber those sections.

**The content layer is one `ChunkStore` over pluggable storage backends, and trees of nodes over it**
(`packages/contracts-core`, [`specs/abx-fs.md`](./specs/abx-fs.md)). There are no roles, registries or ETH anywhere in
it. Things that bite:

- A chunk id is `keccak256(0x30 ‖ backend ‖ keccak256(input) ‖ dataHash ‖ size:6)`. A backend that is EVM-readable
  is read back and checked at write and on every read; for one that is not, the claims are bound into the id. The
  record is 3 slots (backend|size, pointer, dataHash); `keccak256(input)` is in the id and the `ChunkWritten` event but
  is not stored. Readers trust their RPC (by design): a stored input hash only helps a reader that also checks the
  chunk-id list against the root node by node, which nothing does, so do not add a per-chunk client-side check that
  looks like verification without being it.
- Compression lives in two places. A backend may decode what it stores (`FastLzSstore2Backend` inflates on every
  read), and the SDK uses it per chunk only where FastLZ shrinks the chunk; that is the default. A FILE may carry an
  off-chain codec label (an IANA content-coding token in a `bytes32`, zero for none) with
  `outputHash = keccak256(content)`; the chain never decodes it. Codec is zero iff outputHash is zero. The CLI and the
  site offer only `gzip`, because it is the one codec every reader decodes (browsers and Edge through the Compression
  Streams API). The gateway on Node (the content origin, `abxfs-gateway`) also decodes `br` and `zstd`
  (`registerNodeCodecs`, capped at the file limit). A codec the gateway has no decoder for is a 501 known from the file
  record alone, and an `outputHash` mismatch a 502; both are remembered per CID and cacheable, like the oversize 413.
  A spent chunk-read call budget (`LimitExceededError`, limit `calls`) is a 502 remembered per CID and per READ (the
  range for a ranged read, `whole` for a whole one, which a range of a codec file is) for a minute with a 60 s
  `s-maxage`, in its own capped map so ranges cannot evict the day-long refusals: the SDK spends that budget only on
  calls the node answered and rethrows a transport failure, so it repeats on every request. It is never the oversize
  413 and never a 503.
- The tree shape is part of the CID. Packing is a CLIENT convention (`packages/sdk/src/node-gas.ts`, spec "Canonical
  packing"): node boundaries are CONTENT-DEFINED (an item whose hash falls under a threshold ends a node, between a
  minimum and a maximum), so an edit rewrites the nodes around it, never every node after it. Do not "simplify" it to
  front-to-back filling: that makes one added file in a large directory rewrite every later leaf. Entry boundaries are
  keyed by the NAME only, so a changed file rewrites one leaf. Change any constant and the same content gets a new CID.
  `test/nodes.test.ts` and `GoldenVectors.t.sol` (which re-derives the boundaries in Solidity) pin the vectors; move
  them together, and regenerate them with `packages/sdk/scripts/golden-vectors.mjs` after a build. Chunk boundaries
  (FastCDC) are frozen for the same reason; the node GAS model (`NODE_GAS`) is tunable and is NOT the frozen
  `ENTRY_LEAF_PACKING` copy. Because boundaries come from hashes, how many levels a tree needs depends on its ids, not
  only on its size: the same entry count can fit in three levels with one content and need a refused fourth with
  another, so a test that sizes a tree near the cap must use the real ids it will get.
- Leaf records are `chunkId ‖ size:6` (38 bytes; the contracts accept 646 per leaf, the SDK packs at most 512) and
  file branches carry cumulative bytes, so `locateByte` finds any offset in one call and `getFileInfo.size` is the
  length before any chunk is read. Index nodes are kept as contract code inside the stores, never through a backend.
- Empty files (root zero) and empty directories (`EMPTY_DIRECTORY`, which always exists) are content like any other.
  Their IPFS CIDs are the standard ones (`specs/abx-fs.md` §13). Empty folders are part of a root, as with
  `ipfs add -r`, so every path that builds a tree must keep them or the same folder gets two roots: the CLI scan, a
  browser uploader (drag-and-drop and `showDirectoryPicker` see them; the `webkitdirectory` fallback cannot, and says so),
  `walkDirectoryTree` (`walkDirectory` lists files only) and draft edits, which keep the base's empty folders. The CLI
  and a browser uploader skip the same names (the SDK's `UPLOAD_IGNORE_NAMES`, `UPLOAD_VCS_NAMES`, `UPLOAD_DOT_ALLOWLIST`)
  and take MIME types from extensions (`inferMimeType`), never from the browser, because the MIME type is in the CID.
- A root is exactly one of file (`0x31` prefix) or directory (`0x32`); `locateContent` / `cidKind` probe both.
- Reads are paged (<=100 items) or by index/lookup; never walk a whole tree in a request. The gateway answers paths
  with one `resolvePath` (32 segments per call, chained to 256), lists directories 100 per page, and a Range read is
  a seek (`locateByte`) that reads only the chunks the range covers.
- Data stored as code goes through `CodeStore`: CREATE2 with salts 0..7, checking occupancy FIRST, because a CREATE2
  into an occupied address burns 63/64 of the gas forwarded, and content addressing makes re-writing existing data the
  common case; an occupied address is reused only if its codehash is exactly the expected code.
- Gas: EIP-7825 caps a transaction's execution gas at 2^24, and every node and chunk write is sized to fit it. Under
  EIP-8037 (Glamsterdam) state creation is a separate dimension that the cap does not cover, bounded by the block gas
  limit, and code costs 1,530 gas a byte instead of 200. The SDK detects a chain's schedule from the node
  (`gas-schedule.ts`, `detectGasSchedule`) and packs execution and total separately; `gas-schedule.test.ts` pins the
  model against every measured write (never below, at most 15% + 60k above). Nodes simulate at most 50M by default,
  which bounds a bundle's total; some public Sepolia backends cap far lower, so Sepolia writes need a keyed RPC. The SDK
  sends bundles with explicit nonces and waits for the node's pending count, because a load-balanced RPC otherwise
  answers `replacement transaction underpriced`. Resume is just re-planning: only missing nodes are sent.
- Entry names are BYTES (any 1..255 but `.`, `..`, `/`, `\`), not UTF-8. viem's default `string` decoding drops a
  leading U+FEFF and turns invalid UTF-8 into U+FFFD, which renames or merges entries, so the SDK reads names as bytes
  (`nameBytes`) and carries a lossless text form (`names.ts`: UTF-8 text, `\xHH` for each invalid byte; no name holds a
  `\`, so the form maps back exactly). Anything that packs, sorts or derives from a name uses its bytes
  (`entryNameBytes`); never `new TextEncoder().encode(entry.name)`.
- The IPFS side: Kubo shards a directory into a HAMT once its link estimate, name bytes plus 36 CID bytes summed over
  its entries (subdirectories included), is strictly greater than 262,144 (`specs/abx-fs.md` §8). That is 901 entries
  with 255-byte names, about 5,300 with 14-byte ones. The HAMT form is NOT implemented, and every implementation
  applies that ONE rule: `IpfsCidResolver` reverts `DirectoryNeedsSharding` before deriving any child, the SDK's local
  derivation refuses (`ipfsDirectoryNeedsSharding`, `DirectoryNeedsShardingError`, which is also what the resolver's
  revert decodes to), the mirror skips with a log line and pinning throws `DirectoryTooLargeForFlatIpfsError` (a
  `DirectoryNeedsShardingError` under the name the mirror matches). A flat
  CID past the threshold is one `ipfs add -r` never produces, so never relax the rule in one place only.
  `ipfs-unixfs-importer` leaves non-empty subdirectories out of its estimate, so near the threshold it is no oracle.
  Pinning uploads exactly the derived blocks as a CAR, so any other tree, empty directories included, pins under the
  root ABX FS derives. The resolver derives raw and FastLZ content and reverts `CodecNotSupported` for a file with a
  codec; its errors are declared in `IIpfsCidResolver` (not the contract) so the SDK can decode them
  (`CodecNotSupportedOnChainError` and so on). Callers fall back to the local derivation by type, not by message text,
  and only for `CodecNotSupported`: the local derivation refuses a sharded directory too. The resolver is a replaceable
  companion (no contract stores its address, the SDK takes it as optional configuration), so HAMT support can ship as
  a new resolver with no other redeploy. Its address is pinned like the others (`script/Deploy.s.sol` `pinned()`,
  `test/DeployPin.t.sol`).

**Deployed networks.** The reader/presentation generation is deployed, read back and rehearsed on all eight
registered networks. The original `abx-fs-freeze-3` factory remains in `previousGenerations` permanently on its
original six networks only; Robinhood and Robinhood Testnet have no earlier factory history. The canonical registry (`packages/sdk/src/canonical.ts`) is the list, and gives
every network one address book; the docs' deployments page publishes it. Name a network only where a fact is specific
to it (a measurement, a test fixture, the registry), never as the place to deploy or the default: no tool picks one
for the user. Everything on a production network is permanent and holds real value, so a bug there is fixed only by
a new factory (see "Superseding" in the deploy runbook). A chain is listed with NO addresses until a deployment there is verified, and every consumer has to say
what it does with such a chain: `requireCanonicalAddresses` throws "not deployed"; the CLI loads such a
chain without addresses and refuses commands on it (`requireAddresses`); a site leaves it out of the chains it serves.
`canonical.test.ts` checks current addresses against `pinned()` and original-generation history against
`previousPinned()`. Address promotion follows verification and rehearsal; a re-pin alone does not authorize it. Tests that need an address book mock `@artblocks/abxfs-sdk` through
`packages/sdk/test/helpers/deployed-registry.ts` (a test setup file can do it for a whole suite), so they defend stand-in
addresses on every chain, so they do not move when a chain is deployed. Deploying anything to a production chain
needs the maintainers' explicit go-ahead.

**Packages read each other from `dist`.** The CLI and the gateway import `@artblocks/abxfs-sdk` (and a site imports the SDK and
the gateway) through their package exports, so after changing one of those, rebuild it
(`pnpm -r --filter="./packages/*" build`) before trusting a dependent test. A stale `dist` reads as a baffling mock
error ("No `<name>` export is defined on the mock") rather than a type error.

**The four packages are published to npm by Changesets and trusted publishing** (`.github/workflows/release.yml`,
[`.changeset/README.md`](./.changeset/README.md)). A change to a published package carries a changeset (`pnpm changeset`);
merging it opens a Version Packages pull request, and merging THAT publishes. No npm token exists anywhere, and none
should be added: npm trusts this repository's `release.yml` by name, so renaming the file stops releases until every
package is told the new name. Do not edit a package's version by hand.

`OrgFactory` is the same kind of thing — deployed with a fixed salt, so its address is a function
of its creation code and of its constructor arguments (the ABX addresses, both stores and `OrgMeta`).
It is **pinned**: `packages/contracts-projects/test/DeployFactoryPin.t.sol` pins its creation-code hash,
`OrgMeta`'s, the lens's, and (through `script/Deploy.s.sol`'s `pinned()`) their predicted addresses and the five
components'. Treat a code change in the factory, the hook,
the enumeration hook, the minter, the card or the traits renderer as an address change — the factory computes those
five components' CREATE2 addresses in its constructor from their creation code, so their code is part of its initcode.
The factory does not deploy them: anyone deploys each through the keyless deployer (`COMPONENT_SALT`; the deploy script
does it with `script/OrgComponents.sol`), only that exact code can land at each address, and `createOrg` reverts
`ComponentsNotDeployed` until all five exist. That split is what keeps every deploy transaction under about 21M gas
under EIP-8037; deploying them in the factory's constructor measured 67.7M, over Ethereum's 60M block. Tests make a
factory with `OrgComponents.create`, not `new OrgFactory`. `OrgMeta` (the org's
`contractURI` document and every token's `name`) is deployed separately by `Deploy.s.sol` with its own
fixed salt, and IT deploys the links renderer; the factory takes `orgMeta` as a constructor argument and reads `links`
from it, and the gateway base (`https://fs.abx.io`) is `OrgMeta`'s argument. So a code change in `OrgMeta` or
`ProjectLinks` moves `OrgMeta`'s address and, through the argument, the factory's. The lens is CREATE2 too, so it lands
at a predictable address per chain.

**Every SDK write refuses a wallet client set up for another chain than the one it reads** (`assertWalletChain`,
`WrongChainError`, in `packages/sdk/src/wallet-chain.ts`). Every contract has the same address on every chain, so a
write planned against a testnet is a valid transaction on a production network, paid in real funds; viem only refuses a wallet that
moved off its own client's chain. `AbxfsClient`'s wallet check, `sendBundles`, `publishRootAndTag`, `createOrg` and
`mintInOrg` call it before anything is sent: a new write path that takes both clients calls it too.

**A project can exist with no content.** Minting a token and publishing to it are separate acts, so
`cid` is nullable and `kind` can be `Unset`. Any new consumer has to say what it does in that state.

**`cidKind` returns `ProjectKind.Unset`, not `null`,** matching the hook's `kindOf` so the two are
directly comparable. A stale `=== null` check silently passes bad input through.

**Nothing reads `eth_getLogs`. Do not add a log read.** Every query is an `eth_call` against
contract storage, and that is deliberate.

Logs look like the natural index: `TokenParamConfigured` indexes both `tokenId` and `key`, so one
filtered query can reconstruct a project's whole history. But logs are not permanent state. Providers prune them:
one public endpoint measured keeps a rolling ~33 days. Once a collection outlives that window,
scans anchored at its deploy block stop returning less and fail outright with
`pruned history unavailable`. Measured against an endpoint that *did* retain:
221s to list one owner's projects, 273s for a recent feed, both growing with chain age forever.

So the indexes live in the hooks, writing to storage that is never pruned and never re-scanned:

- `ProjectHook` (configure hook) — per-project version history, tags, a per-org append-only publish
  ledger, and one append-only ledger across every org.
- `ProjectEnumeration` (transfer hook) — owner → tokens per org, and owner → orgs held. An org's whole
  token set needs no index: ABX numbers an org's tokens `0 … nextTokenId() - 1` in mint order, and nothing burns.

**ABX collections are not ERC-721Enumerable**, which is why the second hook exists. There is no
`tokenOfOwnerByIndex` on the token itself; `ProjectEnumeration.tokensOfOwner` is the answer, and
`orgsHeldBy` answers "which orgs do I hold a project in".

**Both hooks are vetoes.** A configure-hook revert blocks publishing; a transfer-hook revert blocks
transfers *and mints*, because a mint is a transfer from `address(0)`. Weight "must NOT revert" as
heavily as "must revert" — the enumeration hook repairs inconsistent state rather than asserting
against it, for exactly this reason.

**A receipt is not visibility, and the silent version of that bug is the dangerous one.**
`settle.ts` exists because public RPCs are load balanced across replicas that lag each other, so the
read after `waitForTransactionReceipt` can miss the write. The cases listed there all *revert*, which
makes them loud.

One does not. A publish path that reads `versionCount` once after the publish receipt, to decide which version a tag
should point at, can get a stale count one too low, and `setTag(…, n-1)` is a perfectly legal call — so the tag is
written against the *previous* version's content and nothing fails. That shipped once and mislabelled a release in
production.

Two lessons worth keeping:

- When a read feeds a subsequent **write's argument**, settling is not optional, and confirming the
  value (here, that the version's CID is the one just published) beats trusting arithmetic.
- **Two implementations of "publish and tag" diverge, and then neither is right.** There is ONE function,
  `publishRootAndTag` (`packages/sdk/src/publish.ts`), used by the draft path, `abxfs upload` and `abxfs update`. It
  aborts before publishing if the count cannot be read, takes the version from the receipt's `ProjectVersionPublished`
  event, and writes no tag unless `versionAt(v).cid` equals the root just published. If you touch publishing, touch it
  THERE; do not add a second path. Every write wait also throws on `receipt.status !== "success"`.

**An org is frozen the instant `createOrg` returns, and the order inside it is load-bearing.** The
factory is the ABX owner only for the length of that call: it registers the org, declares the five schema keys (cid,
gateway, name, view, meta), wires the hooks, locks hooks / URIs / script / dependencies / contract fields, renounces,
then mints. Three orderings have each been got wrong in a test and caught:

- The hooks must be wired **before** the first mint, or the enumeration hook never sees it. That is why
  `createOrg` mints through the minter at the end and ignores ABX's own `mintTo` / `mintCount`, which
  mint before any hook exists.
- The org is registered **before** the hooks are wired, so both hooks recognise it from its first
  transfer.
- The locks are explicit even though renounce makes them unreachable, because `abx state` and other
  tooling read an unlocked flag as "still mutable".

Anything an org needs that is not in it at creation needs a **new factory and a new org
address**, so URLs change. That is the cost of the trust model, and it is why `abxfs.meta` and the
open flag exist. Do not reach for an owner, an upgrade path or a setter to avoid it.
`packages/contracts-projects/test/fork/OrgFork.t.sol` runs against the real ABX contracts and closes
every state-changing selector in ABX's ABI against every actor; the list is generated from that ABI
(`pnpm --filter @artblocks/abxfs-sdk gen:battery`) and a test fails if it goes stale, so an ABX release that adds
a mutator shows up in a diff instead of past a hand-kept list.

**Two structures are not namespaced by caller, and each admits registered orgs only.** The hooks key
nearly everything by `msg.sender`, so a forged caller can only corrupt its own namespace — that is why
neither needs access control. The global publish ledger and the owner → orgs index are the exceptions:
any contract could otherwise append to every crawler's feed or write itself into a victim's org list. So
both ask the factory `isOrg(msg.sender)`. That check is a raw `staticcall` with a hand-decoded result
and **must never revert** — a reverting, short, non-boolean or no-code registry all read as "not an
org" — because both hooks are vetoes. `test/OrgHeld.t.sol` drives each of those failure modes.

**The org name is immutable and printable ASCII only, on purpose.** It is the ABX collection name, which
freezes at renounce, and it renders in the card header. The factory only accepts 0x20..0x7e, 1..64 bytes, not all
spaces: no bidi, zero-width, control, homoglyph or invalid-UTF-8 name can ever be minted into someone's wallet. HTML
characters (`< > & " '` and the backtick) ARE allowed, so `A & B` is a valid name (by design): ABX escapes JSON but
not HTML, so everything that renders a name as markup must escape it, as `ProjectCard` does. A rename would let an org
pass as another after it had built a reputation. The name is also self-declared and copyable: nothing resolves one, nothing is
keyed by one, and no URL contains one. The address is the identity.

**The gateway refuses any org the factory did not create.** Without that, anyone could deploy a contract
that answers `tokenParam` with any root and have a gateway serve it under a project URL, outside every
subject a filter can derive from the path. `resolveRoot` calls `isOrg` before reading anything from the
address in the URL; any real ABX collection that is not an org is a good test case.

**Supported factory generations stay in the registry after they are superseded.** An org is frozen
against the factory that made it, so a fixed bug ships as a new factory and the old one's orgs keep their old hook. The
registry holds the current factory's contracts in `orgFactory` / `projectHook` / … and any earlier one in
`previousGenerations`; removing one 404s every URL under its orgs. Anything that starts from an org *address* — a URL,
a link, a list — must go through `generationOfOrg` / `addressesForOrg` / `AbxfsClient.resolveOrg`, never assume the
current factory. `forOrg` is for an org created a moment ago in this process; used on an older org it reads the wrong
hook's history, which for a publish is the silent kind of wrong. The gateway, `abxfs-mirror` (one cursor per factory)
and every CLI command already do, and a site must resolve the factory before anything that can write renders.
Content (stores, root hosts) is shared by all factories. The explicit exception is the superseded presentation test
factory `0x4a5D0fCed9b2162Db4517E7248dC0f3243CCB475`: its retirement activates only after verified replacement canonical
promotion. It is not supported history and must not be indexed or watched; direct remembered-org resolution explains
retirement without automatic minting, migration or retry. The original `0xC5aBF9fBd94659cdfc173AF30c6052700Fa62798`
factory remains supported on its original six chains. Candidate overrides must remain usable before promotion.

**Token-owner delegation is disabled in every org** (`disableTokenOwnerDelegation`, an ABX init flag): a
delegate.xyz delegate would otherwise act as the token owner and could rewrite a project's CID. `ownerOf` is
the whole authorization model, and tags and params agree on it.

**The org admin is one wallet.** There is no delegate list: it could not be enumerated on chain, and a
team belongs behind a Safe or another smart account, which is account abstraction in the right place. The
admin mints, opens or closes, and hands the role on; a handover closes the org so a door the old admin
opened does not outlive them. Do not add a second role to the factory.

**A chain without a factory has no projects, and the registry says so.** On any chain whose registry entry has no
factory, a site hides project affordances there, and the content layer works on its own. That holds for any chain
where the content layer is deployed before the factory.

## No blocklist on chain

Content is permanent and neutral, and the protocol has no blocklist: what a gateway declines to serve is that gateway's
own choice, made off chain (`@artblocks/abxfs-gateway` takes a deny list or a filter). Do not add one on chain: editorial policy
would read as protocol state, an entry could never be retracted, and writing one would need a hot key.

## Serving content

Things that are easy to undo by accident:

**Every project is its own origin, and the app origin serves no project bytes.** Project code is attacker
controlled and websites use root-absolute links, so a project is served at
`https://<chain>-<org>-<id>[-v<n>].<content domain>/` and raw content at `https://<chain>-<base32 root>.<content
domain>/` (`packages/sdk/src/content-host.ts`), from an origin that holds no secret, no session and no cookie. Every URL
names its chain, a raw root's too, and a gateway reads only that chain: a root is the same on every chain, so a URL
without one made the gateway ask every chain it served, and a made-up root cost one read per chain. Do not add a
chain-less form or a default chain back. The
content domain should be a SEPARATE registrable domain from the app (sibling subdomains are same-site, so SameSite
cookies do not isolate them), and on the Public Suffix List once it qualifies (the list wants thousands of publishers
first). `/g/p/…` and `/g/cid/…` on the app origin are strict redirects to the content origin, which is how the
`gatewayBase` frozen into every token's `animation_url` keeps working: the on-chain default stays a path on a site we
own, and WHERE content is served is off-chain configuration (`ABXFS_CONTENT_DOMAIN`). The one exception is a project's
ROOT, which is what `animation_url` is: it answers with a page framing the project's origin, because a marketplace may
show a COPY of that page from its own storage (OpenSea does), where a redirect target's relative links would break; it
names nothing but the project URL, and replaces itself with it when nobody frames it. Never let a content host reach an
app route or carry app cookies. Nor may the APP origin hold chain content as an active document: a `blob:` URL belongs
to the origin that made it, so an SVG blob opened in a tab runs there; only passive raster types may become `blob:`
URLs on an app origin, and an SVG previews from the content origin.

**There is one gateway implementation, in `packages/gateway`; a site calls it, never a copy.** Two copies is how a fix lands
in one and not the other (the publish-and-tag race was fixed in one copy and left in the other). The standalone gateway
runs in exactly one of three modes: `--content-domain` (recommended: the same per-project hosts), `--project` (one
project at `/`), or `--path-mode` (one shared origin, unsafe for untrusted content, opt-in). It is "open with a
blocklist" (`--deny`) or "these orgs only" (`--allow-orgs`). There is no IPFS shortcut: `abxfs.gateway` is a param and a trait, but the gateway serves every file from chain. Bytes fetched
through an owner-chosen gateway could only be trusted after deriving the IPFS CID of the on-chain content, which reads
the whole file from chain anyway.

**There is ONE parser for "which project is this request?"** Two parsers (`/^\d+$/` for subjects, `Number()` in the
gateway) once let `+84532`, `0x14a34` and `84532.0` skip a deny list and still serve. Everything derives from
`parseContentHost` / `classifyPath`, and only the canonical spelling parses; anything else is a 404 or 400. Do not add
a second parser.

**A filter sees subjects, and a request is refused if ANY subject it implicates is denied.** Subjects are
`project:<chain>:<org>:<id>`, `org:<chain>:<org>` and `root:<cid>` (`packages/gateway/src/subjects.ts`), with
lowercased addresses; names are never subjects. The handler asks the filter up to three times: with what the URL names,
again with the resolved root, and again with the CIDs it actually serves. Keep all three: each closes a way to reach
denied content through another URL.

**A filter that must be able to revoke a response runs ahead of every cache that holds it.** A root host's response
for the ROOT ITSELF (`c-…` serving that CID) is `immutable`; anything else a root host serves (a directory root's
`index.html`, a sub-path) and every project-host response is short-lived (`s-maxage=60`, never `immutable`), because
the check on the CID actually served happens after resolution.

## No infrastructure

ABX FS needs no indexer, database or hosted service: a site's only backend dependency is a JSON-RPC endpoint. The
gateway and the mirror are tools anyone may run, and `@artblocks/abxfs-pinning` is an opt-in library (`abxfs pin`,
`abxfs-mirror`) for people who want to pin.

If a change starts to need a database or a background service, that is a signal to re-read
[`specs/abx-fs-orgs.md`](./specs/abx-fs-orgs.md) ("Reading a project: no indexer") first — the whole point is that the
chain answers these questions.

## The `pnpm.overrides` block is load-bearing

Every entry in root `package.json` under `pnpm.overrides` exists to close a transitive CVE that no
direct dependency bump reaches. JSON cannot carry a comment, so the reasoning lives here:

| Override | Why |
| --- | --- |
| `ws@8` | Via `viem > isows`. |
| `postcss` | `next` pins `postcss` exactly, so bumping the direct devDependency does not reach next's own copy. |
| `source-map-js` | Via `next > postcss` (build-time only); `^1.2.2` closes the advisory in 1.2.1. |
| `zod` | A peer of the viem stack, one 4.x copy across the tree; `^4.6.6` closes the memory-exhaustion advisory. |

Each stays inside the overridden package's current major on purpose: an override raises a floor, it
does not hand a dependency an API it never asked for. Keep that rule when adding one.

Run `pnpm audit` before assuming the list is current, and prefer a real dependency upgrade over a
new override whenever one exists.

## Testing

```bash
pnpm run typecheck      # every package, INCLUDING test files
pnpm run test           # typecheck, the contracts, then every package's tests
pnpm run test:contracts # forge, all four Solidity packages
```

Test files are type-checked via each package's `tsconfig.test.json`. Excluding them once let a test calling a deleted
method pass a green typecheck — do not re-exclude them.

**Fork tests need an RPC and are skipped without one.** They run against the real ABX contracts on Base Sepolia, and
they are not only in `test/fork/`: `*Fork.t.sol` files sit in `test/` and the audit folders too, so run the whole
suite with the RPC set: `ABXFS_RPC_URL_84532=… forge test` in `packages/contracts-projects` (about 20 minutes on a
public endpoint). They are the only tests that can say what a renounced real collection is, and the stand-in in
`test/mocks/AbxMocks.sol` is only as honest as they are. Run them when you touch the factory, a hook, the deploy
script or the ABX version. Never `vm.setEnv` in a test: env vars are process-global and forge runs tests in parallel;
pass inputs (the deploy script has `runWith`). Two deliberate exceptions, each the ONLY reader of the names it sets:
`DeployRunEnv.t.sol` sets the real deploy variables to prove `run()` maps each one (nothing else may read those names
in a test), and `DeployScriptBranches.t.sol` uses names no code reads (`ABXFS_COVERAGE_TEST_*`).

**Project-level behavior is tested in Solidity, not TypeScript.** Exercising the publish path
end-to-end from TS needs a deployed ABX collection, which means standing up ABX's factories, renderer,
minter and seed source on anvil — ABX-side infrastructure this repo should not reproduce and that
would rot against ABX releases. So `ProjectHook.t.sol` covers validation, the kind lock, version
numbering, and tags directly against the veto. Three `draft.test.ts` cases are skipped for exactly
this reason, with the gap stated in prose rather than hidden.

Prefer mocks over real stores where the contract under test only depends on a predicate: the hook's
entire relationship with the stores is `directoryExists` / `fileExists`.

**Vitest runs the body of a skipped `describe` while collecting**, so anything there that throws, such as
`requireCanonicalAddresses` on a chain with no deployment, breaks the whole file even when every test in it is skipped.
Look such values up lazily, inside a test or a `beforeAll`. A test file's own `vi.mock` of a module replaces the setup
file's mock of it rather than extending it.

**SDK anvil tests can deploy contracts-core's test mocks** (`test/mocks/Backends.sol`: a log-only backend, scripted
and re-entrant ones): `forge build` (or `forge test`) in `packages/contracts-core` compiles them into `out/`, and
`deployCoreArtifact` in `packages/sdk/test/helpers/anvil.ts` deploys one from there. `forge script` compiles only the
script's own sources, so on a fresh clone build the contracts before the SDK tests.

**Chain tests deploy once per run, and test clients poll anvil every 50 ms.** The SDK, CLI and pinning suites list
`packages/sdk/test/helpers/anvil-setup.ts` as their Vitest `globalSetup`: it runs the real deploy scripts once, and
each `startAnvilWithAbxfs` loads the result into its own anvil, so SDK test files run in parallel (`forge script` once
per file shared contracts-core's `cache/` and `broadcast/` between concurrent runs). A new package whose tests use the
harness lists the setup too. viem polls every 4 s by default, and anvil answers a send before it has mined a large
transaction, so the first receipt check missed and the write waited a whole interval: that was most of a 27-minute SDK
suite. The SDK's own wait for a bundle's receipt (`firstMined` in `multicall.ts`) polls at the client's interval when
that is under its one second, for the same reason. So a client a test builds to write to anvil takes `ANVIL_POLLING_MS`,
except in the call-volume tests (`Audit4CallVolume`, `Audit4RateLimit429`), which keep the real clients' polling
because polls are part of what they count.

**The repository is public, and `pnpm check:hygiene` (CI) keeps it that way.** It refuses planning notes, review
checklists, submission drafts, local state and build output, fails on a relative Markdown link that does not resolve,
and scans for credentials. Work tracking belongs in GitHub Issues, not in `docs/`. A file that needs a
credential-shaped test vector (the upload scanner's) is listed in the script's `FIXTURES` with the reason.

## Mode of operation

- Broad exploration: use the `Explore` subagent.
- Small, single-file changes: just read and edit.
- When you change an interface, check whether `packages/sdk/src/abi.ts`, `abi-hook.ts`,
  `abi-enumeration.ts` or `abi-org.ts` mirrors it — `test/abi-drift.test.ts` compares them against
  `forge inspect` and will fail if they drift. ABX's
  own ABI is NOT mirrored: it comes from `@artblocks/abx-sdk`, so there is nothing local to sync.
