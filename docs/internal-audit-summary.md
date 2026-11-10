# Internal audit summary

## Scope

The historical review below covers the original `abx-fs-freeze-3` generation only. It does not describe the later
native reader and presentation generation. See [presentation](../site/content/docs/reference/presentation.mdx)
for current behavior and [deployments](../site/content/docs/reference/deployments.mdx) for verified addresses
and generation history. Source verification is not an independent security audit.

## Original generation — 2026-10-29 to 2026-10-31

ABX FS, 2026-10-29 to 2026-10-31. One page for everything the internal audit found, fixed, decided and left open.
This page is the published record of it: what each pass found, what was fixed, and what was decided or accepted.

This was an internal review. It replaces nothing an independent audit would give.

## Where it ended

- **The contracts have not changed since `abx-fs-freeze-2`.** Every delta round checked that no source under the four
  Solidity packages changed and that every pin passes, and the contract reviews rebuilt all 15 deployed contracts from
  two checkouts at different paths and compared their bytecode: byte-identical every time. The addresses below are
  final unless an independent audit finds something.
- **No CID has changed.** The golden vectors are the same in every round, so content written by any build since
  `abx-fs-freeze-1` keeps its root.
- **The off-chain code converged.** Ten delta rounds reviewed each round of fixes for regressions. No round after the
  second found a Medium, none after the fifth found a Low that the change under review had introduced, and the last
  found nothing that needed changing.
- **The fixed build is tagged `abx-fs-freeze-3`.** Its contracts are those of `abx-fs-freeze-2`, so an independent
  audit of the contracts can start from it. `abx-fs-freeze-1` and `-2` are tags in the history before this
  repository; only `abx-fs-freeze-3` is here.

## Timeline

| Step | Build | Outcome |
| --- | --- | --- |
| Code freeze | `abx-fs-freeze-1` | Final comment pass, every address pinned |
| Internal audit | `abx-fs-freeze-1` | 0 Critical, 1 High (off chain), 19 Medium (1 contract, 18 off chain); all fixed. |
| Fixes and re-pin | `abx-fs-freeze-2` | Every contract re-pinned; deploy scripts refuse a build that is not the pinned one |
| Delta rounds 1 to 10 | `freeze-2` + fixes | Each round reviewed only the previous round's fixes; see below |
| Freeze | `abx-fs-freeze-3` | This document |

## Delta rounds

Rounds 1 to 5 gave each area (contracts and CI; SDK, pinning and CLI; gateway and Art Blocks' hosted website, which
is maintained separately) its own reviewer; from round 6, when each round's fixes were a few commits, one reviewer took them all. Each read only the
diff since the last round and asked one question: did the fixes introduce a regression,
a new bug, a new attack surface, a weakened test, two implementations of one rule that now disagree, docs the change
made false, or a branch that no test runs? Every finding came with a reproduction, and every fix with a test.

| Round | Reviewed | Critical | High | Medium | Low | Info |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `abx-fs-freeze-1..abx-fs-freeze-2` (the audit's fixes) | 0 | 0 | 3 | 20 | not counted |
| 2 | round 1's fixes | 0 | 0 | 1 | 11 | 24 |
| 3 | round 2's fixes | 0 | 0 | 0 | 7 | 18 |
| 4 | round 3's fixes | 0 | 0 | 0 | 6 | 16 |
| 5 | round 4's fixes | 0 | 0 | 0 | 2 | 10 |
| 6 | round 5's fixes | 0 | 0 | 0 | 0 | 4 |
| 7 | round 6's fixes | 0 | 0 | 0 | 1 (pre-existing, CI only) | 6 |
| 8 | round 7's fixes | 0 | 0 | 0 | 0 | 4 |
| 9 | round 8's fixes | 0 | 0 | 0 | 0 | 3 |
| 10 | round 9's fixes | 0 | 0 | 0 | 0 | 2 |

No delta finding touched deployed bytecode. In the contract packages every finding was in a deploy script, a test or
CI.

### The Medium findings

1. **A blocked directory was reachable through a wrapper's `index.html` courtesy** (round 1, gateway). The filter
   checked the `index.html` file's CID but not the directory whose page it is. The gateway now filters the directory
   too.
1. **Read amplification through an unknown backend** (round 1, SDK). A chunk record from a backend the SDK did not
   know was priced at infinite gas, so a crafted file could make one read cost about 64 times its fair number of
   calls. Unknown backends are priced finitely and every read has a call budget.
1. **The call budget was too tight on nodes that cap `eth_call` at 2^24 gas** (round 2, SDK). Legitimate FastLZ files
   from about 0.6 MB could not be read through such a node. The read now re-plans at half its gas budget when, and
   only when, a call fails in a gas-refusal shape.

One more Medium, in round 1, was in Art Blocks' hosted website, which is not part of this repository.

### What the later rounds found

The Lows of rounds 2 to 5 were mostly the edges of round 1's fixes: a refusal that was not remembered, a budget that
halved on a transient error, a Node release with a different undici, an Erigon node that refuses a result longer than
100,000 bytes, a recovery command that ksh93 decodes to another path, and the edges of the hosted website's fixes.
Every one was found with a reproduction and fixed with a test, and each round's count fell.

Round 6 found nothing at Low or above. Its four Infos were fixed anyway: the mirror's `--api-key` warning could print
before a refusal, a setting that names one chain was read two ways (the library took the first of a list), a transient
error on one chunk was reported as a chunk the chain cannot serve, and `release.yml` could not run (no root `build`
script, no Foundry). The read arms it found that no test took, and the mutants that survived there, got tests.

Round 7 found one Low, in CI and older than the audit: `pack-smoke.sh` read the registry's addresses, which are empty
until a deployment, so it failed, `release.yml` stopped there, and sdk-ci never reached its CLI tests. It now passes
before a deployment, and every verification since runs it. Its Infos: an EVM-readable backend's chunk was reported as
"cannot be read on chain" by a node that simulates less than one chunk's read, the library did not name
`ABXFS_DEFAULT_CHAIN` in an unknown-chain error, and three test-hygiene points (an order-dependent mock node, a test
double that no longer reached its branch, a test that read the operator's environment). All were fixed with tests but
one, accepted: two old clients' revert shapes are not explained. Its one untested branch, the revert rule against the
gas-refusal rule on one chunk, got a test for each.

Round 8 found nothing at Low or above. Its Infos were the new smoke check (it passed when its own code threw, because
Node prints a failing script's source and the check read stderr; it also encoded a policy the registry need not
follow), two texts that still said every reverting chunk is explained, and which signal "EVM-readable" is. All were
fixed: the smoke check now compares the packed SDK's registry with the one built. A test that a doubled error prefix
passed was anchored, the EVM-readable case got a test on a real node, and the test harness no longer leaves an anvil
running when its deploy fails.

Round 9 found nothing at Low or above, and said none of its three Infos needed a change. They were made anyway, so
that nothing was left open: the smoke check now builds its file URL in Node (a checkout path with `#`, `?` or `%`
broke it, loudly), the test harness rejects when `forge` cannot be started instead of waiting forever with an anvil
running, and a test helper's comment says the artifacts it reads need `forge build`.

Round 10 found nothing that needed changing. One of its two Infos was a sentence in `AGENTS.md` (the test mocks need
`forge build`, not `forge script`), corrected with the freeze. The other, accepted, is that the smoke check fails,
loudly, in a checkout whose path contains a backslash.

## Invariants checked after every round

- No source change under the four Solidity packages since `abx-fs-freeze-2`; the contract reviews also rebuilt all 15
  deployed contracts from two paths and found them byte-identical to it.
- Every pin: core's predicted addresses, the resolver's creation-code hash and address, the factory's, `OrgMeta`'s
  and the lens's creation-code hashes and every predicted address.
- Golden vectors unchanged (`packages/sdk/test/nodes.test.ts`, `GoldenVectors.t.sol`).
- The four `.gas-snapshot` files match.
- Every suite passes, and the docs site builds.
- From round 7, the pack-and-install smoke test passes: the published packages, installed from their tarballs alone.
- The fork suite against the real ABX contracts on Base Sepolia passes (625 tests, round 4).

The last full run, on the frozen build:

| Suite | Tests passed |
| --- | --- |
| `protobuf-sol` (forge) | 38 |
| `contracts-core` (forge) | 99 |
| `contracts-companion` (forge) | 85 |
| `contracts-projects` (forge) | 551, plus 625 fork tests on Base Sepolia (round 4) |
| SDK | 1,271 |
| pinning | 80 |
| CLI | 620 |
| gateway and mirror | 537 |

The four snapshot checks pass, the golden vectors hash to `dbee33f`, the pack-and-install smoke test passes, and the
docs site builds.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Let the hook accept roots of a future store format, marked by a reserved prefix, without an existence check? | **No.** An org stays tied to its stores, and "every published root exists" stays absolute. A future format, or content proven from another chain, ships as a new add-on factory. |
| D2 | Pass the writer to storage backends? | **Yes:** `IStorageBackend.store(input, caller)`, so a future backend can bill, meter or gate writers with no other redeploy. |
| D3 | An open org can be minted to its 1,000,000 cap by anyone. | **Document it and warn in the UI.** No contract change. |
| D4 | Org names accept HTML characters. | **Keep them.** Renderers escape; the docs say so. |

## Follow-ons: provisioned or dropped

Every deferred follow-on was checked against the frozen contracts. Each one is now either possible later with no
contract redeploy, or dropped with its reason given below.

| Follow-on | Status | How |
| --- | --- | --- |
| New storage (logs, calldata, blobs, larger code, external) | Provisioned | A new `IStorageBackend`; chunk ids commit to the backend |
| Paid or gated storage | Provisioned | A backend that acts on `caller` (D2) |
| HAMT-sharded IPFS directories | Provisioned | A new resolver; nothing stores the resolver's address |
| Multi-transaction IPFS attestation | Provisioned | An add-on that only reads the stores |
| Vanity names | Provisioned | Off chain or an add-on registry; nothing deployed reads a name |
| A project moving to a later org | Provisioned | `abxfs:successor` / `abxfs:predecessor` in `abxfs.meta` |
| A native per-project publisher role | Dropped | ABX decides who writes a `TokenOwner` param; use a Safe or smart account |
| Notifying an address of an admin offer | Dropped | Offers are kept by org; the offer link is the mechanism |
| Content proven from another chain | Future exploration | A new factory whose hook accepts proven roots; the stores never change (D1) |

**Cross-chain is future exploration, not supported at launch** (decided 2026-10-30). The content stores need
nothing more: their storage layout is fixed, so another chain can prove a root exists with a storage proof and a
trusted bridge or light client. Using that would take a new factory whose hook accepts proven roots, and new orgs
under it; existing orgs and every content address stay as they are.

## Upgrade paths

| Need | Redeploy |
| --- | --- |
| A new storage backend, paid or gated storage | None |
| HAMT-sharded IPFS directories | The resolver only |
| The gateway, SDK, CLI, or a site built on them | None |
| A project moving to a later org | None |
| A new card, traits, hook behaviour, store format, or cross-chain roots | A new factory and its components; existing orgs keep theirs |
| The content layer | Never: its addresses are part of every chunk id and CID |

## Accepted

Known and accepted, not fixed: the resolver memoises nothing; an open org can be
minted out (D3); admin key loss is unrecoverable; zero-prefix salts can be squatted; an account with a nonce but no
code at a chunk's candidate address (about 2^80 work) denies writing that one data string; the SDK does not retry one
chunk after a transient error (the gateway's 502 for it is not remembered, so the next request reads it); old
Nethermind and Hardhat revert shapes are not read as reverts, so a chunk the chain cannot serve is reported there as
the node's own error.

## Still open

- **An independent audit** has not been done yet.

## Addresses of the frozen build

Unchanged since `abx-fs-freeze-2`. Every contract is deployed by CREATE2 through
`0x4e59b44847b379578588920cA78FbF26c0B4956C` and is identical on every chain. They are deployed at these addresses on
every network in the SDK registry, and on every one of them each contract's source is verified on Sourcify (an exact
match) and on the chain's Etherscan explorer (`scripts/verify-sources.mjs`).

| Contract | Address |
| --- | --- |
| `ChunkStore` | `0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc` |
| `Sstore2Backend` | `0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844` |
| `FastLzSstore2Backend` | `0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1` |
| `FileStore` | `0x8b6077a1d6953D96687005B9408D56A655b4d155` |
| `DirectoryStore` | `0x4273E4E078F47303Ca15b11959eeb61F3FC94c11` |
| `IpfsCidResolver` | `0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d` |
| `OrgMeta` | `0xB21e65DE1c241B9BaE8b7077b6f2E8f2c3Bc0F5D` |
| `OrgFactory` | `0xC5aBF9fBd94659cdfc173AF30c6052700Fa62798` |
| `ProjectHook` | `0x3828Dd35AbF6a42F0d92E0F3311bd70593BD6E7B` |
| `ProjectEnumeration` | `0x2b2a84df4d62d18329899b66c744E6C643cDC065` |
| `OrgMinter` | `0xc009135a8b9DdB14De53868773Fc1dc97963De1e` |
| `ProjectCard` | `0x0296686ED7193D27b945F121835177D6969208f0` |
| `ProjectTraits` | `0x087dfB523e4085A5Ae2E600c4Fc899813fB7AA3F` |
| `Lens` | `0x2Ef71C4780e70F64507F04BD1Fde35eC3713269e` |

The fifteenth, `ProjectLinks`, is deployed by `OrgMeta` itself, so its address follows from `OrgMeta`'s.

## How it was done

- **Reproduction first.** No finding was accepted without a failing forge test, vitest or script against anvil, and
  no code fix landed without a test that fails without it. CI and script fixes were checked by running them.
- **Nothing runs for the first time in production.** Each round listed every new branch no test ran, and the fix
  round tested it.
- **Mutation testing** of each changed deploy-script gate, and of the SDK's chunk-read planning and the gateway's
  start-up checks in rounds 4 to 8; every surviving mutant was killed by a new test or shown equivalent.
- **Fresh-checkout CI simulation** of each changed workflow, step by step, on the pinned forge and anvil.
- **Fork tests** against the real ABX contracts on Base Sepolia, read only.
- **Verified before pushed.** Every fix was committed and pushed only after every suite, the snapshots, the golden
  vectors and the builds passed (rounds 1 to 5 also made their fixes in separate git worktrees). Reviewers worked
  read-only, in their own worktrees.
