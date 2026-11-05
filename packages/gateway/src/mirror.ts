/**
 * The mirror: follow the publish ledger and pin every new root to IPFS.
 *
 * The whole job is one cursor over one list. `ProjectHook` keeps an append-only ledger of every
 * publish across every org, `Lens.publishRange` reads it back with full records, and an
 * append-only list means "the last index I handled" is a complete description of where you are. No
 * indexer, no database, no log scan — logs are pruned by providers, and a mirror that depends on them
 * silently stops finding things the day a window rolls past it.
 *
 * What it does not do, and cannot: pin content that was written to the stores but never published by
 * any project. The stores keep no enumeration of those, so a mirror of literally every byte has to
 * watch the stores directly. A mirror of everything anyone has PUBLISHED is this file.
 *
 * Idempotent by construction. Pinning a root that is already pinned is a no-op at the provider, the
 * cursor only advances after a root has been handled, and a crash replays at most one entry.
 */
import { mkdir, readFile as readFileFs, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import {
  AbxfsClient,
  ProjectKind,
  cidKind,
  DirectoryNeedsShardingError,
  fileChunkCount,
  ipfsDirectoryEstimate,
  IPFS_SHARD_THRESHOLD_BYTES,
  LimitExceededError,
  readDirectory,
  readGlobalPublishCount,
  orgGenerations,
  readGlobalPublishes,
  type OrgGeneration,
  type OrgPublish,
} from "@artblocks/abxfs-sdk";
import { pinDirectory, pinFile, type PinningProvider } from "@artblocks/abxfs-pinning";

import { orgSubject, projectSubject, rootSubject } from "./subjects.js";
import type { Filter, GatewayChain } from "./types.js";

/** Where the mirror remembers how far it got. */
export interface CursorStore {
  load(): Promise<number>;
  /** `ledger` is the ledger length seen when saving; a file cursor records it beside the index. */
  save(next: number, ledger?: number): Promise<void>;
}

export function memoryCursor(start = 0): CursorStore {
  let n = start;
  return { load: async () => n, save: async (next) => void (n = next) };
}

/** What a cursor file holds. `hook` and `ledger` are absent from files written before cursors were keyed by hook. */
export interface CursorFile {
  next: number;
  hook?: string;
  ledger?: number;
}

/** Read a cursor file, or `null` when it does not exist. A file that is not a cursor throws. */
export async function readCursorFile(path: string): Promise<CursorFile | null> {
  let raw: string;
  try {
    raw = await readFileFs(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as { next?: unknown; hook?: unknown; ledger?: unknown };
  const next = typeof parsed.next === "number" && parsed.next >= 0 ? Math.floor(parsed.next) : 0;
  return {
    next,
    ...(typeof parsed.hook === "string" ? { hook: parsed.hook.toLowerCase() } : {}),
    ...(typeof parsed.ledger === "number" ? { ledger: parsed.ledger } : {}),
  };
}

async function writeCursorFile(path: string, file: CursorFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique temp name: two mirrors pointed at one cursor file (a misconfiguration, but a real
  // one) must not interleave writes into the same temp file and rename a torn result into place.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file)}\n`);
  await rename(tmp, path);
}

/**
 * A cursor in a JSON file, written atomically. The write is a temp file and a rename, so a crash
 * mid-write leaves the previous cursor in place rather than a half-written one that reads as zero and
 * silently starts the whole ledger again.
 *
 * Pass the generation's `hook` and the file records it, and a file that names a DIFFERENT hook is refused
 * on load: a cursor is an index into one specific ledger, and following it into another silently skips
 * everything the index happens to be past.
 */
export function fileCursor(path: string, options: { hook?: string } = {}): CursorStore {
  const hook = options.hook?.toLowerCase();
  return {
    async load() {
      const file = await readCursorFile(path);
      if (!file) return 0;
      if (hook && file.hook && file.hook !== hook) {
        throw new Error(
          `cursor file ${path} belongs to hook ${file.hook}, not ${hook}. Refusing to follow another ledger's index; ` +
            "give each generation its own file (see cursorPathFor).",
        );
      }
      return file.next;
    },
    async save(next, ledger) {
      await writeCursorFile(path, { next, ...(hook ? { hook } : {}), ...(ledger !== undefined ? { ledger } : {}) });
    },
  };
}

/**
 * The cursor file for ONE generation: `<base>.<first 8 hex of its hook>.json`. Keyed by the hook (never by
 * the generation's position in the list), because position changes the day a new factory ships: an
 * index-keyed file moves to the new factory and its ledger is silently skipped up to that index.
 */
export function cursorPathFor(base: string, generation: { projectHook: string }): string {
  const suffix = `.${generation.projectHook.slice(2, 10).toLowerCase()}`;
  return /\.json$/i.test(base) ? base.replace(/\.json$/i, `${suffix}.json`) : `${base}${suffix}.json`;
}

/**
 * Limits on what ONE root may cost. A root is permissionless input: anyone can publish one that is
 * enormous, or a directory shaped to make a walker do exponential work, and a mirror pins every
 * publish. A root over any cap is skipped with a log line and the cursor moves past it.
 *
 * Sizes are STORED sizes, estimated as chunks x the backend's chunk ceiling: the logical size of a
 * compressed file is only known by inflating it, which is the work being avoided here.
 */
export interface MirrorLimits {
  /** Estimated stored bytes in one root. Default 256 MiB. */
  maxRootBytes?: number;
  /** Files in one root. Default 20,000. */
  maxFilesPerRoot?: number;
  /**
   * Directory entries READ for one root, counted across every directory listed. Default 100,000. Distinct files and
   * directories are bounded above, but not what reading them costs: directories that differ in one name share almost
   * every node on chain, so a root of 300 such siblings of 15,000 entries each is cheap to write, holds ONE distinct
   * file, and used to cost 4.5 million entries (45,000 calls) to assess.
   */
  maxEntriesPerRoot?: number;
  /** Roots pinned in one run, then stop. Default: unlimited. For a cron run that must stay bounded. */
  maxRootsPerRun?: number;
}

export const DEFAULT_MAX_ROOT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_ROOT = 20_000;
export const DEFAULT_MAX_ENTRIES_PER_ROOT = 100_000;
/** The SSTORE2 backend's chunk ceiling. A bound, not a measurement. */
const CHUNK_CEILING = 24_575;


export class RootTooLargeError extends Error {}

/**
 * The root holds a CID the filter refuses. Not transient: the root is skipped and the cursor moves on, as for a root
 * the filter refuses by name.
 */
export class RootContainsBlockedError extends Error {}

/**
 * What {@link assessRoot} checks a tree's CIDs against: the mirror's filter, and the subjects the ledger entry itself
 * named (its project, its org, its root). Those are sent with every check, the way the gateway sends a request's
 * subjects with the CID it serves, so an allowlist that admitted the entry still admits its tree and a denylist
 * refuses it if ANY CID in it is listed.
 */
export interface TreeFilter {
  filter: Filter;
  subjects: string[];
}

/**
 * Walk a root under the caps, visiting each distinct node once. Throws {@link RootTooLargeError}.
 *
 * With a {@link TreeFilter}, every CID listed in the tree (each subdirectory and each file) is asked about as
 * `root:<cid>` as soon as its directory is read, before anything else is read for it, and a refusal throws
 * {@link RootContainsBlockedError}. The gateway refuses a blocked CID wherever it is served, so a mirror that pinned a
 * tree holding one would publish to IPFS what the gateway will not serve. Costs no RPC call: the listing that names
 * those CIDs is read anyway.
 */
export async function assessRoot(
  chain: GatewayChain,
  cid: OrgPublish["cid"],
  kind: ProjectKind,
  limits: MirrorLimits = {},
  treeFilter?: TreeFilter,
): Promise<{ files: number; estimatedBytes: number }> {
  const maxBytes = limits.maxRootBytes ?? DEFAULT_MAX_ROOT_BYTES;
  const maxFiles = limits.maxFilesPerRoot ?? DEFAULT_MAX_FILES_PER_ROOT;
  const maxEntries = limits.maxEntriesPerRoot ?? DEFAULT_MAX_ENTRIES_PER_ROOT;
  let files = 0;
  let bytes = 0;
  let entriesRead = 0;

  const countFile = async (fileCid: OrgPublish["cid"]) => {
    files++;
    bytes += (await fileChunkCount(chain.client, chain.contracts, fileCid)) * CHUNK_CEILING;
    if (files > maxFiles) throw new RootTooLargeError(`more than ${maxFiles} files`);
    if (bytes > maxBytes) throw new RootTooLargeError(`about ${Math.round(bytes / 1048576)} MiB stored, over the ${Math.round(maxBytes / 1048576)} MiB cap`);
  };

  if (kind === ProjectKind.File) {
    await countFile(cid);
    return { files, estimatedBytes: bytes };
  }

  const seen = new Set<string>([cid]);
  const queue: OrgPublish["cid"][] = [cid];
  // Distinct directories are bounded too: a shared sub-DAG must not be expanded once per parent.
  while (queue.length > 0) {
    const dir = queue.pop()!;
    if (seen.size > maxFiles * 2) throw new RootTooLargeError("too many directories");
    // A directory is read in pages of 100; the count is checked first, so a directory with millions of entries is
    // refused for one read, not after paging through it. Every entry read is charged to the root's budget, already
    // `seen` or not: reading it is the cost, whatever it turns out to name.
    const budgetLeft = maxEntries - entriesRead;
    let listed;
    try {
      listed = (await readDirectory(chain.client, chain.contracts, dir, { maxEntries: Math.min(maxFiles, budgetLeft) })).entries;
    } catch (err) {
      if (err instanceof LimitExceededError) {
        throw new RootTooLargeError(
          budgetLeft < maxFiles
            ? `more than ${maxEntries} directory entries to read in one root`
            : `a directory with more than ${maxFiles} entries`,
        );
      }
      throw err;
    }
    entriesRead += listed.length;
    if (entriesRead > maxEntries) throw new RootTooLargeError(`more than ${maxEntries} directory entries to read in one root`);
    // Kubo shards a directory whose link estimate passes the threshold (the SDK's rule, `specs/abx-fs.md` §8), and
    // the HAMT form is not derived here, so such a directory has no IPFS CID this mirror can pin: it is skipped by
    // name rather than pinned under a CID `ipfs add` would never give.
    const estimate = ipfsDirectoryEstimate(listed);
    if (estimate > IPFS_SHARD_THRESHOLD_BYTES) {
      throw new RootTooLargeError(
        `a directory of ${listed.length} entries that IPFS would shard (link estimate ${estimate} bytes, over ` +
          `${IPFS_SHARD_THRESHOLD_BYTES}); the HAMT-sharded form is not implemented yet`,
      );
    }
    if (treeFilter && listed.length > 0) {
      const inner = [...new Set(listed.map((entry) => rootSubject(entry.cid)))];
      const decision = await treeFilter.filter({ subjects: [...treeFilter.subjects, ...inner] });
      if (!decision.allow) {
        throw new RootContainsBlockedError(`it holds a CID the filter refuses (${decision.reason ?? "filtered"}), inside directory ${dir}`);
      }
    }
    for (const entry of listed) {
      if (seen.has(entry.cid)) continue;
      seen.add(entry.cid);
      if (entry.isDirectory) queue.push(entry.cid);
      else await countFile(entry.cid);
    }
  }
  return { files, estimatedBytes: bytes };
}

export interface MirrorOptions extends MirrorLimits {
  /** The chain to follow. Needs the org layer: a hook and a lens. */
  chain: GatewayChain;
  /**
   * Which factory generation's ledger to follow. Default: the chain's current one. Each generation
   * keeps its own append-only ledger and an org keeps publishing into the one that made it, so
   * following everything means one run per generation — see {@link runMirrorGenerations}.
   */
  generation?: OrgGeneration;
  provider: PinningProvider;
  cursor: CursorStore;
  /** Same filter as the gateway. A refused entry is skipped, and the cursor moves past it. */
  filter?: Filter;
  /** Ledger entries read per call. Default 50. */
  pageSize?: number;
  /** How long to wait for new publishes when caught up. Default 15s. */
  pollMs?: number;
  /** Failures on one entry before it is skipped and logged. Default 5. */
  maxAttempts?: number;
  /** Stop when caught up instead of waiting for more. */
  once?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /**
   * How one root gets pinned. The default reads it from chain and hands it to `provider`; replace it
   * to mirror somewhere that is not an IPFS pinning service, or to test the loop without one.
   *
   * The default also checks every CID inside the tree against `filter` ({@link assessRoot}). A replacement is handed
   * the same {@link TreeFilter} (when there is a filter) and should pass it to `assessRoot` to keep that rule.
   */
  pinRoot?: (cid: OrgPublish["cid"], treeFilter?: TreeFilter) => Promise<void>;
  /** Delay before retrying a failed entry, in ms, given the attempt that just failed. */
  backoffMs?: (attempt: number) => number;
}

export interface MirrorStats {
  /** Roots pinned this run. */
  pinned: number;
  /** Entries skipped: filtered, a root already handled this run, or given up on. */
  skipped: number;
  /** The index the next run starts from. */
  next: number;
}

/** A `--max-*` mirror flag: absent, or a positive safe integer. Anything else throws, naming the flag. */
export function parsePositiveFlag(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

/**
 * `--poll-seconds`: a positive number of seconds, at most a day. A value that is not one (`abc`, `0`, empty) used to
 * become `NaN` milliseconds, which `setTimeout` runs at once: a tight loop of ledger reads against the RPC.
 */
export function parsePollSeconds(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || n <= 0 || n > 86_400) {
    throw new Error(`--poll-seconds must be a positive number of seconds, at most 86400 (got "${raw}")`);
  }
  return n;
}

export async function runMirror(options: MirrorOptions): Promise<MirrorStats> {
  const { chain, provider, cursor, filter, signal } = options;
  const pageSize = options.pageSize ?? 50;
  const pollMs = options.pollMs ?? 15_000;
  // A NaN, zero or negative wait would make "caught up" a busy loop of ledger reads.
  if (!(Number.isFinite(pollMs) && pollMs > 0)) throw new Error(`pollMs must be a positive number of milliseconds (got ${pollMs})`);
  const maxAttempts = options.maxAttempts ?? 5;
  const log = options.log ?? (() => {});

  const generation = options.generation ?? orgGenerations(chain.contracts)[0];
  const hook = generation?.projectHook;
  const lens = generation?.lens;
  if (!hook || !lens) {
    throw new Error(`chain ${chain.id} has no org layer deployed (hook and lens), so there is no ledger to follow`);
  }

  const client = new AbxfsClient({ publicClient: chain.client, addresses: chain.contracts });
  const handled = new Set<string>(); // roots already pinned in this run: one root, many publishes
  const stats: MirrorStats = { pinned: 0, skipped: 0, next: await cursor.load() };

  while (!signal?.aborted) {
    const total = Number(await readGlobalPublishCount(chain.client, hook));
    if (stats.next > total) {
      // A cursor ahead of the ledger means it belongs to a different deployment. Following it would
      // silently miss everything until the ledger caught up, so stop and say so.
      throw new Error(`cursor is at ${stats.next} but the ledger has ${total} entries — wrong cursor file for this chain?`);
    }

    if (stats.next === total) {
      if (options.once) break;
      await sleep(pollMs, signal);
      continue;
    }

    const page = await readGlobalPublishes(chain.client, lens, { start: BigInt(stats.next), count: pageSize });
    if (page.length === 0) continue;

    for (const entry of page) {
      if (signal?.aborted) break;
      if (options.maxRootsPerRun !== undefined && stats.pinned >= options.maxRootsPerRun) {
        log(`reached --max-roots-per-run (${options.maxRootsPerRun}); stopping with the cursor at ${stats.next}`);
        return stats;
      }
      const outcome = await handleEntry({
        entry,
        filter,
        handled,
        maxAttempts,
        log,
        backoffMs: options.backoffMs ?? ((a) => Math.min(30_000, 500 * 2 ** a)),
        chainId: chain.id,
        pin: options.pinRoot ?? ((cid, treeFilter) => pinRoot(client, chain, provider, cid, options, treeFilter)),
        pinnedThisRun: stats.pinned,
        maxRootsPerRun: options.maxRootsPerRun,
      });
      if (outcome === "pinned") stats.pinned++;
      else stats.skipped++;
      stats.next++;
      await cursor.save(stats.next, total); // after the entry, never before: a crash replays one, never skips one
    }
  }
  return stats;
}

export interface GenerationFailure {
  projectHook: string;
  orgFactory: string;
  error: string;
}

export interface MirrorGenerationsStats extends MirrorStats {
  /** One entry per generation that failed. The others ran to completion. */
  failures: GenerationFailure[];
  /** Every generation's own stats, newest first, `null` where it failed. */
  generations: { projectHook: string; stats: MirrorStats | null }[];
}

/**
 * Follow every generation's ledger at once: one cursor per generation, from `cursorFor`.
 *
 * Orgs a superseded factory made keep publishing into that factory's hook, so a mirror that only
 * followed the current one would silently stop pinning them the day a new factory shipped. Stats are
 * summed; `next` is the current generation's.
 *
 *  - EVERY generation must have a lens. A generation the mirror cannot read is a ledger nobody pins, and
 *    skipping it quietly is how that would go unnoticed: this throws, naming it, before anything starts.
 *  - Generations run independently (`allSettled`). One that fails (a cursor that does not match its ledger,
 *    an RPC that errors) is logged and reported in `failures` while the others carry on, rather than its
 *    rejection tearing down every other generation's pinning.
 */
export async function runMirrorGenerations(
  options: Omit<MirrorOptions, "generation" | "cursor"> & {
    cursorFor: (generation: OrgGeneration, index: number) => CursorStore;
    /** Called once every check above has passed, before any generation runs: a start-up warning never precedes a refusal. */
    onStart?: () => void;
  },
): Promise<MirrorGenerationsStats> {
  const { cursorFor, onStart, ...rest } = options;
  const generations = orgGenerations(options.chain.contracts);
  if (generations.length === 0) {
    throw new Error(`chain ${options.chain.id} has no org layer deployed (hook and lens), so there is no ledger to follow`);
  }
  const missing = generations.filter((g) => !g.lens);
  if (missing.length > 0) {
    throw new Error(
      `chain ${options.chain.id}: factory generation(s) ${missing.map((g) => `${g.orgFactory} (hook ${g.projectHook})`).join(", ")} ` +
        "have no lens, so their publish ledger cannot be read and would never be pinned. Add the lens address to that generation in the registry; " +
        "refusing to skip it silently.",
    );
  }
  const log = options.log ?? (() => {});
  onStart?.();
  const settled = await Promise.allSettled(
    generations.map((generation, i) => runMirror({ ...rest, generation, cursor: cursorFor(generation, i) })),
  );
  const failures: GenerationFailure[] = [];
  const per = settled.map((r, i) => {
    const g = generations[i]!;
    if (r.status === "fulfilled") return { projectHook: g.projectHook, stats: r.value };
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    failures.push({ projectHook: g.projectHook, orgFactory: g.orgFactory, error });
    log(`GENERATION FAILED (hook ${g.projectHook}, factory ${g.orgFactory}): ${error}`);
    return { projectHook: g.projectHook, stats: null };
  });
  const ok = per.map((p) => p.stats).filter((x): x is MirrorStats => x !== null);
  return {
    pinned: ok.reduce((n, r) => n + r.pinned, 0),
    skipped: ok.reduce((n, r) => n + r.skipped, 0),
    next: per[0]!.stats?.next ?? 0,
    failures,
    generations: per,
  };
}

async function handleEntry(args: {
  entry: OrgPublish;
  chainId: number;
  filter: Filter | undefined;
  handled: Set<string>;
  maxAttempts: number;
  log: (line: string) => void;
  backoffMs: (attempt: number) => number;
  pin: (cid: OrgPublish["cid"], treeFilter?: TreeFilter) => Promise<void>;
  pinnedThisRun: number;
  maxRootsPerRun: number | undefined;
}): Promise<"pinned" | "skipped"> {
  const { entry, chainId, filter, handled, maxAttempts, log, backoffMs, pin } = args;
  const label = `${entry.org} #${entry.tokenId} v${entry.version} ${entry.cid}`;
  const subjects = [projectSubject(chainId, entry.org, entry.tokenId), orgSubject(chainId, entry.org), rootSubject(entry.cid)];

  if (filter) {
    const decision = await filter({ subjects });
    if (!decision.allow) {
      log(`skip (${decision.reason ?? "filtered"}) ${label}`);
      return "skipped";
    }
  }

  if (handled.has(entry.cid)) return "skipped";

  for (let attempt = 1; ; attempt++) {
    try {
      await pin(entry.cid, filter ? { filter, subjects } : undefined);
      handled.add(entry.cid);
      log(`pinned ${label}`);
      return "pinned";
    } catch (err) {
      if (err instanceof RootContainsBlockedError) {
        // The same rule as a root refused by name: never pinned, never retried. Not added to `handled`: another
        // publish of this root (under a project the filter treats differently) is asked again.
        log(`skip (${err.message}) ${label}`);
        return "skipped";
      }
      // `@artblocks/abxfs-pinning` refuses a directory IPFS would shard (`DirectoryTooLargeForFlatIpfsError`, a
      // `DirectoryNeedsShardingError`); that is as permanent as a root over the caps here.
      if (
        err instanceof RootTooLargeError ||
        err instanceof DirectoryNeedsShardingError ||
        (err as Error)?.name === "DirectoryTooLargeForFlatIpfsError"
      ) {
        // Not transient: retrying changes nothing. Say why, once, and move on.
        log(`SKIPPED (too large: ${(err as Error).message}) ${label}`);
        handled.add(entry.cid);
        return "skipped";
      }
      if (attempt >= maxAttempts) {
        // One unpinnable root must not stop the mirror behind it forever. It is logged loudly and
        // left for an operator; the next run does not retry it, since the cursor has moved on.
        log(`GAVE UP after ${attempt} attempts on ${label}: ${(err as Error).message}`);
        return "skipped";
      }
      await sleep(backoffMs(attempt));
    }
  }
}

/** Pin one ABX FS root, a directory tree or a single file, as a CAR of its derived IPFS DAG. */
async function pinRoot(
  client: AbxfsClient,
  chain: GatewayChain,
  provider: PinningProvider,
  cid: OrgPublish["cid"],
  limits: MirrorLimits,
  treeFilter?: TreeFilter,
): Promise<void> {
  const kind = await cidKind(chain.client, chain.contracts, cid);
  if (kind !== ProjectKind.Unset) await assessRoot(chain, cid, kind, limits, treeFilter);

  if (kind === ProjectKind.Directory) {
    await pinDirectory({ client, directoryCid: cid, provider, verify: true });
    return;
  }
  if (kind === ProjectKind.File) {
    await pinFile({ client, fileCid: cid, provider, verify: true });
    return;
  }
  throw new Error(`root ${cid} is not stored on chain ${chain.id}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
