/**
 * How many JSON-RPC calls a publish costs, and whether that fits the budget it will be paid from.
 *
 * A client that reads through a rate-limited RPC proxy has a fixed number of CALLS per minute to spend (a batch of
 * 50 costs 50). Probes are batched (`probeExistence`), so the number below is small; it
 * is still estimated BEFORE the first paid write so a project too big for one minute is refused (or offered
 * a slow run) while that is still free, not halfway through after content has been paid for.
 */
import type { TxPlan } from "./draft.js";
import { PROBE_BATCH } from "./multicall.js";

/**
 * The default allowance: calls per minute per caller, for a client behind a rate-limited proxy. A client whose
 * proxy allows another number passes `budgetPerMinute`.
 */
export const RPC_PROXY_CALLS_PER_MINUTE = 600;

/** A publish may plan to use at most this fraction of the minute: reads for the UI itself share it. */
export const RPC_BUDGET_SAFE_FRACTION = 0.5;

/** Below this many calls the estimate is not worth showing to a person. */
export const RPC_ESTIMATE_DISPLAY_THRESHOLD = 150;

/**
 * Calls one confirmed transaction can cost: its simulation, gas / fee / nonce lookups when the client signs
 * over the same RPC (the CLI does; a browser wallet answers those itself), and a few receipt polls. Measured
 * on anvil: 6 to 9 per transaction. The estimate takes the top of that range.
 */
const CALLS_PER_TX = 9;
/** Fixed cost of a publish: preflight, version count, version read-back, name/tag read-backs. */
const FIXED_CALLS = 14;

const batches = (n: number): number => (n === 0 ? 0 : Math.ceil(n / PROBE_BATCH));

export interface PublishCallEstimate {
  /** Reads for the plan itself (existence probes, `maxChunkSize`). */
  planning: number;
  /** Reads for executing it: simulations, receipt polls, stage confirmations, read-backs. */
  publish: number;
  total: number;
  /** Calls per minute this plan may use, and whether `total` exceeds it. */
  safeBudget: number;
  exceedsSafeBudget: boolean;
  /** Whole minutes `total` needs at the proxy's allowance (>= 1). */
  minutesAtFullBudget: number;
}

/**
 * Estimate from a computed plan. `totals` is the size of the WHOLE tree (what planning probes), which is
 * larger than what the plan has left to write once dedup has removed content already on chain.
 */
export function estimatePublishCalls(
  plan: Pick<TxPlan, "chunksToWrite" | "filesToCreate" | "dirsToCreate" | "bundles" | "setTag" | "setName"> &
    Partial<Pick<TxPlan, "chunkNodesToCreate" | "entryNodesToCreate">>,
  totals: { chunks: number; files: number; dirs: number; /** Chunk nodes in the whole tree; defaults to the plan's missing ones. */ chunkNodes?: number; /** Entry nodes in the whole tree; defaults to the plan's missing ones. */ entryNodes?: number },
  opts: { replan?: boolean; budgetPerMinute?: number } = {},
): PublishCallEstimate {
  const chunkNodes = plan.chunkNodesToCreate?.length ?? 0;
  const entryNodes = plan.entryNodesToCreate?.length ?? 0;
  // Content probes run in three rounds: files and directories; the nodes of the missing ones; the chunks the
  // missing leaves name. Each is batched, so volume grows with items / 150, not with items.
  const planning =
    batches(totals.files) + batches(totals.dirs) + batches(totals.chunkNodes ?? chunkNodes) + batches(totals.entryNodes ?? entryNodes) + batches(totals.chunks) + 1;
  const txs = plan.bundles.length + 1 + (plan.setTag ? 1 : 0) + (plan.setName ? 1 : 0);
  // Each stage is confirmed once before the next one and once at the end; probes there are batched.
  const confirms =
    2 * (batches(plan.chunksToWrite.length) + batches(chunkNodes) + batches(plan.filesToCreate.length) + batches(entryNodes) + batches(plan.dirsToCreate.length)) +
    plan.bundles.length;
  const publish = txs * CALLS_PER_TX + confirms + FIXED_CALLS + (opts.replan ? planning : 0);
  const total = planning + publish;
  const budget = opts.budgetPerMinute ?? RPC_PROXY_CALLS_PER_MINUTE;
  const safeBudget = Math.floor(budget * RPC_BUDGET_SAFE_FRACTION);
  return {
    planning,
    publish,
    total,
    safeBudget,
    exceedsSafeBudget: total > safeBudget,
    minutesAtFullBudget: Math.max(1, Math.ceil(total / budget)),
  };
}

/** The sentence a person sees when an estimate is large enough to matter, or null when it is not. */
export function describeCallEstimate(e: PublishCallEstimate): string | null {
  if (e.total < RPC_ESTIMATE_DISPLAY_THRESHOLD) return null;
  return `This publish makes about ${e.total.toLocaleString("en-US")} RPC reads.`;
}
