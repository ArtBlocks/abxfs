# ABX FS

> **Prerelease, and unaudited.** ABX FS is early software and may have bugs; we do not guarantee it is bug-free. Its
> contracts have had no independent security audit yet, and neither has ABX, which every org is built on. Everything
> published is public and permanent, and on a production network real funds are at risk.

A permissionless, content-addressed, immutable file system on chain.

Uploading to ABX FS means writing bytes through a storage backend into a content-addressed chunk store, with the
index of every file and directory kept on chain. That is the whole storage layer, and it is the backstop for everything
else: IPFS is an opt-in way to serve content from elsewhere, never a requirement for reading it.

A **project** is an [ABX](https://docs.abx.io) NFT inside an **org**, which is its own ABX
collection created by one immutable factory. A project's owner has the authority to publish new
versions, move tags, and hand the project on — and that is the entire authorization model, because
ownership is `ownerOf`. The factory renounces ownership of every org at creation, so nobody, the
org's admin included, can change how an org works; the admin only decides who may mint into it.

```
        content layer                       project layer
  ┌──────────────────────────┐      ┌──────────────────────────────┐
  │ ChunkStore    → chunks   │      │ ABX NFT, in an org           │
  │   (bytes in backends)    │      │                              │
  │ FileStore     → files    │◄─────│   abxfs.cid      (root)      │
  │ DirectoryStore→ trees    │      │   abxfs.name                 │
  │                          │      │   abxfs.gateway  (optional)  │
  │ permissionless, immutable│      │   owner = publish rights     │
  └──────────────────────────┘      └──────────────────────────────┘
 <chain>-<root>.<content domain>    <chain>-<org>-<token>.<content domain>
```

The two layers are independent on purpose. A root's own host (`https://<chain>-<base32 root>.<content domain>/`)
resolves any content stored on that chain whether or not a token points at it, so the content layer is usable on its own
and anyone can build a different project abstraction on top of it. Every project is served from its own
host (`https://<chain>-<org>-<id>.<content domain>/`) and the app's origin serves no project bytes; the
`/g/cid/…` and `/g/p/…` paths on the app redirect to those hosts (a project's root, its `animation_url`, is a page that
frames it). See
[Run a gateway](https://docs.fs.abx.io/docs/using-abxfs/run-a-gateway).

## Why a project is an NFT

Everything a project needs from an owner model, an NFT already has: single-owner authorization, transfers (and sales on
any marketplace), and a typed parameter layer to hold the current root. Token-owner delegation (delegate.xyz) is
disabled in every org, because a delegate would act as the owner; a team uses a Safe.

What the parameter layer alone cannot give is *integrity*, so [`ProjectHook`](packages/contracts-projects/src/ProjectHook.sol)
supplies it as an ABX configure hook — non-view, running before the value persists, so a revert vetoes
the write. It enforces that a published root actually exists in `DirectoryStore` or `FileStore`, that a
project's root kind is fixed at first publish, and that republishing the head is rejected. It also
keeps history, tags and publish ledgers in contract storage, which is how every read stays a single `eth_call`.

There is no indexer and no database. The hooks maintain the indexes on chain as writes happen, so the chain is the
index. Nothing reads `eth_getLogs`, deliberately: providers prune logs, and an index that expires is not an index.

The design is in [`specs/abx-fs-orgs.md`](specs/abx-fs-orgs.md); the content layer is in
[`specs/abx-fs.md`](specs/abx-fs.md).

## The gateway

The gateway (`packages/gateway`, which runs anywhere as `abxfs-gateway` or inside a site) has no
backend but an RPC endpoint. It resolves the URL to a root CID and **serves the response from chain**, through
`ChunkStore.read`, which checks every chunk against its record. Like any dapp it trusts the RPC it reads through, so
point it at one you trust. A project's `abxfs.gateway` (where its owner pinned it on IPFS) is published as a hint and
not fetched: bytes from IPFS are only trustworthy once checked against the IPFS CID of the on-chain content, and
deriving that reads the file from chain anyway.

Content addressing pays for the rest: a root host serving the root itself (a file root, or a directory root's own
listing) is immutable and cached for a year, so the chain path only runs on a cold miss. What a root host serves
beneath the root (a directory root's `index.html`, a file under a path) is cached for a minute, because the CID
actually served is checked by the gateway's filter after resolution, and an `immutable` response could never be revoked.
Project hosts (latest and pinned versions alike) are short-lived, because the bytes they name can change when the owner
publishes.

## Status

- **Deployed** on production networks and their testnets, at the same addresses on each
  ([deployments](https://docs.fs.abx.io/docs/reference/deployments)). Every source is verified on Sourcify. Internal audits are summarized in
  [`docs/internal-audit-summary.md`](docs/internal-audit-summary.md); an independent audit has not been done yet.
- **Same address on every chain.** Every contract is CREATE2 through the keyless deployer with a fixed salt and no
  sender-dependent argument. The storage backends' addresses are part of every chunk id, so identical bytes on any
  chain produce identical CIDs.
- **Frozen orgs.** Every org is frozen the moment it is created — ownership renounced, hooks and URIs locked — so a bug
  in the factory, a hook, the minter or a renderer cannot be fixed for orgs that already exist, only superseded by a
  new factory. So try a new org on a testnet first: on a production chain, what you create is permanent.
- **Defensively published.** The innovations here were disclosed publicly through Technical Disclosure Commons, so
  there is no hold of any kind on building, deploying, or discussing this work in the open:
  - [Disclosure 11507](https://www.tdcommons.org/dpubs_series/11507/)
  - [Disclosure 11508](https://www.tdcommons.org/dpubs_series/11508/)

## Layout

| Package | Description |
|---|---|
| `packages/contracts-core` | The content layer: `ChunkStore`, `IStorageBackend` with `Sstore2Backend` and `FastLzSstore2Backend`, `FileStore`, `DirectoryStore`. |
| `packages/contracts-projects` | The org layer: `OrgFactory`, `OrgMeta`, `OrgMinter`, `ProjectHook` (integrity, history, tags), `ProjectEnumeration`, `ProjectCard` (the token's on-chain SVG `image`), `ProjectTraits`, `ProjectLinks`, `Lens`. |
| `packages/protobuf-sol` | Solidity protobuf, dag-pb, UnixFS, CIDv1, base32. |
| `packages/contracts-companion` | `IpfsCidResolver`: view-only IPFS CIDv1 derivation from content on chain. |
| `packages/sdk` | TypeScript SDK (`@artblocks/abxfs-sdk`). |
| `packages/cli` | The `abxfs` CLI (`@artblocks/abxfs-cli`). |
| `packages/gateway` | The gateway and IPFS mirror (`abxfs-gateway`, `abxfs-mirror`). |
| `packages/pinning` | Opt-in IPFS pinning, for anyone who wants to pin. |
| `site` | The documentation site, published at [docs.fs.abx.io](https://docs.fs.abx.io). |

The website at [fs.abx.io](https://fs.abx.io) is Art Blocks' hosted service on these packages, maintained separately.

## Quick start

The SDK ships every network's addresses, so reading needs no config file, no API key, and no local chain. Every command
(except `abxfs dev`, which runs its own local chain) takes `--chain <network>`, the production or test network of your choice (the
[deployments](https://docs.fs.abx.io/docs/reference/deployments) page lists them):

```bash
pnpm install
pnpm --filter "@artblocks/abxfs-cli..." build   # the CLI and the packages it uses

# Zero config: the canonical deployments are built in.
node packages/cli/dist/index.js read <root-cid> --path index.html --chain <network>

# Projects live in orgs. Try them on a testnet first.
node packages/cli/dist/index.js org list --address 0x… --chain <network>
node packages/cli/dist/index.js info --project-id 0 --org 0x… --chain <network>
```

`abxfs dev` (below) gives you a local chain with the content layer deployed.

Point at your own endpoint with `ABXFS_RPC_URL_<chainId>=…` — worth doing, since the built-in defaults are unkeyed
public nodes. See the
[quickstart](https://docs.fs.abx.io/docs/using-abxfs/quickstart).

### Contributor setup

```bash
corepack enable
pnpm install --frozen-lockfile
./scripts/install-forge-deps.sh       # the Solidity libraries, each checked against its pinned commit
pnpm build:contracts
pnpm -r --filter "./packages/*" build  # packages read each other from dist

pnpm run test          # typecheck, the contracts, then every package's tests
pnpm run test:contracts

# Local chain: deploys the content layer (add --companion for IpfsCidResolver).
# It deploys the org factory only when ABX_SERIES_CODE_FACTORY (and ABX's renderer and seed source)
# are in the environment — a fork has them; a fresh anvil does not, and a local harness has no business
# standing up ABX's own factories. Org behavior is tested against a stand-in, and against the real ABX
# contracts by the fork tests in packages/contracts-projects/test/fork.
node packages/cli/dist/index.js dev --i-trust-this-dir
```

Deploying to another network follows [`docs/deploy-runbook.md`](docs/deploy-runbook.md). The scripts refuse to broadcast anything but the pinned
build to a listed chain. In outline:

```bash
# 1) Content layer
cd packages/contracts-core
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast

# 2) The org factory, its five components (hook, enumeration hook, minter, card, traits renderer: each its own
#    transaction, at an address the factory computed) and the lens. Nothing is wired by hand.
cd ../contracts-projects
ABXFS_DIRECTORY_STORE=0x… ABXFS_FILE_STORE=0x… ABXFS_GATEWAY_BASE=https://fs.abx.io \
  ABX_SERIES_CODE_FACTORY=0x… ABX_METADATA_RENDERER=0x… ABX_SEED_SOURCE=0x… \
  forge script script/Deploy.s.sol:DeployProjects --rpc-url "$RPC" --broadcast

# 3) Optional: the IPFS CID resolver, over the stores from step 1
cd ../contracts-companion
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast
```

The ABX addresses come from the ABX SDK's deployment registry for that chain. Every org is then one
`createOrg` call, which deploys the collection, wires and locks the hooks, renounces ownership and
mints the first project. The hook is a veto on every `abxfs.cid` write and cannot be changed for an
existing org, so prove the flow on the paired testnet first.

## Docs

User-facing documentation lives in [`site/`](site) and is published at
**[docs.fs.abx.io](https://docs.fs.abx.io)** — quickstart, projects, protocol, and the canonical
addresses. Edit the MDX under `site/content/docs/`, not a copy somewhere else.

What stays in the repo:

- [`specs/abx-fs.md`](specs/abx-fs.md) — the content layer and IPFS derivation; start here
- [`specs/abx-fs-orgs.md`](specs/abx-fs-orgs.md) — projects and orgs
- [`docs/deploy-runbook.md`](docs/deploy-runbook.md) — deploying to a network
- [`AGENTS.md`](AGENTS.md) — orientation for coding agents

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing contracts, packages or the site. Do not report vulnerabilities
or credentials in a public issue: [SECURITY.md](SECURITY.md) describes the private process. To report content served
by the site, email `legal@artblocks.io`.

## License

[MIT](LICENSE).
