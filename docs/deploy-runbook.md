# Deploy runbook: ABX FS to one network

How to deploy ABX FS to the network of your choice: the content layer, the optional IPFS resolver, and the org
factory. The legacy `abx-fs-freeze-3` build is deployed on the original six networks recorded with addresses in the
SDK registry. Robinhood (4663) and Robinhood Testnet (46630) currently have metadata only: no verified ABX FS
addresses are registered there. A source prediction or allow-table entry does not establish deployment.

Everything the factory deploys is frozen into every org it will ever create, so a mistake there means a new factory
address and new org addresses (new URLs). A mistake in the content layer means a new content-address space. Nothing
here is cosmetic.

## Deploying the presentation generation

The new stateless reader, presentation companion and seven-argument factory are a **candidate build**, not an
announced deployment. Their script pins must match the exact frozen sources before broadcast, and their addresses
must not enter `canonical.ts` or public deployment tables until source verification and rehearsal pass. The content
stores and backends remain the existing deployment: do not redeploy them to add presentation.

With the content layer and IPFS resolver already deployed, the order is:

1. **ContentReader:** in `packages/contracts-companion`, test and dry-run `script/DeployReader.s.sol`, compare its
   prediction with `pinned()`, then broadcast that same script. `FILE_STORE` and `DIRECTORY_STORE` select the
   existing stores (or default to their predictions); read back both immutable store addresses.
2. **ProjectPresentation:** set `ABXFS_CONTENT_READER` to that verified reader, `ABXFS_IPFS_CID_RESOLVER` to the
   verified resolver over the same stores, and `ABXFS_GATEWAY_BASE=https://fs.abx.io`. In
   `packages/contracts-projects`, test and dry-run `script/DeployPresentation.s.sol`, compare its pin, then broadcast.
   Read back `reader()`, `ipfsResolver()`, `fileStore()`, `directoryStore()` and `defaultChainBase()`.
3. **OrgFactory:** set `ABXFS_PRESENTATION` to that companion. Dry-run and broadcast `script/Deploy.s.sol` with the
   ABX/store/gateway environment below. The seven constructor arguments are ABX factory, metadata renderer,
   seed source, directory store, file store, OrgMeta and presentation. Read back `presentation()` as well as all
   existing factory/component wiring. Confirm a newly created org uses the presentation renderer only for
   `animation_url`; `external_url` retains `ProjectLinks`.

Each dry run omits `--broadcast`; each broadcast uses the same reviewed inputs and an encrypted account as below.
For example, the reader's dry run is:

```bash
cd packages/contracts-companion
forge script script/DeployReader.s.sol --rpc-url "$RPC" --sender "$DEPLOYER"
```

Run the contract suites and fork rehearsal for the exact build on the paired testnet before production. Verify
sources for the reader, presentation, factory and every new component, including constructor arguments. The verifier
reads the new companion addresses and all seven factory constructor arguments from deployed contracts and checks
store wiring. Pass an explicit candidate deployment bundle before canonical registration:

```bash
node scripts/verify-sources.mjs <chainId> both --addresses /tmp/candidate-addresses.json
```

The JSON is the flat `ContractAddresses` object: all content/resolver/org addresses, plus `contentReader` and
`projectPresentation`. Use actual deployed addresses read back from the chain, not predictions. The tool also checks
that code exists and that the RPC names the requested chain. The JSON is qualification input, not a registry update;
keep local deployment inputs out of the repository. No candidate address becomes canonical on the strength of a pin
alone.

Extend the throwaway rehearsal below with a raw/FastLZ native read, bounded range read, Embedded preview and
ChainGateway preview. Confirm file-level gzip is rejected by the native reader but readable through the gateway.
Check Latest, Version and Tag plus a nonempty path. On a throwaway project only, review a lock dry run and submit
its explicit commitment; confirm changed selected state rejects that commitment. Freeze the reviewed target and
verify later publishing/tag movement cannot change it; verify method and endpoint locks independently and after
transfer. Exercise IPFS only with creator-pinned content. Finally confirm an old org's token metadata, publishing,
tags and gateway URLs still work through its original generation.

When registering the new generation, retain the complete old bundle in `previousGenerations` permanently (see
[Superseding a factory](#superseding-a-factory)). Set the new generation's `contentReader` and
`projectPresentation` capabilities only after they have passed the checks above. Never add presentation to an old
factory record. A reader capability can be shared only by generations with its exact immutable store pair.

## Legacy deployment procedure

The remaining build tag, pins and deployment inventory describe the legacy generation. For a presentation
generation, use the sequence above and the current scripts' pins; do not reuse the legacy factory's address.

## Prerequisites

- **The build:** the working tree is the tagged commit (`abx-fs-freeze-3`, internally audited), clean, and built with the repo's pinned compiler
  (`solc_version` in each `foundry.toml`).
  - The bytecode commits to the exact source text through solc's metadata hash, so **any edit under a contract
    package's `src/`, a comment included, moves addresses**.
  - The pins (below) fail on such an edit; a failing pin is a stop.
- **The paired testnet first:** the exact build has been deployed and proven on the production network's own testnet.
- **ABX:** ABX supports the chain (`abx capabilities --json`), and its addresses match the table below.
- **RPC and key:**
  - a keyed RPC for the chain (public endpoints lag, and cap the gas an `eth_call` may use);
  - a funded deployer EOA whose key is only in an env var, an encrypted keystore or a hardware wallet, never on disk
    in plain text or on a command line you paste.
- **The allow-table:** the chain has an entry in the projects script's allow-table (`script/Deploy.s.sol`:
  `_isListedChain`, `expected()`, `_gatewayAllowed`).
  - Listed today: the script's supported networks (a listing alone does not mean deployed), all with the same ABX
    addresses, the same stores and `https://fs.abx.io`.
  - Any other chain needs a reviewed change to the table, in the same commit that adds it to the SDK registry.

## ABX dependencies

The org factory takes three of ABX's contracts as constructor arguments, so they are part of its address.

| ABX contract | Address | Used for |
| --- | --- | --- |
| SeriesCode factory (`seriesCodeFactory`) | `0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616` | creating each org's collection |
| Metadata renderer (`renderer`) | `0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27` | `tokenURI` / `contractURI` (spec version 12) |
| Seed source (`seedSource`) | `0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A` | the collection's seeds |

**Where these come from:**
- Source: `@artblocks/abx-sdk` 0.5.0, `DEPLOYMENTS[chainId]`.
- ABX deploys them with CREATE2, and they are identical on every chain it ships to.
- The projects script's allow-table holds the same three.
- **Read them from the ABX SDK for the chain you deploy to, never from memory or from this table.**
- If a chain's values differ, its factory lands at a different address and needs its own allow-table entry and pin.

## A new chain

**Same addresses everywhere.**
- Every contract, the lens included, goes through the keyless CREATE2 deployer
  (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a fixed salt and no sender-dependent constructor argument, so
  **any key** lands it at the same address on every chain.
- The salts are `keccak256("abx-fs/content")` (all five content contracts), `keccak256("abx-fs/ipfs-cid-resolver")`,
  `keccak256("abx-fs/org-meta")`, `keccak256("abx-fs/org-factory")`, `keccak256("abx-fs/org-components")` and
  `keccak256("abx-fs/lens")`.
- Only the factory also depends on its constructor arguments (ABX's addresses, the stores, `OrgMeta`), and the lens
  on the factory and its hook.

**Choose the gas multiplier per chain.**
- On a chain with the 2^24 per-transaction cap and the old gas schedule, a high `--gas-estimate-multiplier` is
  refused `gas limit too high`. Measure the factory deploy at code freeze and stay under the cap.
- On a Glamsterdam chain (EIP-8037: Sepolia now, Ethereum when it upgrades) the opposite holds: forge underestimates
  state creation, so give the deploy node-estimated gas.

## Environment

| Variable | Meaning |
| --- | --- |
| `ABXFS_DIRECTORY_STORE`, `ABXFS_FILE_STORE` | the content layer's stores (`Deploy.predict()` in `contracts-core`) |
| `ABX_SERIES_CODE_FACTORY`, `ABX_METADATA_RENDERER`, `ABX_SEED_SOURCE` | ABX's addresses for the chain ([above](#abx-dependencies)) |
| `ABXFS_GATEWAY_BASE` | `https://fs.abx.io` on every listed chain; frozen into every org |
| `ABXFS_CONTENT_READER`, `ABXFS_IPFS_CID_RESOLVER` | verified companions used when deploying the presentation generation |
| `ABXFS_PRESENTATION` | verified presentation companion used by the seven-argument factory |
| `FILE_STORE`, `DIRECTORY_STORE` | optional, for the IPFS resolver; they default to the content layer's predictions |
| `ABXFS_ALLOW_UNLISTED_CHAIN=1` | explicit override: a chain not in the table, an address that differs from it, or a build whose addresses are not the pinned ones |
| `ABXFS_ALLOW_UNLISTED_GATEWAY=1` | explicit override: a gateway base not on the chain's list (always needed on an unlisted chain) |
| `ABXFS_RPC_URL_<chainId>` | RPC for the fork tests and the script |

Never set an override to make a failing check pass before you know why it failed (see "If a check fails").

## Commands

First the content layer, which is idempotent (a contract already at its predicted address is reused). Then,
optionally, the IPFS resolver:

```bash
cd packages/contracts-core
forge test                                                       # includes the predicted-address pins (Deploy.t.sol)
forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER"            # dry run: compare to the pins
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --account <keystore> --sender "$DEPLOYER"

cd ../contracts-companion                                        # optional
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --account <keystore> --sender "$DEPLOYER"
```

Then the org layer:

```bash
cd packages/contracts-projects

# 1. Local gates, with a fork of the target chain's paired testnet for the fork tests. Nothing is sent.
set -a; . ../../.env; set +a        # never print this file
# DeployRunEnv sets the real deploy variables itself and refuses to run with them already set, so run the suite
# without them (forge has no cheatcode to unset a variable):
env -u ABXFS_GATEWAY_BASE -u ABXFS_ALLOW_UNLISTED_CHAIN -u ABXFS_ALLOW_UNLISTED_GATEWAY \
  forge test                        # the whole suite, including DeployWrong*, DeployFactoryPin and DeployScript

# 2. Dry run against the target chain. No --broadcast: simulates, runs preflight and read-back, sends nothing.
forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER"

# 3. Compare the printed predicted and actual factory address with the pin.

# 4. Broadcast (only after the rehearsal on the paired testnet has passed).
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --account <keystore> --sender "$DEPLOYER"
```

The script is idempotent by predicted address: a re-run with the same inputs reuses `OrgMeta`, the factory and the
lens.

## What the script checks

All of this runs before anything is broadcast (`DeployProjects.preflight`), then again after:

1. **Code:** every ABX and store address is nonzero and has code.
2. **Probes:** raw `staticcall`s that no override can skip. Each dependency must answer as what it claims to be:
   - **ABX factory:** `predictDeterministicAddress(bytes32(1))` returns a nonzero address, `implementation()` returns
     a contract, and `isAbxClone(0x…dEaD)` is false.
   - **Renderer:** `specVersion()` answers (pure, nonzero). A store, the factory or a seed source does not.
   - **Seed source:** `seed(uint256,address)` answers one word.
   - **Directory store:** `directoryExists(0)` answers false, and it does **not** answer `fileExists`.
   - **File store:** `fileExists(0)` answers false, and it does **not** answer `directoryExists`.
   - A swapped pair, a duplicated address or a catch-all contract fails here.
3. **Allow-table:** every ABX and store address equals the table entry for `block.chainid`. A chain not in the table,
   or any address that differs, needs `ABXFS_ALLOW_UNLISTED_CHAIN=1`.
   **Pins:** on a listed chain, every address the run would deploy to (`OrgMeta`, the factory, its five components and
   the lens: `predict(inputs)`) must equal the script's `pinned()`, the pinned build, or nothing is broadcast
   (`UnexpectedAddress` names the first that differs). `test/DeployFactoryPin.t.sol` holds the same check, so a pin
   that drifted fails CI first.
4. **Gateway:** it must pass the format rules (`https://` + host, no trailing slash, no whitespace or markup/JSON
   breaker, at most 128 bytes) **and** be on the chain's list (`https://fs.abx.io` for every listed chain). A
   lookalike such as `https://fs.abx.io.evil.example` needs `ABXFS_ALLOW_UNLISTED_GATEWAY=1`, and on a listed chain
   is then refused with `GatewayMovesThePins`, because any other base moves every pinned address.
5. **After deploying:**
   - the factory address equals the predicted CREATE2 address;
   - `abx()`, `metadataRenderer()`, `seedSource()`, the hook's two stores and every back-pointer match the inputs;
   - `hook()`, `enumeration()`, `minter()`, `card()`, `traits()` and `links()` all have code;
   - `links().gatewayBase()` equals the input.

**What the script cannot catch** (the rehearsal below exists for these):
- a renderer that answers `specVersion()` but is an old or malicious contract at a differing address on an unlisted
  chain; there, the allow-table is the only defence, and it is only as good as the review of it;
- a correct-looking gateway domain the project no longer controls;
- a seed source that answers the probe but misbehaves for real mints;
- anything that only shows when a project is actually published and resolved.

## Pins

Every address is a function of creation code (and, for the factory and the lens, constructor arguments). So each one
is pinned, and every pin is moved deliberately, in one commit:

- **`packages/contracts-core/test/Deploy.t.sol`** pins the content layer's predicted addresses. It also checks that
  the bytecode carries solc's metadata trailer, so the addresses commit to the exact source.
- **`packages/contracts-projects/test/DeployFactoryPin.t.sol`** pins the creation-code hashes of `OrgFactory`,
  `OrgMeta` and `Lens`, and checks that the script's `predict` equals its `pinned()`: the predicted addresses of
  `OrgMeta`, the factory, its five components and the lens. On a listed chain the script refuses to broadcast
  anything else.
  - The factory's initcode carries the hook, enumeration hook, minter, card and traits, so a change in any of them
    moves it.
  - `OrgMeta` deploys `ProjectLinks` and is a factory constructor argument, so a change to either moves the factory
    too.
- **`packages/contracts-projects/script/Deploy.s.sol` `expected()`** holds the store pair, and
  `test/DeployScript.t.sol` recomputes it from the core creation code.

Re-pin at code freeze, and again after any audit fix, before the first broadcast.

Every constructor argument is identical on every listed chain, so they all predict the same addresses. For a chain
whose arguments differ:
- compute the prediction from that chain's own arguments (the script logs it in the dry run);
- add it to the pin file **before** broadcasting;
- the broadcast address must equal it.

## The throwaway rehearsal (required on the paired testnet before any production chain)

The script's checks cannot always tell a wrong-but-answering dependency from the right one, and `tokenURI` renders
even with the stores swapped. Do all of the following with the exact build and arguments, as an EOA you control, on
the testnet and then (cheaply, with a throwaway org name) on the target:

1. **Create** a throwaway org: `abxfs org create Rehearsal-<date> --chain <chain>`. Confirm with `abx state <org>`:
   owner zero, hooks and URIs frozen.
2. **Upload** a tiny folder (an `index.html` and one asset) with `abxfs upload` into that org. This writes through the
   file and directory stores.
3. **Publish** it to the project. A swapped or wrong store reverts here (the hook's `directoryExists` / `fileExists`
   veto), which `tokenURI` alone never shows.
4. **Read `tokenURI` and `contractURI`** (`abx tokenuri <org> <id>`). They should decode, the card's header should be the
   org's name with the token's `#<id>` under it, `animation_url` / `external_url` should carry `https://fs.abx.io`,
   and the collection's `external_link` in `contractURI` should be `https://fs.abx.io` itself.
5. **Resolve it through a gateway** (`abxfs-gateway --content-domain`): the project's own host and the root's own
   host. Compare the root CID to the one the upload returned. Check the CID, not page text.
6. **Optionally** publish a second version and tag it; `latest` and the tag should differ.

Steps 1 to 4 are automated: from `packages/sdk`, run
`ABXFS_REHEARSAL_CHAIN=<chainId> npx vitest run test/rehearsal-live.test.ts` with the RPC and key in env. For an
unregistered candidate, use the same flat address JSON as source verification:

```bash
ABXFS_REHEARSAL_CHAIN=<chainId> ABXFS_REHEARSAL_ADDRESSES=/tmp/candidate-addresses.json \
  npx vitest run test/rehearsal-live.test.ts --reporter=verbose
```

All registry chains, including metadata-only Robinhood networks, can be rehearsal targets. The test refuses an RPC
with the wrong chain id. The capability-aware lane checks native file/path reads, Auto/Embedded output, chain and
derived IPFS URLs, endpoint changes and a reviewed content lock that survives a later publish, reusing one token.
IPFS derivation does not pin content. The legacy lane keeps its original link assertions. This command is opt-in and
writes permanent state: rehearse the candidate on a local fork first, then the paired live testnet before production.
Step 5 needs a gateway.

Abandon the throwaway org; it is permanent and harmless. Only then announce the address.

## Record the deployment

1. **`packages/sdk/src/canonical.ts` (`CANONICAL_DEPLOYMENTS`):** the chain's `addresses`. This is the single record
   of ABX FS addresses, and the change that makes every tool, and every site built on the SDK, start serving the chain.
2. **`site/content/docs/reference/deployments.mdx`:** the same addresses.
3. **Check them together:** `pnpm --filter @artblocks/abxfs-sdk exec vitest run test/canonical.test.ts`. The docs may publish
   no address the registry does not hold.
4. **New chain:** update the script's allow-table and `DeployFactoryPin.t.sol` / `pinned()` with its predicted address.
5. **Publish the sources:** `node scripts/verify-sources.mjs <chainId>`, with the SDK and contracts built. It verifies
   fifteen legacy contracts or seventeen presentation-generation contracts, including all renderers, on Sourcify
   (`exact_match` required) and the chain's explorer. The original six chains use Etherscan and need
   `ETHERSCAN_API_KEY`; Robinhood networks use Blockscout without that key, using the endpoints in
   [Robinhood's deployment guide](https://docs.robinhood.com/chain/deploy-smart-contracts/). A rerun skips already
   verified contracts. Every generation must use its exact frozen source text and compiler configuration:
   `--source-root /path/to/frozen-checkout` selects the source/build checkout for all submissions. To reverify a
   superseded generation, also supply its complete address bundle with `--addresses`; the current registry entry
   is never silently substituted. In particular,
   verifying the old six-argument factory with today's seven-argument source is refused before submission. Constructor
   compatibility is a guard, not proof of matching source: Sourcify's exact match remains required. Do it before
   announcing the chain: unverified code asks users to trust bytes they cannot read.

## If a check fails

Stop. Do not set an override to get past a check until you can say why it failed.

- **`ProbeFailed(what, at)`:** `what` names the dependency and `at` the address you passed. You gave the wrong
  contract (a renderer that is a store, stores swapped, a catch-all or proxy). Re-read the ABX SDK and the content
  layer's `Deploy.predict()`; nothing was broadcast.
- **`UnexpectedAddress` / `UnlistedChain`:** the address differs from the table. Either you pasted the wrong one, or
  this is a deliberate new set (a new ABX deployment or a new content layer). A deliberate set is a reviewed table
  change plus the override, never the override alone.
- **`UnlistedGateway`:** the domain is not the project's. Fix the typo. Only a deliberate, owned new domain gets
  `ABXFS_ALLOW_UNLISTED_GATEWAY=1`, and it is frozen into every org.
- **`GatewayMovesThePins`:** on a listed chain a new gateway base cannot be an override. The base is `OrgMeta`'s
  constructor argument, so it moves `OrgMeta`, the factory, every component and the lens off their pins: a new domain
  there is a new build, deployed only after a reviewed re-pin and table change.
- **A trace that names your RPC URL:** when a call to the RPC fails at the connection level, forge's trace prints the
  full URL, key included (`error sending request for url (…)`). Read it locally; do not paste deploy traces into
  issues, chats or CI logs that others can see.
- **`WiringMismatch` after a broadcast:** the factory exists and is wrong. It is permanent and unused: do not create
  orgs through it, do not register it, and redeploy with corrected inputs (a new address).
- **The predicted address differs from the pinned one:** an input or a source byte moved. Find it (`git diff` of the
  contract packages' `src/`, the env) before sending anything.
- **A rehearsal step fails** (publish reverts, `tokenURI` empty, resolve 404): the deployment is wrong in a way no
  static check saw. Treat the factory as burned: do not register it, fix, redeploy, and record the burned address.

## Superseding a factory

Every fix to a hook, a renderer or the factory ships as a new factory, with new org addresses. The first time a new
factory is deployed to a chain that already has a live one, the old one is **not** removed: it moves into
`previousGenerations`, because its orgs and their projects keep working through it. Do all of this together:

1. **Move the superseded factory into `previousGenerations`** in `packages/sdk/src/canonical.ts`, and put the new one
   at the top level.
   - The old factory, minter, hook, enumeration and lens go in as ONE entry, retained permanently. Never pair a
     new factory with an old hook: `orgGenerations` refuses that as incoherent.
   - Mirror it in `reference/deployments.mdx`.
2. **Migrate the `abxfs-mirror` cursors.** The mirror keeps one cursor per factory; the new factory needs a new cursor,
   and the old ones stay until they have drained (see `packages/gateway/src/mirror.ts`).
3. **Update the registry consumers.** Anything that keeps its own list of chains or factories (a site's chain
   configuration) moves in the same change.
4. **Re-run the cross-generation tests** (`pnpm --filter @artblocks/abxfs-sdk exec vitest run test/canonical.test.ts` and the
   SDK's cross-generation suite). Then check for real that the old factory still works:
   - the gateway serves an old org;
   - the CLI lists and mints in it;
   - a site lists it;
   - a tag and a publish go through the old factory.

**Before announcing a new factory, know three behaviours:**
- `createOrg` always creates in the CURRENT factory, even on a client that `resolveOrg` bound to an old org.
- `abxfs org list` and a site built on the SDK list the orgs of every factory, and report one they could not read
  (`failedGenerations`) rather than omitting it.
- Every factory's minter, hook, enumeration and lens, and the factory itself, is refused as the recipient of a
  transfer or an admin offer.
