#!/usr/bin/env node
/**
 * `abxfs-mirror` — pin everything that gets published to IPFS.
 *
 *   abxfs-mirror --chain <network> --provider local                    follow forever, Kubo on :5001
 *   abxfs-mirror --chain <network> --provider pinata --once            catch up and exit (cron)
 *   abxfs-mirror --chain <network> --provider local --deny list.txt    skip what the list names
 *
 * It remembers where it got to in --cursor (default ./abxfs-mirror.<chainId>.json), so a restart
 * resumes rather than starting over. There is one file PER FACTORY GENERATION, named for that generation's
 * hook (`abxfs-mirror.<chainId>.<hook8>.json`), so a new factory starts its own ledger from zero and never
 * inherits another's position. Delete a file to re-mirror that generation from its first publish.
 */
import { parseArgs } from "node:util";

import { localPinningProvider, pinataPinningProvider } from "@abxfs/pinning";

import { CHAIN_NAMES, chainsFromEnv, parseOneChain, requireDeployed } from "../config.js";
import { allOf, fileFilter, orgAllowlistFromArg } from "../filters.js";
import { orgGenerations, readGlobalPublishCount } from "@abxfs/sdk";

import { cursorPathFor, fileCursor, parsePollSeconds, parsePositiveFlag, runMirrorGenerations } from "../mirror.js";
import type { Filter } from "../types.js";

const log = (line: string) => console.error(`[mirror] ${line}`);

/**
 * A start-up refusal: ONE line and exit 2, never a stack trace. A bad flag and an undeployed chain both end here. One
 * line even when the error is several (node's "argument is ambiguous" for `--poll-seconds -5` is three).
 */
function atStartup<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    log(`NOT STARTED: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim()}`);
    return process.exit(2);
  }
}

/** The environment variable each option falls back to when its flag is not given. */
const ENV = { chain: "ABXFS_CHAIN", deny: "ABXFS_DENYLIST", allow: "ABXFS_ALLOWLIST", "allow-orgs": "ABXFS_ALLOW_ORGS" } as const;

// An unknown flag, a stray argument or a flag without its value is a refusal too.
const { values, tokens } = atStartup(() => parseArgs({
  tokens: true,
  options: {
    chain: { type: "string", default: process.env[ENV.chain] },
    provider: { type: "string", default: "local" },
    endpoint: { type: "string" },
    // Discouraged: a key on the command line lands in shell history and `ps`. Use PINATA_JWT. Accepted, with a
    // warning.
    "api-key": { type: "string" },
    "max-root-bytes": { type: "string" },
    "max-files-per-root": { type: "string" },
    "max-entries-per-root": { type: "string" },
    "max-roots-per-run": { type: "string" },
    cursor: { type: "string" },
    deny: { type: "string", default: process.env[ENV.deny] },
    allow: { type: "string", default: process.env[ENV.allow] },
    "allow-orgs": { type: "string", default: process.env[ENV["allow-orgs"]] },
    once: { type: "boolean", default: false },
    "poll-seconds": { type: "string", default: "15" },
    help: { type: "boolean", short: "h", default: false },
  },
}));

const onCommandLine = new Set<string>(tokens.flatMap((t) => (t.kind === "option" ? [t.name] : [])));
/** What a refusal calls an option: its flag, or the environment variable its value came from when the flag was not given. */
function named(option: string): string {
  const env = (ENV as Record<string, string | undefined>)[option];
  return env !== undefined && !onCommandLine.has(option) && process.env[env] !== undefined ? env : `--${option}`;
}
/**
 * {@link atStartup} for one option's check, said as {@link named} says it: the flag (or the variable) replaces the flag
 * in the error, and names it when the error does not (an unreadable list file says only its path).
 */
function flagAtStartup<T>(option: string, check: () => T): T {
  const name = named(option);
  return atStartup(() => {
    try {
      return check();
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split(`--${option}`).join(name);
      throw new Error(message.includes(name) ? message : `${name}: ${message}`);
    }
  });
}

if (values.help) {
  console.log(`abxfs-mirror --chain <network|id> [--provider local|pinata]
             [--endpoint url] [--api-key key] [--cursor file] [--deny file] [--allow file]
             [--allow-orgs 0xA,0xB|file] [--once] [--poll-seconds 15]
             [--max-root-bytes 268435456] [--max-files-per-root 20000] [--max-entries-per-root 100000]
             [--max-roots-per-run n]

  local       Kubo RPC API (default endpoint http://127.0.0.1:5001)
  pinata      Pinata (key from the PINATA_JWT environment variable)

  Each root goes to the provider as one CAR of its derived IPFS DAG, which the provider imports and pins.

  A root over --max-root-bytes (estimated STORED size), --max-files-per-root or --max-entries-per-root
  (directory entries read to assess it, across all its directories) is skipped, with a log line saying
  why, and the cursor moves past it. --poll-seconds is how long to wait for new publishes when caught up
  (a positive number, at most a day). --api-key still works but is deprecated: a
  key on the command line is visible in shell history and the process list.`);
  process.exit(0);
}
// No chain is a refusal like any other: one line, exit 2 (it used to print the usage and exit 1).
if (!values.chain) {
  atStartup(() => {
    throw new Error(`--chain is required (or ABXFS_CHAIN): ${CHAIN_NAMES}; --help for the rest`);
  });
}

const apiKey = process.env["PINATA_JWT"] ?? values["api-key"];

// EVERY flag is checked before the chain is: a bad value is the operator's to fix first, deployed chain or not.
const pollMs = atStartup(() => Math.round(parsePollSeconds(values["poll-seconds"]) * 1000));
const limits = atStartup(() => {
  const out: { maxRootBytes?: number; maxFilesPerRoot?: number; maxEntriesPerRoot?: number; maxRootsPerRun?: number } = {};
  const flag = (name: string) => parsePositiveFlag(name, values[name as keyof typeof values] as string | undefined);
  const set = (key: keyof typeof out, n: number | undefined) => {
    if (n !== undefined) out[key] = n;
  };
  set("maxRootBytes", flag("max-root-bytes"));
  set("maxFilesPerRoot", flag("max-files-per-root"));
  set("maxEntriesPerRoot", flag("max-entries-per-root"));
  set("maxRootsPerRun", flag("max-roots-per-run"));
  return out;
});
// One cursor per chain: a list, or a value that names no chain (" ", ","), is a mistake, never the first or none.
const chainId = flagAtStartup("chain", () => parseOneChain(values.chain, "--chain", { required: true })!);
const pinning = atStartup(provider);
const filters: Filter[] = [];
const fileOpts = { onInvalid: (l: string, n: number) => log(`ignoring line ${n}, not a subject: ${l}`) };
if (values.deny) filters.push(flagAtStartup("deny", () => fileFilter(values.deny!, "deny", fileOpts)));
if (values.allow) filters.push(flagAtStartup("allow", () => fileFilter(values.allow!, "allow", fileOpts)));
if (values["allow-orgs"]) filters.push(flagAtStartup("allow-orgs", () => orgAllowlistFromArg(values["allow-orgs"]!, fileOpts)));

// Then the chain. Until the SDK registry has its addresses, it is "not deployed": one line, exit 2.
const chain = atStartup(() => requireDeployed(chainsFromEnv(process.env, [chainId])).chains[0]!);

function provider() {
  switch (values.provider) {
    case "local":
      return localPinningProvider({ endpoint: values.endpoint ?? "http://127.0.0.1:5001" });
    case "pinata":
      if (!apiKey) throw new Error("pinata needs the PINATA_JWT environment variable");
      return pinataPinningProvider({ apiKey, ...(values.endpoint ? { endpoint: values.endpoint } : {}) });
    default:
      throw new Error(`unknown provider "${values.provider}" — expected local or pinata`);
  }
}

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

// One cursor file per factory generation, ALWAYS keyed by the generation's hook (never by its position in
// the list: position changes the day a new factory ships, and an index-keyed file would follow it).
const cursorBase = values.cursor ?? `./abxfs-mirror.${chain.id}.json`;
const generations = orgGenerations(chain.contracts);
{
  const paths = generations.map((g) => cursorPathFor(cursorBase, g));
  if (new Set(paths).size !== paths.length) {
    log(`NOT STARTED: two generations would share one cursor file (${paths.join(", ")}); their hooks collide on the first 8 hex digits. Pass distinct --cursor paths per run.`);
    process.exit(2);
  }
}

let stats;
try {
  stats = await runMirrorGenerations({
    chain,
    provider: pinning,
    cursorFor: (generation) => fileCursor(cursorPathFor(cursorBase, generation), { hook: generation.projectHook }),
    ...(filters.length ? { filter: filters.length === 1 ? filters[0]! : allOf(...filters) } : {}),
    once: values.once,
    ...limits,
    pollMs,
    signal: controller.signal,
    log,
    // Only once every check has passed and a generation is about to run, so that a refusal is the only line it prints.
    onStart: () => {
      if (values["api-key"]) log("WARNING: --api-key puts a secret on the command line (shell history, `ps`). Set PINATA_JWT instead.");
    },
  });
} catch (err) {
  // Before any generation started: a generation with no lens, or no org layer at all.
  log(`NOT STARTED: ${(err as Error).message}`);
  process.exit(2);
}

log(`stopped: ${stats.pinned} pinned, ${stats.skipped} skipped, next index ${stats.next}`);
if (stats.failures.length > 0) {
  for (const f of stats.failures) log(`FAILED generation ${f.projectHook}: ${f.error}`);
  log(`${stats.failures.length} of ${stats.generations.length} generation(s) failed; the rest ran to completion`);
  process.exit(1);
}
