/**
 * Gas-aware bundle packing for `Multicallable` ABX FS stores.
 *
 * The stores (ChunkStore, FileStore, DirectoryStore) all inherit Solady's `Multicallable`. Bundling N inner ops into one
 * outer `multicall(bytes[])` saves (N - 1) × 21,000 gas of transaction base, but one transaction still has to fit what
 * the chain and the node allow, which depends on the chain's gas schedule (`gas-schedule.ts`):
 *
 *   - **legacy**: one dimension, capped at 2^24 per transaction (EIP-7825, and what nodes simulate).
 *   - **EIP-8037**: execution capped at 2^24; state gas rides on top, so a bundle's TOTAL is bounded by the block gas
 *     limit and, in practice, by what the node will simulate (50M by default on geth and reth).
 *
 * The packer is a greedy first-fit walker that builds bundles in call-submit order (the SDK's call ordering encodes
 * data-dependency, e.g. "write all chunks before createFile"). Each call carries its estimated total gas and the state
 * part of it; the packer accumulates both plus a fixed per-bundle base and per-call dispatch, and starts a new bundle
 * whenever the next call would pass any limit.
 *
 * Estimates are upper envelopes of measurements, not bounds. The CLI also caps a bundle at a fraction of the live block
 * gas limit when it knows it (`bundleGasSafetyFactor`).
 */
import type { Hex, Address } from "viem";

import {
  DEFAULT_SIMULATION_GAS_CAP,
  LEGACY_GAS_SCHEDULE,
  TX_GAS_CAP,
  calldataFloorPerByte,
  stateGas,
  type GasEstimate,
  type GasSchedule,
} from "./gas-schedule.js";
import {
  CHUNK_LEAF_MAX_HASHES,
  NODE_MAX_LEVEL,
  branchBlobSize,
  branchExecution,
  branchLevelsNeeded,
  chunkLeafBlobSize,
  chunkLeafExecution,
  createDirectoryGas,
  createFileGas,
  entryLeafBlobSize,
  entryLeafExecution,
  estimateChunkTreeGas,
  estimateEntryTreeGas,
  nameKey,
  nodeStateGas,
  partitionEntryLeaves,
} from "./node-gas.js";
import { entryNameBytes } from "./names.js";
import { flzDecodeWork } from "./fastlz.js";

// ─── Per-op gas estimators ──────────────────────────────────────────────────

/**
 * Execution gas of the calls the packer bundles, an upper envelope of `eth_simulateV1` measurements on Sepolia
 * (EIP-8037) and Ethereum mainnet (legacy), 2026-10-29 (see `node-gas.ts` for the nodes). State gas is added per
 * schedule.
 */
export const GAS_ESTIMATES = {
  /** `multicall(bytes[])` outer wrapper: the array decoding and per-bundle memory. Independent of inner-call count. */
  multicallBase: 5_000,
  /** Per-inner-call dispatch inside `Multicallable._multicall`: calldatacopy + delegatecall + returndatacopy. */
  multicallInnerDispatch: 5_000,

  /**
   * `ChunkStore.write` through an SSTORE2 backend, execution only: the backend call, the CREATE2 placement, the
   * write-time read-back, the event. Measured: a 500-byte chunk 27k and a full 24,575-byte chunk 570k (legacy); on
   * Sepolia 48k more each, which is EIP-8038's charge for the record's three slots and the code's account (the
   * schedule's `newSlotExecution` and `newAccountExecution`). Its state is the input as code, one account and three
   * slots: 38.08M for a full chunk under EIP-8037, 5.01M on a legacy chain.
   */
  contentWriteBase: 30_000,
  /** Per byte of backend INPUT: calldata, hashing it for the id and for CREATE2, the read-back. */
  contentWritePerByte: 24,

  /**
   * FastLZ inflation at the write-time read-back, from the stream itself (`flzDecodeWork`): Solady's loop costs about
   * 110-130 gas a literal run, 250 a back-reference and 53 a copy step, plus about 4-5 a data byte for memory and
   * hashing (least squares over the 290 receipts below: 110-128, 247-256, 53 and 3.6-5.3 by how the base cost is
   * taken; the delta audit's round 3, 2026-10-30). A copy step moves `min(distance, 32)` bytes, so a run or a short
   * repeating pattern (an RGBA fill, sparse data) inflates at up to ~60 gas a byte where text inflates at 5-8. The
   * per-token figures carry headroom for streams of many short tokens: at 40 a literal run and 280 a back-reference the
   * model was up to 1.7% BELOW 16 receipts of a fresh adversarial corpus (3-byte dictionary matches between literals,
   * sparse data with two zeros in every 3..5 bytes, short runs; the delta audit, 2026-10-30).
   *
   * Refit over all 290 `ChunkStore.write` receipts on anvil (legacy, Cancun) of both delta-audit rounds: the 162 of the
   * first, and 128 of the second (consecutive short matches, CSV, hex, DNA, SVG paths, noisy bitmaps, FastCDC chunks of
   * real files, fuzzed mixtures). At 140 a literal run, 270 a back-reference and 58 a copy step the model is 1.035x to
   * 1.123x of every one, never below one and always within the repo's 15% + 60k (`test/fixtures/flz-write-receipts.json`,
   * checked in `gas-schedule.test.ts`). 60 / 320 / 60 was as safe but priced back-references where a literal run's cost
   * is: token-dense data such as a 4 MB CSV planned 160 transactions where 141 fit.
   */
  flzDecodePerLiteral: 140,
  flzDecodePerMatch: 270,
  flzDecodePerCopyStep: 58,
  flzDecodePerDataByte: 6,
  /**
   * Without the stream, an envelope over every stream measured: per data byte plus per input byte. At 60 and 60 it was
   * 0.8% below one receipt of the fresh corpus (`sparse3-a64-z2`: 2 zeros then a random byte, 255 gas a data byte of
   * decoding with 0.66 input bytes a data byte); at 65 and 65 it is never below any of the 290 (1.024x at the closest),
   * and up to 4.8x above one (a long period: few tokens, so the stream model is the one to use whenever the stream is
   * known).
   */
  flzDecodeEnvelopePerDataByte: 65,
  flzDecodeEnvelopePerInputByte: 65,
  /** `ChunkStore.write` on an id that already exists: one hash and one slot read, besides its calldata. */
  contentWriteDedup: 8_000,

  /**
   * Minting a project token into an org (through its minter), before its first publish. Legacy pricing, an upper
   * bound: measured on the Base Sepolia fork at 262,174 for a new holder and 169,433 for an existing one.
   */
  projectCreate: 280_000,
  /**
   * `abxfs.cid` through the configure hook: version history, the per-org and global ledgers. Legacy pricing, an upper
   * bound: measured on the Base Sepolia fork at 295,799 for the first publish in an org, 261,611 for a token's first
   * and about 148,000 for any later one.
   */
  projectPublishVersion: 310_000,
  /**
   * `abxfs.name` is a `String` PostParam, so the value rides an SSTORE2 blob: more than a scalar write, and growing
   * with its length (about 202k plus 440 a byte). Legacy pricing, an upper bound for the longest name
   * (128 bytes, `MAX_PROJECT_NAME_BYTES`): measured on the Base Sepolia fork against real ABX (`GasProfileFork.t.sol`)
   * at 205k for 7 bytes and 258k for 128.
   */
  projectSetName: 265_000,
  /**
   * `abxfs.view` is a `String` PostParam like the name, and a view URL may be up to 512 bytes (`MAX_VIEW_URL_BYTES`).
   * Legacy pricing, an upper bound: measured on the Base Sepolia fork at 213k for 24 bytes and 426k for 512.
   */
  projectSetView: 435_000,
  /**
   * One tag write (or a move if it exists). Legacy pricing, an upper bound: measured on the Base Sepolia fork at 127k
   * for `v1` and 191k for a 64-byte tag, a first write of each.
   */
  projectSetTag: 195_000,
  /** Swap-and-pop on the tag list. Measured on the Base Sepolia fork at 68.5k for a 64-byte tag. */
  projectRemoveTag: 70_000,
  /**
   * A project transfer (`safeTransferFrom`, through the enumeration hook's owner indexes). Legacy pricing, an upper
   * bound: measured on the Base Sepolia fork at 217,887 for a sender that keeps a project in the org and a recipient
   * new to it, the dearest of the four cases (a sender that leaves frees index slots, which refunds gas).
   */
  projectTransfer: 260_000,
  /** The admin opening or closing an org (`setOpen`). Measured on the Base Sepolia fork at 28,850. */
  orgSetOpen: 40_000,
  /** The admin offering the role to another address (`transferAdmin`). Measured at 48,690. */
  orgTransferAdmin: 60_000,
  /** The offered address accepting it (`acceptAdmin`), which also closes an open org. Measured at 77,144. */
  orgAcceptAdmin: 100_000,
} as const;

/** A scheduled inner call against a single `Multicallable` store. */
export interface BundleableCall {
  /** Address of the target store. All calls in a single bundle MUST share this address. */
  target: Address;
  /** ABI-encoded inner calldata (already `encodeFunctionData(...)`-ed). */
  data: Hex;
  /** Estimated TOTAL gas this inner call will consume on chain (execution + state), excluding multicall dispatch. */
  estimatedGas: number;
  /** Of {@link estimatedGas}, the state gas (EIP-8037's separate dimension). Absent means all execution. */
  estimatedStateGas?: number;
  /** Optional human label, surfaced by the CLI in progress lines (e.g. "ChunkStore.write[42]"). */
  label?: string;
}

/** A packed group of inner calls ready to be sent as a single `multicall(bytes[])` tx. */
export interface Bundle {
  target: Address;
  calls: BundleableCall[];
  /** Sum of inner estimates + per-bundle dispatch overhead: the bundle's TOTAL estimated gas. */
  estimatedGas: number;
  /** Of {@link estimatedGas}, state gas. */
  estimatedStateGas?: number;
}

/**
 * The most inner calls one bundle may carry, whatever the estimate says. Gas estimates are heuristics; a
 * call count is a bound that cannot be mis-modelled. 100 tiny chunk writes already cost ~12.7M measured.
 */
export const MAX_BUNDLE_CALLS = 100;

export interface PackOptions {
  /**
   * Hard upper bound on a bundle's estimated TOTAL gas. Under the legacy schedule this is the per-transaction cap;
   * under EIP-8037 it is the block and simulation bound, and {@link maxBundleExecutionGas} carries the 2^24 cap. Derive
   * both with {@link resolveBundleLimits}.
   */
  maxBundleGas: number;
  /** Hard upper bound on a bundle's estimated EXECUTION gas (total minus state). Unset: only the total is bounded. */
  maxBundleExecutionGas?: number;
  /** Most calldata bytes one bundle may carry (the calldata floor must fit the per-transaction cap). */
  maxBundleCalldataBytes?: number;
  /** Hard upper bound on inner calls per bundle. Defaults to {@link MAX_BUNDLE_CALLS}. */
  maxCalls?: number;
}

/** Calldata one inner call adds to `multicall(bytes[])`: its bytes padded to words, plus an offset and a length word. */
function calldataOf(call: BundleableCall): number {
  const n = Math.max(0, (call.data.length - 2) / 2);
  return Math.ceil(n / 32) * 32 + 64;
}

/**
 * Greedy first-fit packer. Walks `calls` in order and groups consecutive same-target calls
 * into bundles whose estimated total, execution part and calldata (inner sums + multicall dispatch overhead) do NOT
 * exceed the limits in `opts`.
 *
 * Order is preserved within each target. If two adjacent calls target different stores, a
 * bundle boundary is forced (a single `multicall(bytes[])` tx can only delegatecall to its
 * own address).
 *
 * A single inner call whose own estimate already exceeds a limit is emitted as a
 * one-call bundle and the caller is responsible for surfacing a warning — the contract may
 * still revert on OOG, in which case the operation cannot be batched and must be sent as a
 * standalone transaction (or split, e.g. by reducing chunk size).
 */
export function packBundles(calls: BundleableCall[], opts: PackOptions): Bundle[] {
  const out: Bundle[] = [];
  if (calls.length === 0) return out;
  const maxExecution = opts.maxBundleExecutionGas ?? Infinity;
  const maxBytes = opts.maxBundleCalldataBytes ?? Infinity;

  let cur: (Bundle & { estimatedStateGas: number; bytes: number }) | null = null;
  for (const call of calls) {
    const dispatchOverhead = GAS_ESTIMATES.multicallInnerDispatch;
    const state = call.estimatedStateGas ?? 0;
    const bytes = calldataOf(call);

    if (
      cur !== null &&
      cur.target === call.target &&
      cur.calls.length < (opts.maxCalls ?? MAX_BUNDLE_CALLS) &&
      cur.estimatedGas + dispatchOverhead + call.estimatedGas <= opts.maxBundleGas &&
      cur.estimatedGas - cur.estimatedStateGas + dispatchOverhead + call.estimatedGas - state <= maxExecution &&
      cur.bytes + bytes <= maxBytes
    ) {
      cur.calls.push(call);
      cur.estimatedGas += dispatchOverhead + call.estimatedGas;
      cur.estimatedStateGas += state;
      cur.bytes += bytes;
      continue;
    }

    if (cur !== null) out.push(finish(cur));
    cur = {
      target: call.target,
      calls: [call],
      estimatedGas: GAS_ESTIMATES.multicallBase + dispatchOverhead + call.estimatedGas,
      estimatedStateGas: state,
      bytes: 4 + 64 + bytes,
    };
  }
  if (cur !== null) out.push(finish(cur));
  return out;
}

function finish(b: Bundle & { estimatedStateGas: number; bytes: number }): Bundle {
  const { bytes, ...bundle } = b;
  void bytes;
  return bundle;
}

// ─── Per-op estimator helpers ─────────────────────────────────────────────────

/**
 * Execution gas of inflating a FastLZ chunk on chain (`FastLzSstore2Backend.retrieve`): from the stream's own work
 * when `input` is given (`flzDecodeWork`), else the envelope over every stream measured.
 */
export function flzDecodeGas(dataLength: number, inputLength: number, input?: Uint8Array): number {
  if (input === undefined) {
    return GAS_ESTIMATES.flzDecodeEnvelopePerDataByte * dataLength + GAS_ESTIMATES.flzDecodeEnvelopePerInputByte * inputLength;
  }
  return flzDecodeGasOfWork(flzDecodeWork(input), dataLength);
}

/** {@link flzDecodeGas} from a stream's decode work (`flzDecodeWork`) rather than the stream itself. */
export function flzDecodeGasOfWork(work: { literals: number; matches: number; steps: number }, dataLength: number): number {
  return (
    GAS_ESTIMATES.flzDecodePerLiteral * work.literals +
    GAS_ESTIMATES.flzDecodePerMatch * work.matches +
    GAS_ESTIMATES.flzDecodePerCopyStep * work.steps +
    GAS_ESTIMATES.flzDecodePerDataByte * dataLength
  );
}

/**
 * One `ChunkStore.write` with `inputLength` bytes of backend input, split by dimension. Pass `dataLength` for a chunk
 * whose backend decodes its input (FastLZ): the read-back inflates the data on chain. Pass the FastLZ stream as `input`
 * too: what inflating it costs follows its back-references (a run costs ten times what text does per byte), and
 * without it the estimate is an envelope several times what most streams cost.
 */
export function contentWriteGas(
  inputLength: number,
  opts: { dedup?: boolean; dataLength?: number; input?: Uint8Array; schedule?: GasSchedule } = {},
): GasEstimate {
  const calldata = GAS_ESTIMATES.contentWritePerByte * inputLength;
  if (opts.dedup) return { execution: GAS_ESTIMATES.contentWriteDedup + calldata, state: 0 };
  const decode =
    opts.dataLength !== undefined && opts.dataLength !== inputLength ? flzDecodeGas(opts.dataLength, inputLength, opts.input) : 0;
  const schedule = opts.schedule ?? LEGACY_GAS_SCHEDULE;
  return {
    execution:
      GAS_ESTIMATES.contentWriteBase +
      calldata +
      decode +
      3 * schedule.newSlotExecution +
      schedule.newAccountExecution,
    // The input as code (after SSTORE2's STOP byte), its account, and the record's three slots.
    state: stateGas({ codeBytes: inputLength + 1, accounts: 1, slots: 3 }, schedule),
  };
}

/** Total of {@link contentWriteGas}: one `ChunkStore.write`, legacy pricing unless `schedule` says otherwise. */
export function estimateContentWrite(
  inputLength: number,
  opts?: { dedup?: boolean; dataLength?: number; input?: Uint8Array; schedule?: GasSchedule },
): number {
  const g = contentWriteGas(inputLength, opts);
  return g.execution + g.state;
}

/**
 * Estimated gas to register a file of `chunkCount` chunks: every chunk-node transaction's worth of work (leaves and
 * branches) plus `createFile` (worst case: a 127-byte mime and a codec). Summed across however many transactions.
 */
export function estimateFileCreate(chunkCount: number, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): number {
  const create = createFileGas({}, schedule);
  return (chunkCount === 0 ? 0 : estimateChunkTreeGas(chunkCount, schedule)) + create.execution + create.state;
}

/**
 * Estimated gas to register a directory with these exact entries: every entry-node transaction's worth of work plus
 * `createDirectory`. Name-length aware, summed across however many transactions it takes.
 */
export function estimateDirectoryEntries(
  entries: ReadonlyArray<{ name: string; nameBytes?: Uint8Array; isDirectory: boolean }>,
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): number {
  if (entries.length === 0) return 0;
  const create = createDirectoryGas(schedule);
  return estimateEntryTreeGas(sortedNameItems(entries), schedule) + create.execution + create.state;
}

/** Name lengths and boundary keys in the packer's order (unsigned byte-lexicographic by name), which decide the leaves. */
function sortedNameItems(entries: ReadonlyArray<{ name: string; nameBytes?: Uint8Array }>): Array<{ nameLength: number; key: number }> {
  return entries
    .map((e) => entryNameBytes(e))
    .sort((a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return a.length - b.length;
    })
    .map((b) => ({ nameLength: b.length, key: nameKey(b) }));
}

/**
 * The project-layer writes, at legacy pricing (each is one transaction the wallet estimates itself; these only feed
 * a plan's displayed cost).
 */
export function estimateProjectOp(
  kind: "createProject" | "publishVersion" | "setName" | "setView" | "setTag" | "removeTag",
): number {
  switch (kind) {
    case "createProject":
      return GAS_ESTIMATES.projectCreate;
    case "publishVersion":
      return GAS_ESTIMATES.projectPublishVersion;
    case "setName":
      return GAS_ESTIMATES.projectSetName;
    case "setView":
      return GAS_ESTIMATES.projectSetView;
    case "setTag":
      return GAS_ESTIMATES.projectSetTag;
    case "removeTag":
      return GAS_ESTIMATES.projectRemoveTag;
  }
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * The ceiling `eth_estimateGas` will report on a legacy chain, regardless of the block gas limit: EIP-7825's 2^24.
 *
 * Measured at exactly 2^24 on every Base Sepolia endpoint tried — `sepolia.base.org`,
 * `base-sepolia-rpc.publicnode.com`, and a **keyed Alchemy** endpoint — while the block gas limit on
 * that chain is 1.2 **billion**. The two numbers have nothing to do with each other: the block limit
 * says what a block can hold, this says what one transaction may use.
 *
 * It is the binding constraint on bundle size and it bites in the worst way. A bundle needing more
 * than this does not come back with a larger number; the estimate fails outright, so the bundle
 * reverts before any transaction exists. That is what a browser upload of a single image hit: five
 * ~24 KB chunks in one `ChunkStore.multicall`, ~29M gas of work, rejected at simulation.
 *
 * Under EIP-8037 the same cap applies to EXECUTION gas only (see {@link resolveBundleLimits}).
 */
export const ESTIMATE_GAS_CAP = TX_GAS_CAP;

/**
 * Fraction of a cap a bundle may plan to use.
 *
 * The margin absorbs estimator error in the direction that matters. Per-op estimates here are
 * deliberately conservative (measured ~0.92x actual for a max-size chunk write), but a bundle that
 * planned to the cap exactly would have no room for an op that costs more than predicted.
 */
const ESTIMATE_CAP_SAFETY = 0.75;

/**
 * Fraction of the node's simulation cap a bundle's TOTAL may plan under EIP-8037. The state part is exact (it is
 * arithmetic on bytes and slots), so only the execution part carries estimator error; a full chunk is 98% state.
 */
const SIMULATION_CAP_SAFETY = 0.9;

/**
 * The legacy per-bundle ceiling: the user's `bundleGasBudget`, never above 75% of {@link ESTIMATE_GAS_CAP} nor above
 * `blockGasLimit * safetyFactor` (default 0.8) when the block gas limit is known. Under EIP-8037 use
 * {@link resolveBundleLimits}, which bounds execution and total separately.
 */
export function resolveMaxBundleGas(opts: {
  bundleGasBudget: number;
  blockGasLimit?: bigint | number;
  safetyFactor?: number;
}): number {
  const safety = opts.safetyFactor ?? 0.8;

  // The per-transaction cap applies always, so a caller raising `bundleGasBudget` cannot opt out of it by passing a
  // bigger number.
  let ceiling = Math.floor(ESTIMATE_GAS_CAP * ESTIMATE_CAP_SAFETY);

  if (opts.blockGasLimit !== undefined) {
    ceiling = Math.min(ceiling, Math.floor(Number(opts.blockGasLimit) * safety));
  }
  return Math.min(opts.bundleGasBudget, ceiling);
}

/**
 * The packer's limits for a schedule.
 *
 *   - legacy: {@link resolveMaxBundleGas} bounds the total.
 *   - EIP-8037: `bundleGasBudget` (the CLI's `--max-bundle-gas`) bounds EXECUTION, never above 75% of 2^24; the total
 *     stays under 90% of what the node simulates (`simulationGasCap`, default 50M) and under `blockGasLimit *
 *     safetyFactor` when the block gas limit is known; and the calldata floor (64 gas a byte) under 75% of 2^24.
 *     A full chunk is 38.7M, so each one is a transaction of its own; hundreds of small chunks still share one.
 */
export function resolveBundleLimits(opts: {
  schedule?: GasSchedule;
  bundleGasBudget: number;
  blockGasLimit?: bigint | number;
  safetyFactor?: number;
  simulationGasCap?: number;
}): Omit<PackOptions, "maxCalls"> {
  const schedule = opts.schedule ?? LEGACY_GAS_SCHEDULE;
  if (!schedule.stateGasDimension) {
    return {
      maxBundleGas: resolveMaxBundleGas(opts),
      maxBundleCalldataBytes: Math.floor((ESTIMATE_GAS_CAP * ESTIMATE_CAP_SAFETY) / calldataFloorPerByte(schedule)),
    };
  }
  let total = Math.floor((opts.simulationGasCap ?? DEFAULT_SIMULATION_GAS_CAP) * SIMULATION_CAP_SAFETY);
  if (opts.blockGasLimit !== undefined) {
    total = Math.min(total, Math.floor(Number(opts.blockGasLimit) * (opts.safetyFactor ?? 0.8)));
  }
  return {
    maxBundleGas: total,
    maxBundleExecutionGas: Math.min(opts.bundleGasBudget, Math.floor(ESTIMATE_GAS_CAP * ESTIMATE_CAP_SAFETY)),
    maxBundleCalldataBytes: Math.floor((ESTIMATE_GAS_CAP * ESTIMATE_CAP_SAFETY) / calldataFloorPerByte(schedule)),
  };
}

// ─── Single-call ceiling ───────────────────────────────────────────────────────

/**
 * The most gas ONE inner call (a `createDirectory`, a `createFile`, a chunk write) may be estimated at
 * before the plan is refused. A single call cannot be split across transactions, so unlike a bundle it
 * has nowhere to go when it does not fit. 97% of a cap leaves room for the multicall wrapper and the 63/64
 * forwarding rule (~2%); the per-op estimates are themselves upper envelopes of what was measured (2-10% above
 * it), so a call the estimate admits has at least ~5% of headroom under the cap.
 */
export const SINGLE_CALL_CEILING_FRACTION = 0.97;

/** The legacy single-call ceiling: 97% of 2^24, and under `blockGasLimit * safetyFactor` when known. */
export function resolveSingleCallCeiling(opts: { blockGasLimit?: bigint | number; safetyFactor?: number } = {}): number {
  let ceiling = Math.floor(ESTIMATE_GAS_CAP * SINGLE_CALL_CEILING_FRACTION);
  if (opts.blockGasLimit !== undefined) {
    ceiling = Math.min(ceiling, Math.floor(Number(opts.blockGasLimit) * (opts.safetyFactor ?? 0.8)));
  }
  return ceiling;
}

/** What one call may use: `maxGas` bounds its total; under EIP-8037 `maxExecutionGas` bounds its execution part. */
export interface SingleCallLimits {
  maxGas: number;
  maxExecutionGas?: number;
}

/**
 * The single-call limits for a schedule: legacy is {@link resolveSingleCallCeiling}; EIP-8037 bounds execution at 97%
 * of 2^24 and the total at 97% of the node's simulation cap (and the block's safe headroom when known). A full chunk
 * (38.7M) and every node the SDK packs (34.9M at most) fit the defaults.
 */
export function resolveSingleCallLimits(
  opts: { schedule?: GasSchedule; blockGasLimit?: bigint | number; safetyFactor?: number; simulationGasCap?: number } = {},
): SingleCallLimits {
  if (!(opts.schedule ?? LEGACY_GAS_SCHEDULE).stateGasDimension) return { maxGas: resolveSingleCallCeiling(opts) };
  let total = Math.floor((opts.simulationGasCap ?? DEFAULT_SIMULATION_GAS_CAP) * SINGLE_CALL_CEILING_FRACTION);
  if (opts.blockGasLimit !== undefined) {
    total = Math.min(total, Math.floor(Number(opts.blockGasLimit) * (opts.safetyFactor ?? 0.8)));
  }
  return { maxGas: total, maxExecutionGas: Math.floor(ESTIMATE_GAS_CAP * SINGLE_CALL_CEILING_FRACTION) };
}

function asLimits(ceiling: number | SingleCallLimits): SingleCallLimits {
  return typeof ceiling === "number" ? { maxGas: ceiling } : ceiling;
}

/** Whether one call of this estimate fits `ceiling`. */
export function fitsSingleCall(estimate: GasEstimate, ceiling: number | SingleCallLimits): boolean {
  const l = asLimits(ceiling);
  return estimate.execution + estimate.state <= l.maxGas && (l.maxExecutionGas === undefined || estimate.execution <= l.maxExecutionGas);
}

/**
 * A plan cannot be written. Content layer v2 has no size limit that a split cannot get around, so this is now
 * thrown only for the two genuinely impossible cases, both BEFORE any content transaction is sent:
 *
 *   - `reason: "levels"`: the tree would need more than {@link NODE_MAX_LEVEL} levels of branches (more than
 *     128^3 leaves: about 1.6e9 chunks or 1.4e8+ directory entries).
 *   - `reason: "node-gas"`: one node alone is estimated above the single-call ceiling (only reachable with an
 *     explicitly tiny `singleCallCeiling`, or a chain whose limits cannot hold a full node).
 */
export class PlanTooLargeError extends Error {
  override readonly name = "PlanTooLargeError";
  readonly kind: "directory" | "file";
  readonly reason: "levels" | "node-gas";
  /** Path of the offending directory ("" is the root, shown as "/") or file. */
  readonly path: string;
  readonly estimatedGas?: number;
  readonly ceiling?: number;
  readonly levelsNeeded?: number;
  readonly levelCap?: number;
  /** Directory only. */
  readonly entryCount?: number;
  /** File only. */
  readonly fileBytes?: number;
  readonly chunkCount?: number;

  constructor(init: {
    kind: "directory" | "file";
    reason: "levels" | "node-gas";
    path: string;
    estimatedGas?: number;
    ceiling?: number;
    levelsNeeded?: number;
    levelCap?: number;
    entryCount?: number;
    fileBytes?: number;
    chunkCount?: number;
  }) {
    const shown = init.path === "" ? (init.kind === "directory" ? "(the top level)" : "") : `"${init.path}"`;
    const subject =
      init.kind === "directory"
        ? init.path === "" ? "The top-level folder" : `The folder ${shown}`
        : init.path === "" ? "This file" : `The file ${shown}`;
    const size =
      init.kind === "directory" ? `${init.entryCount ?? "?"} entries` : `${init.chunkCount ?? "?"} chunks`;
    const msg =
      init.reason === "levels"
        ? `${subject} has ${size}, which would need ${init.levelsNeeded} levels of nodes; the protocol allows ${init.levelCap}. ` +
          `Split it into smaller ${init.kind === "directory" ? "subfolders" : "parts"}. Nothing was written.`
        : `${subject} (${size}) needs a single node of about ${init.estimatedGas} gas, more than the ${init.ceiling} one ` +
          `transaction may use here. Nothing was written.`;
    super(msg);
    this.kind = init.kind;
    this.reason = init.reason;
    this.path = init.path;
    if (init.estimatedGas !== undefined) this.estimatedGas = init.estimatedGas;
    if (init.ceiling !== undefined) this.ceiling = init.ceiling;
    if (init.levelsNeeded !== undefined) this.levelsNeeded = init.levelsNeeded;
    if (init.levelCap !== undefined) this.levelCap = init.levelCap;
    if (init.entryCount !== undefined) this.entryCount = init.entryCount;
    if (init.fileBytes !== undefined) this.fileBytes = init.fileBytes;
    if (init.chunkCount !== undefined) this.chunkCount = init.chunkCount;
  }
}

/** The first estimate that does not fit `ceiling` (each dimension checked on its own), or the largest total if all fit. */
function worst(candidates: readonly GasEstimate[], ceiling: number | SingleCallLimits): { estimate: GasEstimate; fits: boolean } {
  const bad = candidates.find((c) => !fitsSingleCall(c, ceiling));
  if (bad) return { estimate: bad, fits: false };
  const top = candidates.reduce((a, b) => (a.execution + a.state >= b.execution + b.state ? a : b), { execution: 0, state: 0 });
  return { estimate: top, fits: true };
}

/**
 * Throw {@link PlanTooLargeError} if this directory cannot be written: it would need more than the level cap, or one of
 * its nodes could not fit one call under `ceiling` on `schedule`. A big directory is NOT an error; it is more nodes.
 */
export function assertDirectoryFits(
  path: string,
  entries: ReadonlyArray<{ name: string; nameBytes?: Uint8Array; isDirectory: boolean }>,
  ceiling: number | SingleCallLimits,
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): void {
  const items = sortedNameItems(entries);
  const leaves = partitionEntryLeaves(items);
  const levels = branchLevelsNeeded(leaves.length);
  if (levels > NODE_MAX_LEVEL) {
    throw new PlanTooLargeError({
      kind: "directory",
      reason: "levels",
      path,
      entryCount: entries.length,
      levelsNeeded: levels,
      levelCap: NODE_MAX_LEVEL,
    });
  }
  const extra = schedule.newSlotExecution + schedule.newAccountExecution;
  const leafGas = (count: number, nameBytes: number): GasEstimate => ({
    execution: entryLeafExecution(count, nameBytes) + extra,
    state: nodeStateGas(entryLeafBlobSize(count, nameBytes), schedule),
  });
  const candidates: GasEstimate[] = [];
  let at = 0;
  let longest = 0;
  for (const count of leaves) {
    let nameBytes = 0;
    for (let i = 0; i < count; i++) {
      nameBytes += items[at + i]!.nameLength;
      longest = Math.max(longest, items[at + i]!.nameLength);
    }
    at += count;
    candidates.push(leafGas(count, nameBytes));
  }
  if (levels > 0) {
    // The worst branch: full, at the top level, every edge as long as the longest name here.
    const children = Math.min(leaves.length, 128);
    const shape = { level: levels, edgeNameBytes: Math.max(0, children - 1) * 2 * longest };
    candidates.push({ execution: branchExecution(children, false, shape) + extra, state: nodeStateGas(branchBlobSize(children), schedule) });
  }
  const w = worst(candidates, ceiling);
  if (!w.fits) {
    throw new PlanTooLargeError({
      kind: "directory",
      reason: "node-gas",
      path,
      entryCount: entries.length,
      estimatedGas: w.estimate.execution + w.estimate.state,
      ceiling: asLimits(ceiling).maxGas,
    });
  }
}

/** Throw {@link PlanTooLargeError} if this file cannot be written (level cap, or a node above `ceiling` on `schedule`). */
export function assertFileFits(
  path: string,
  chunkCount: number,
  storedBytes: number,
  ceiling: number | SingleCallLimits,
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): void {
  // Arithmetic, not an array: a hostile or enormous count must not allocate millions of entries to be refused.
  const leafCount = Math.ceil(Math.max(1, chunkCount) / CHUNK_LEAF_MAX_HASHES);
  const levels = branchLevelsNeeded(leafCount);
  if (levels > NODE_MAX_LEVEL) {
    throw new PlanTooLargeError({
      kind: "file",
      reason: "levels",
      path,
      chunkCount,
      fileBytes: storedBytes,
      levelsNeeded: levels,
      levelCap: NODE_MAX_LEVEL,
    });
  }
  const hashes = Math.min(CHUNK_LEAF_MAX_HASHES, Math.max(1, chunkCount));
  const extra = schedule.newSlotExecution + schedule.newAccountExecution;
  const candidates: GasEstimate[] = [
    { execution: chunkLeafExecution(hashes) + extra, state: nodeStateGas(chunkLeafBlobSize(hashes), schedule) },
  ];
  if (levels > 0) {
    const children = Math.min(leafCount, 128);
    candidates.push({ execution: branchExecution(children, true) + extra, state: nodeStateGas(branchBlobSize(children, true), schedule) });
  }
  const w = worst(candidates, ceiling);
  if (!w.fits) {
    throw new PlanTooLargeError({
      kind: "file",
      reason: "node-gas",
      path,
      chunkCount,
      fileBytes: storedBytes,
      estimatedGas: w.estimate.execution + w.estimate.state,
      ceiling: asLimits(ceiling).maxGas,
    });
  }
}
