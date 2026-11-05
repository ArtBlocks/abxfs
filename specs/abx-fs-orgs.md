# ABX FS: projects and orgs

Status: **specified, implemented, and deployed** (build `abx-fs-freeze-3`) on production networks and their testnets,
at the addresses in `packages/sdk/src/canonical.ts`. The content layer a project points at is [`abx-fs.md`](./abx-fs.md). Contracts:
`packages/contracts-projects`.

A **project** is an [ABX](https://docs.abx.io) NFT. Its owner has the authority to publish new versions,
move tags and hand the project on, and that is the entire authorization model: `ownerOf`. Project state lives in ABX
PostParams, integrity is enforced by an ABX configure hook, and history is kept in contract storage, so every read is
an `eth_call` and nothing needs an indexer or a database.

An **org** is its own ABX collection, deployed by one immutable factory. Projects are tokens inside an org, so a
project is named by **chain + org + token id** (token ids repeat across orgs). The point is separation: a project's
URL, its collection on a marketplace, and its neighbours belong to the org, not to a shared pool.

Orgs separate the project layer only. Content is one global permissionless store: the same bytes resolve whatever org,
if any, points at them, and anyone can build a different project abstraction on the same stores.

## Decisions

| Decision | Choice |
| --- | --- |
| Org admin power over project content or the NFT contract | **None.** The factory renounces ABX ownership at creation. An org works like an NFT collection, not a GitHub org: once minted, a project (publish, name, tags, transfer) belongs to its holder alone, including one the admin minted to someone else. Publish authority is ABX's token-owner check; the hooks can only veto. |
| Mint | **Admin-only by default**, with a per-org `open` flag that lets anyone mint. One admin wallet and nothing else: no delegate list, which could not be enumerated on chain. A team makes the admin a Safe or another smart account. While an org is open, anyone can mint it up to its supply cap, which can never rise, and a full org takes no new projects (existing ones are untouched). Opening is the admin's risk to take, for as long as they need it; the site warns at the toggle. |
| Personal org | **Uniform.** The tools create one in a user's first publish, in the same transaction as the first project. No shared commons. |
| Org name | **Immutable, printable ASCII only** (0x20..0x7e, 1..64 bytes, at least one non-space), else `InvalidName`. It is the ABX collection name, which freezes at renounce, and it reaches the token's `name` field and the card; ABX escapes JSON but not HTML or invalid UTF-8. HTML characters are allowed (`A & B` is a name), so anything that renders a name as markup must escape it; the card does. No rename, so no renaming into someone else's reputation. The name is self-declared and copyable: nothing resolves one and no URL contains one. The address is the identity. |
| Org description | **Optional and immutable**, passed to `createOrg`: 0..1000 bytes of printable ASCII or newline, not only whitespace if non-empty (`InvalidDescription`). Also every token's fallback `description`. Without one, the collection document says `<name> is an org on ABX FS. Each token in it is a project: a website or set of files.` |
| Token names | **The project's own `abxfs.name`** when it is 1..128 bytes of printable ASCII, not only spaces and not `-` (the SDK's "cleared" marker); otherwise `<org name> #<id>`. The name stays the holder's to change; the rule only decides whether a marketplace shows it. The card and the Named trait apply the same rule, so all three agree on whether a project has a name. The SDK mirrors it as `projectNameShowsOnMarketplaces`. |
| Token-owner delegation | **Disabled** (`disableTokenOwnerDelegation`). A delegate.xyz delegate would otherwise act as the token owner and could rewrite a project's CID. Frozen per org. |
| Supply cap | **1,000,000 projects per org.** ABX only lets a cap go down, so it is set once at the ceiling; it also keeps project host labels within DNS's 63-character limit. |
| Royalty | **0%, with a cap of 0%**, so it can never rise. |
| Transfer validator | None. Tokens are not burnable. Symbol `ABXFS`. |
| Org address | A plain deploy, or a deterministic salt: first 20 bytes zero = anyone may use it, otherwise they must equal `msg.sender` (`SaltSenderMismatch`). A zero-prefix salt can be taken by whoever sees it first, so pre-announce an address only with a salt bound to your own address. |
| Token links | Per project: `abxfs.view` is the whole URL for `animation_url` and `external_url`; otherwise a default path on `https://fs.abx.io` (below). |
| Extensibility | The reserved `abxfs.meta` String key, token-owner writable, 4,096 bytes. |
| Versioning | The factory is immutable. A fix is a new factory at a new address, and new orgs; the SDK registry lists every factory. |
| Multi-party | Not in the protocol. Admins and token owners may be Safes. For a team, the admin Safe mints the org's projects to itself, so the org holds them; minting to anyone else gives the project away, and the site and CLI warn before it. Uploading is permissionless, so only the publish (`configureTokenParam`) and any `setTag` need the Safe's signature. |

## Contracts

All immutable; none has an owner. Each is deployed with CREATE2 through the keyless deployer with a fixed salt
([`abx-fs.md`](./abx-fs.md) §2), so any key deploys it at the same address on every chain where ABX sits at the same
addresses (it does on every network ABX FS is deployed on).

- **`OrgMeta`** (salt `keccak256("abx-fs/org-meta")`, argument: the gateway base `https://fs.abx.io`). Renders each
  org's ERC-7572 collection document (`contractURI`: name, description, a monogram logo, a banner and an
  `external_link` to the gateway base) and every token's `name`. It deploys **`ProjectLinks`**, the `animation_url` /
  `external_url` renderer, with the same base.
- **`OrgFactory`** (salt `keccak256("abx-fs/org-factory")`; arguments: ABX's series-code factory, metadata renderer and
  seed source, the `DirectoryStore` and `FileStore`, and `OrgMeta`). `createOrg(name, description, salt)`, an
  append-only org list (`orgCount`, `orgAt`, `orgsSlice`), `isOrg`, `adminOf`, `orgsAdministered` (and
  `orgsAdministeredSlice`), `createdBlockOf`,
  `predictOrg` (reverts for a zero salt: a plain deploy has no predictable address), `isOpen`, `mayMint`, `setOpen`, and
  a two-step `transferAdmin` / `acceptAdmin`. The admin is always `msg.sender` of `createOrg`, never a parameter, so
  nobody can name you admin of an org you did not create.
  **Five components sit beside it: the hook, the enumeration hook, the minter, the card and the traits renderer.**
  Each needs the factory's address (or the hook's) and the factory needs each of theirs. The constructor breaks the
  cycle without an initializer: it computes each component's address as the keyless CREATE2 deployer would place it
  (`COMPONENT_SALT`, the component's creation code, and constructor arguments naming this factory or its hook) and
  keeps the addresses as immutables. Anyone then deploys each component through that deployer, in its own
  transaction; only that exact code can land at each address, and `createOrg` reverts `ComponentsNotDeployed` until
  all five exist (`componentsDeployed()`). Their creation code is part of the factory's initcode, so a change to any of
  them moves the factory's address. Deploying them in the constructor instead would put about 43 KB of code in one
  transaction: 67.7M gas under EIP-8037, over Ethereum's 60M block. `OrgMeta` and `ProjectLinks` need neither address
  and are deployed first, which keeps the factory's initcode under EIP-3860's limit.
- **`OrgMinter`.** ABX's reference minter authorizes configuration through the collection's `owner()`, which is zero
  after renounce. This one asks the factory: `mint(org, to)` succeeds for the factory itself (how `createOrg` mints the
  first project), the org's admin, or anyone while the org is open. No state, no price.
- **`ProjectHook`** (the configure hook). Validates every `abxfs.cid` write against the stores and records history,
  tags and the publish ledgers (below).
- **`ProjectEnumeration`** (the transfer hook). ABX collections are not ERC-721Enumerable, so this indexes owner →
  tokens per org and owner → orgs held (`orgsHeldBy`), updated when a holder's count in an org crosses 0 or 1. It keeps
  no copy of an org's whole token set: an org numbers its tokens 0, 1, 2, … in mint order and nothing in it can be
  burned, so its tokens are exactly `0 … nextTokenId() - 1`, which the org itself answers.
- **`ProjectCard`** (`image`): an SVG card computed on chain. Its header is the org's own ERC-721 `name()`, falling
  back to "ABX FS"; under it, the token's `#<id>` (a project may name itself after a sibling, "Acme #0" on token 3, and
  the id is what tells them apart), its name under the token-name rule above ("untitled" otherwise), and its version
  and root. Names are escaped for the SVG with Solady's `escapeHTML`.
- **`ProjectTraits`** (`attributes`): Status (Published / Unpublished), Root Kind, Versions, Named (the token-name rule
  above), Preferred IPFS Gateway (Set / None; `-` is None). Facts a collector can check against chain state, read from
  the same places a gateway reads.
- **`Lens`** (salt `keccak256("abx-fs/lens")`; arguments: the factory and its hook). Stateless and replaceable:
  `resolve(org, tokenId)` returns registered, kind, cid, owner and gateway in one `eth_call` and never calls an
  unregistered address; `publishRange(start, count)` returns the cross-org ledger with full records.

**The renderers must never revert.** ABX's metadata renderer `staticcall`s each field renderer with no try/catch, so a
revert bricks the whole `tokenURI`. `try/catch` is not enough: a staticcall to a no-code address succeeds with empty
returndata, and a return-data decoding failure is not catchable. So every external read in `ProjectCard`,
`ProjectTraits`, `ProjectLinks` and `OrgMeta` is a raw `staticcall` with a hand-decoded result, and anything short,
malformed or oversized reads as unset with a defined fallback.

## `createOrg`

Order matters, and the hooks must be wired before any mint.

1. Deploy through ABX's factory with `owner = factory`, `minter = OrgMinter`, `maxInvocations = 1,000,000`,
   `royaltyBps = 0` and `maxRoyaltyBps = 0`, no transfer validator, not burnable, unpaused,
   `disableTokenOwnerDelegation = true`, `mintTo` / `mintCount` zero. The card, traits, links and name renderers (and
   the description, if any) ride the deploy as contract fields.
2. Register the org, before wiring, so neither hook is ever called for it while it is unregistered: both gate a
   cross-org structure on `isOrg`.
3. `setParamSchema` for `abxfs.cid`, `abxfs.gateway`, `abxfs.name`, `abxfs.view`, `abxfs.meta`.
4. `setParamHooks` (configure and transfer).
5. `lockParamHooks`, `lockTokenURI`, `lockContractURI`, `lockScript`, `lockDependencies`, and `lockContractField` for
   every field set at creation. Renouncing already makes these unreachable, but ABX's tooling reads an unlocked flag
   as "still mutable", so the chain is made to say what is true.
6. `renounceOwnership`.
7. Mint the first project to the admin through the minter.

Do **not** use ABX's `mintTo` / `mintCount` for the first project: that mint would land before the hooks are wired,
and the enumeration index would never see it. A test breaks the contract on exactly this and fails.

## Trust properties after `createOrg`

Nobody, including ABX FS and the org's admin, can change the schema, hooks, renderers, URIs, minter, supply cap,
royalty, transfer validator or pause state. The admin can set the mint rule and hand the role on. A project's content
authority is `ownerOf` and nothing else.

The cost is that every fix is a new factory and a new org address, so URLs change. Hence `abxfs.meta` and the open flag.
Frozen with each org: the hooks, the minter, the renderers, and ABX's own implementation, which has had no independent
audit.

## The admin

One wallet per org. It mints (or opens the org so anyone can), and hands the role on. It has no power over any project.

- `transferAdmin(org, to)` offers the role; offering to `address(0)` withdraws an offer. Nothing changes until
  `acceptAdmin`, so a mistyped address cannot strand an org.
- `acceptAdmin` **closes the org.** A handover is how an org recovers from a compromised admin key, so a door the old
  admin opened does not outlive them; the new admin opens it deliberately. With no offer pending it refuses
  (`NotPendingAdmin`), whoever calls.
- There is no renounce: an org with no admin could never mint again.

## The param schema

Declared once per org at creation and applying to every token. Keys are short ASCII packed into `bytes32` (not hashed),
so they are readable on chain: `bytes32("abxfs.cid")` equals `stringToHex("abxfs.cid", { size: 32 })`. The bytes are
pinned in both `packages/sdk/test/project-keys.test.ts` and `packages/contracts-projects/test/ParamKeys.t.sol`.

```
abxfs.cid      : Uint256Range : TokenOwner    # current root CID (raw bytes32)
abxfs.gateway  : String       : TokenOwner    # optional preferred IPFS gateway (≤ 512 bytes)
abxfs.name     : String       : TokenOwner    # human label (≤ 128 bytes)
abxfs.view     : String       : TokenOwner    # optional URL for the token's links (≤ 512 bytes)
abxfs.meta     : String       : TokenOwner    # namespaced JSON for clients, see below (≤ 4,096 bytes)
```

**The CID rides a `Uint256Range` param, not `Bytes`.** A `String` / `Bytes` param stores an SSTORE2 blob, and both its
event and `tokenParam` carry only `keccak256(data)` (flagged `valueIsHash`). A scalar param carries the raw value, and an
ABX FS root is exactly a `bytes32`; `Uint256Range` with no bounds is the scalar type that holds a full 256-bit value.
Tooling passes `bytes32`; only ABX's raw `configure-param` CLI needs the decimal form.

### `abxfs.meta`

The hook polices only its size and nothing on chain reads it. So that clients written years apart can share it, its
value is a JSON object (UTF-8, at most 4,096 bytes) with namespaced keys: `abxfs:<name>` for keys this spec defines, a
reverse-DNS prefix for anything else (`com.example:theme`). Readers ignore keys they do not know; writers keep them,
editing the object rather than replacing it. A value that is not a JSON object reads as `{}`.

Defined keys:

- `abxfs:successor` and `abxfs:predecessor`, each `{"chain": <chain id>, "org": "<address>", "token": "<decimal id>"}`.
  This is how a project moves to an org made by a later factory: an org is frozen against the factory that made it, so
  a fix ships as a new org address. A gateway MAY answer the old project's host with a permanent redirect to the
  successor's, but only when the successor is a project in an org the registry knows AND its own `abxfs.meta` names
  this project as `abxfs:predecessor`. The two-way link shows the holder of both agreed, so no project can claim to
  replace one it does not hold. Nothing implements the redirect yet; the keys are fixed now so that the first writer
  and the first reader agree.

No kind key: whether a root is a file or a directory is derived by asking the stores, and the hook keeps it fixed.

Declaring a schema closes ABX's owner-only raw setter on that key for good, and every org renounces at creation, so
nobody can rewrite anyone's project and nobody can repoint a key's auth.

## The configure hook

`onParamConfigured(tokenId, key, value, updatedBy, dataLength, dataBlobAddress)` is non-view and runs **before the value
persists**, so a revert vetoes the write.

- **`abxfs.cid`:**
  - The root must exist in `DirectoryStore` or `FileStore` (`RootNotFound`). The empty directory and the empty file
    are valid roots.
  - Its kind (directory or file) is fixed at the first publish (`RootKindLocked`).
  - Republishing the current root is refused (`SameRoot`).
  - The hook records `(cid, publishedAt, publisher)` in the token's history (two slots, the kind in the second's spare
    bytes), appends one slot (`tokenId << 32 | version`) to the org's publish ledger and, for a registered org, one to
    the cross-org ledger. A token id above `2^224 - 1` or a version of `2^32` does not fit the entry; only a caller that
    is not an org can reach either (an org's ids are below its supply cap), and such a publish is kept in the history and
    left out of both ledgers.
  - A project locked to File asks `FileStore` first, anything else `DirectoryStore` first; under collision resistance a
    root is in at most one store, so the order changes only the gas.
  - It emits `ProjectVersionPublished(token, tokenId, version, cid, kind, publisher)`, with `token`, `tokenId` and `cid`
    indexed.
- **`abxfs.name`, `abxfs.gateway`, `abxfs.view`, `abxfs.meta`:** only their size is policed (`BlobTooLarge`, at the caps
  above). ABX imposes no size budget, and an unbounded string would let an owner push their own token's `tokenURI` past
  what common RPCs serve.
- **Any other key is ignored, never rejected.** Hooks freeze before a collection renounces, while `setParamSchema`
  could still add keys, so a hook that rejected the unknown would forbid every future key. A test and a fuzz case
  guard this.
- The collection surface (`tokenId == type(uint256).max`) carries no project and is ignored.

**The hook is a veto, and it is frozen.** A bug that wrongly reverts would freeze publishing for every org built on it,
and after renounce it can never be swapped or cleared. Weight "must NOT revert" cases as heavily as "must revert"
ones. It must be an immutable deployment: a proxy would make `paramHooksLocked() == true` mean "these addresses can never
change" while the behaviour behind them still could.

State is namespaced by the calling collection (`msg.sender`), so one hook serves every org and a forged caller can
only touch its own namespace. Reads take the collection address explicitly.

### Tags

`setTag(token, tokenId, tag, version)` and `removeTag(token, tokenId, tag)` are gated on
`IERC721(token).ownerOf(tokenId) == msg.sender` (`NotProjectOwner`). Tags match `^[a-z0-9][a-z0-9._-]{0,63}$`, so
semver-shaped tags work and case-folding cannot make two tags that look alike. `latest` is reserved and virtual: it
always resolves to the head, has no storage, and cannot be set or removed.

## The transfer hook

`ProjectEnumeration.onTokenTransfer` runs inside every transfer, and a mint is a transfer from `address(0)`, so a
revert would block transfers **and** mints, permanently once hooks are locked. It therefore never reverts: where its
records and a reported transfer disagree, it repairs toward the truth instead of asserting. A token leaves the owner the
index records (whatever `from` says), that owner's count in the org always drops, and a list entry is popped only from
the position the record names and only if the list really holds that token there. Accounting is O(1) per move
(swap-and-pop), one slot per token (its owner and position) and one per holder and org (count and position), paid by
whoever moves the token.

## Two structures admit registered orgs only

Everything else in both hooks is namespaced by caller. The cross-org publish ledger (`ProjectHook`) and the owner →
orgs index (`ProjectEnumeration`) are not: without a gate, any contract could append to every crawler's feed or write
itself into a victim's org list. So both ask the factory `isOrg(msg.sender)`. That check is a raw `staticcall` with a
hand-decoded result and never reverts: a revert, a short return, a non-boolean word, no code or no registry all read as
"not an org", and the write proceeds without the gated structure. **A veto must not gain a revert path from an unrelated
contract.** `test/OrgHeld.t.sol` drives each of those failure modes.

## Token metadata

| Field | Renderer | Value |
| --- | --- | --- |
| `name` | `OrgMeta` | the project's `abxfs.name` when usable, else `<org name> #<id>` |
| `description` | inline contract field | the org's description, if it has one |
| `image` | `ProjectCard` | the on-chain SVG card |
| `attributes` | `ProjectTraits` | the five traits above |
| `animation_url` | `ProjectLinks` | `abxfs.view`, else `https://fs.abx.io/g/p/<chain>/<org>/<id>/latest/` |
| `external_url` | `ProjectLinks` | `abxfs.view`, else `https://fs.abx.io/projects/<chain>/<org>/<id>` |

The collection surface links to the site itself, `https://fs.abx.io`, and so does the collection document's
`external_link`. These paths must answer for as
long as tokens exist; redirects are fine, and what is served there is off-chain configuration.

**`abxfs.view`.** A usable value is `https://` followed by visible ASCII, at most 512 bytes, with none of
`" & ' \ < > ` and the backtick (they could leave the JSON string or a quoted attribute, or open markup), `{ } | ^` (not
allowed in a URI at all) or `( ) [ ]` (they end a Markdown link or an unquoted CSS `url()`). It is attacker-controlled
input flowing into a URL a marketplace will open or embed, in contexts the frozen renderer cannot see, so only `https`
(never `javascript:` or `data:`). Each refused character can be written percent-encoded; `%` and `@` mean nothing to
JSON, HTML, CSS or Markdown and stay. When usable, BOTH link fields are exactly that URL, with nothing appended.
Anything else reads as unset, and the default applies.

**`abxfs.gateway`** is the owner's preferred IPFS gateway: an availability hint shown as a trait. Gateways use it only
by their own policy. Ours does not fetch through it: bytes from an IPFS gateway are only trustworthy once checked
against the IPFS CID of the on-chain content, and deriving that reads the file from chain anyway.

## Reading a project: no indexer

| Query | How |
| --- | --- |
| Current root CID | `tokenParam(tokenId, "abxfs.cid")` |
| Owner | `ownerOf(tokenId)` |
| Version history | `ProjectHook.versionsRange(org, tokenId, …)`, `versionAt`, `versionCount`, `latestVersion` |
| Kind | `ProjectHook.kindOf(org, tokenId)`: `Unset` (0) before the first publish, then `Directory` or `File` |
| Tags | `ProjectHook.listTags`, `getTag`, `getTagsRange` |
| An org's recent publishes | `ProjectHook.recentPublishes(org, n)`, `recentPublishesBefore`, `publishRange` |
| Everything published | `Lens.publishRange(start, count)` with `ProjectHook.globalPublishCount()` |
| Projects owned by X | `ProjectEnumeration.tokensOfOwner(org, owner)` (and `tokensOfOwnerSlice`) |
| Every project in an org | ids `0 … nextTokenId() - 1`: the org's own `nextTokenId()` (equal to its `totalSupply()`; nothing burns) |
| Orgs X holds a project in | `ProjectEnumeration.orgsHeldBy(owner)` (and `orgsHeldSlice`) |
| Orgs X administers | `OrgFactory.orgsAdministered(admin)` (and `orgsAdministeredSlice`) |
| A gateway's resolution | `Lens.resolve(org, tokenId)` |

**Every row is an `eth_call`. Nothing reads `eth_getLogs`.** `TokenParamConfigured` indexes both `tokenId` and `key`,
so one filtered log query could reconstruct a project's history, but logs are not permanent state: providers prune
them (one public endpoint measured keeps a rolling ~33 days), and once a collection outlives the window a scan
anchored at its deploy block fails outright with `pruned history unavailable`. Measured against an endpoint that did
retain: 221 s to list one owner's projects, 273 s for a recent feed, both growing with chain age forever. So the
indexes live in the hooks, written in the same transaction as the change they record, in storage that is never pruned.

A project can exist with no content: minting and publishing are separate acts, so `cid` is unset and `kind` is `Unset`
until the first publish. Every consumer has to say what it does in that state.

### Paging

Every list read follows one of three conventions, by what the list is:

- **A window, `(start, count)`, clamps and never reverts.** A window that runs past the end is shorter, one that starts
  at or past it is empty, and `count = type(uint256).max` means "to the end" from any `start` (the clamp compares
  `count` with what is left; it never adds them). `OrgFactory.orgsSlice`, `orgsAdministeredSlice`;
  `ProjectEnumeration.tokensOfOwnerSlice`, `orgsHeldSlice`; `ProjectHook.publishRange`, `globalPublishRange`;
  `Lens.publishRange`. Newest-first feeds clamp the same way: `recentPublishes(org, count)` and
  `recentPublishesBefore(org, beforeIndex, count)`, where `beforeIndex` is exclusive and may exceed the length.
- **A range, `(start, end)`, half-open and 0-based, reverts `RangeOutOfBounds` unless `start <= end <= length`:**
  `ProjectHook.versionsRange` (index `i` is version `i + 1`) and `getTagsRange`.
- **One item by index reverts past the end:** `versionAt` with `InvalidVersion` (versions are 1-based), `getTagAt` and
  `globalPublishAt` with `IndexOutOfRange`, and `orgAt`, `publishAt` and `tokenOfOwnerByIndex` with an array-bounds
  panic.

Append-only lists (the org list, both publish ledgers, a project's versions) never reorder, so a stored cursor stays
valid. Lists kept by swap-and-pop (an admin's orgs, an owner's tokens, an owner's orgs, a project's tags) reorder when
an entry leaves: page them at one block.

## Indexing everything

A crawler, pinner or mirror needs one address and one cursor, not a walk over every org.

- **The cross-org ledger.** The hook keeps one append-only array across all registered orgs. Each entry is one packed
  slot (the org address and the index of the entry in that org's ledger, which is itself one slot naming the token and
  version), so records are not duplicated: a publish writes the version's two slots and one slot in each ledger.
  Measured through the real ABX: a steady publish is about 148k gas in all, the first of a token about 262k.
- `Lens.publishRange(start, count)` resolves entries into full records in one `eth_call`. A crawler keeps the last
  index it read and polls `globalPublishCount()`.
- `ProjectVersionPublished` is emitted on every publish, from one address for every org, but it is not the source of
  truth, because providers prune logs; the ledger is.
- **Not covered:** content written to the stores but never published by any project. The stores keep no enumeration of
  it, so mirroring literally every byte means watching the stores directly.

## More than one factory

A factory is immutable, so a fix is a new factory at a new address, and the orgs the old one made stay frozen against
its hook, enumeration hook and minter. The SDK registry therefore holds a list: the current factory's contracts in the
top-level fields (`orgFactory`, `projectHook`, …) and any earlier one in `previousGenerations`, newest first. Once a
factory has orgs on a production chain, it stays in that list: removing it would 404 every URL under its orgs.

- **Reading from an org address** (a URL, a link, a list): find the factory that says `isOrg(org)`, newest first
  (`generationOfOrg` / `addressesForOrg` / `AbxfsClient.resolveOrg`), then read through that factory's hook. An address
  no listed factory made is not an org. A factory that reverts, has no code or answers anything but a clean `true` counts
  as "did not make it"; the lookup never throws. `forOrg` is only for an org created a moment ago in this process: used
  on an older org, it reads the wrong hook's history, which for a publish is the silent kind of wrong.
- **Writing** to an older org goes through its own factory's contracts too.
- **New orgs** are always created by the current factory.
- **Indexing** is one ledger per factory. `abxfs-mirror` follows all of them, with one cursor each.
- **Content** is shared by every factory.

A chain whose registry entry has no factory has no projects: the tools hide project features there and the content
layer works on its own.

## Addressing

- Default token links: `/g/p/<chain>/<org>/<tokenId>/latest/` and `/projects/<chain>/<org>/<tokenId>` on the app.
  Projects are served from their own origins, `https://<chain>-<org>-<id>[-v<n>].<content domain>/`, and raw content
  from `https://<chain>-<base32 root>.<content domain>/`; the app's (`https://fs.abx.io`) `/g/…` paths redirect there, except
  a project's root under `/g/p`, which is a page framing the project's host. Addresses only, never names.

## Tests

- `test/Orgs.t.sol`, `test/OrgHeld.t.sol`, `test/ProjectHook.t.sol`, `test/ProjectEnumeration.t.sol` and the renderer
  tests run the factory against a stand-in for ABX (`test/mocks/AbxMocks.sol`). Deliberate breakages (forgetting a
  lock, forgetting renounce, minting before the hooks, opening the mint gate, dropping the salt check, skipping
  acceptance, removing a registry gate, adding a revert path) are each caught by a test.
- `test/fork/` runs against the **real** ABX contracts on Base Sepolia, skipped unless `ABXFS_RPC_URL_84532` is set. It
  proves the stand-in is honest, that ABX's metadata renderer accepts the field encoding and renders the card with the
  org's name, and that every state-changing selector on a real org is closed to every actor. The only calls that
  succeed are caller-scoped no-ops (`approve`, `setApprovalForAll`, an empty `multicall`, an ownership-handover request
  and cancel), and the handover cannot complete because `completeOwnershipHandover` is owner-only.
- `test/fork/Battery.sol` is generated from ABX's own ABI (`pnpm --filter @artblocks/abxfs-sdk gen:battery`), and a test fails if
  it goes stale, so a mutator ABX adds later shows up in a diff instead of slipping past a hand-kept list.
- `test/DeployFactoryPin.t.sol` pins the factory's, `OrgMeta`'s and the lens's creation-code hashes, and checks the
  deploy script's `predict` against its `pinned()` addresses (`OrgMeta`, the factory, its five components and the
  lens); on a listed chain the script refuses to broadcast a build whose addresses are not the pinned ones.
- Project behaviour is tested in Solidity, not TypeScript: exercising the publish path end to end from TS needs a
  deployed ABX collection, which means standing up ABX's own factories, renderer, minter and seed source on anvil.

## Decided against

- **Royalties other than 0%.** A royalty cap only matters to an owner, and orgs have none.
- **A supply cap above 1,000,000.** Host labels would no longer fit DNS's 63-character limit on longer chain ids.
- **A per-org link base set at creation.** A permanent footgun if that domain lapses; `abxfs.view` already lets each
  project point anywhere.
- **Any org-admin say over a project**, its links included. The admin has no power over any project, by design.
- **A delegate list for admins, or a second factory role.** A team uses a Safe.
- **Org renames, and a factory-side `setName`.** The collection name freezes at renounce anyway; a mutable name would
  only change the card, and would let an org pass as another.
- **Token-owner delegation (delegate.xyz).** It would make someone other than `ownerOf` able to publish.
- **An owner, an upgrade path or a setter** to avoid a new factory. Anything an org needs that is not in it at creation
  needs a new factory and new org addresses; that is the cost of the trust model.
