/**
 * Chain & contract-address configuration for the ABX FS CLI.
 *
 * Any EVM chain is permitted. ABX FS content contracts are permissionless and chain-agnostic;
 * project identity lives in an ABX collection (an org) on the same chain (see
 * `specs/abx-fs-orgs.md`).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import kleur from "kleur";
import type { Address, Hex } from "viem";
import { codecFromName } from "./codec.js";
import { redactUrl } from "./redact.js";
import { safe } from "./text.js";
import {
  CANONICAL_DEPLOYMENTS,
  resolveCanonicalDeployment,
  type ContractAddresses,
} from "@abxfs/sdk";

/** File layout: `{ chains: { <name>: ChainConfig } }` plus an optional `defaultChain`. */
export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  /**
   * Additional endpoints to try when `rpcUrl` fails, in order.
   *
   * Not load balancing — failover. Prompted by `sepolia.base.org` returning 503 "no backend is
   * currently healthy" mid-session, which with a single hardcoded endpoint made the zero-config path
   * simply not work. A first-time user cannot tell that apart from "this tool is broken".
   *
   * Left empty when the user supplies their own `rpcUrl`: silently falling back to a public endpoint
   * they did not choose would leak their reads somewhere unexpected.
   */
  fallbackRpcUrls?: string[];
  /**
   * Deployed contract addresses.
   *
   * Optional in a config *file* when `chainId` has a canonical deployment — the canonical addresses
   * are filled in on load. Required for any other chain, including a local anvil. Absent for a
   * canonical chain ABX FS has not been deployed to yet: such a chain loads (so a config naming
   * it is not an error) and every command on it says so ({@link requireAddresses}).
   */
  addresses?: ContractAddresses;
  /**
   * The org project commands act on by default for this chain. Overridden by `--org` or `ABXFS_ORG`.
   * Projects live in orgs and token ids repeat across them, so a command that names a project
   * needs one.
   */
  org?: Address;
  /**
   * Default file codec for `abxfs upload` / `update` / `diff` when `--codec` is not passed: `gzip`
   * or `none` (the default).
   *
   * A file codec is decoded OFF chain by readers, so it compresses best but leaves the chain holding
   * encoded bytes. Without one, each chunk still goes through the FastLZ backend wherever FastLZ
   * shrinks it, and the chain inflates it itself (see {@link fastLz}).
   *
   * This value is part of every file's CID, so it must match what a later `abxfs diff` uses, or the
   * diff recomputes every CID under the wrong codec and reports unchanged files as changed.
   */
  defaultCodec?: string;
  /**
   * Whether chunks go through the FastLZ backend where it shrinks them (default true). Also part of
   * every chunk id, so it must match between an upload and a later diff.
   */
  fastLz?: boolean;
  /**
   * Default per-bundle gas ceiling for `multicall(bytes[])` upload bundles, in raw gas units, counted as the chain's
   * per-transaction cap counts it (all gas; only execution gas under EIP-8037, where state gas rides on top).
   * Overridable per command via `--max-bundle-gas`. When unset, the SDK uses 12,000,000; any value is
   * clamped below the 2^24 per-transaction cap. Set lower if your local chain has tighter
   * block limits or you want smaller, faster-finalizing bundles. A positive whole number.
   */
  defaultBundleGasBudget?: number;
}

export interface CliConfig {
  defaultChain?: string;
  chains: Record<string, ChainConfig>;
}

/** A config file may omit `addresses` for a chain the SDK has canonical addresses for. */
type ChainConfigInput = Omit<ChainConfig, "addresses"> & {
  addresses?: Partial<ContractAddresses>;
};
interface CliConfigInput {
  defaultChain?: string;
  chains?: Record<string, ChainConfigInput>;
}

/** The keys a chain entry may carry. Anything else is reported and dropped. */
const CHAIN_KEYS = new Set([
  "chainId",
  "rpcUrl",
  "fallbackRpcUrls",
  "addresses",
  "org",
  "defaultCodec",
  "fastLz",
  "defaultBundleGasBudget",
]);
/** The keys a config file may carry at its top level (`$schema` is an editor hint, accepted silently). */
const TOP_KEYS = new Set(["defaultChain", "chains", "$schema"]);
/** Address-book keys whose value is one address. `previousGenerations` is checked separately. */
const ADDRESS_KEYS = new Set([
  "chunkStore",
  "fileStore",
  "directoryStore",
  "sstore2Backend",
  "fastLzBackend",
  "orgFactory",
  "orgMinter",
  "orgMeta",
  "lens",
  "projectHook",
  "projectEnumeration",
  "ipfsCidResolver",
]);
const GENERATION_KEYS = new Set(["orgFactory", "projectHook", "fileStore", "directoryStore", "orgMinter", "projectEnumeration", "lens"]);

/** A key that names a credential. None belongs in a config file: the key is read from `ABXFS_PRIVATE_KEY` only. */
const SECRET_KEY_NAME = /private.?key|secret|mnemonic|seed.?phrase|passphrase|password|api.?key|jwt|access.?token|auth.?token/i;

/** The largest config file the CLI reads. A real one is a few hundred bytes. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Chains the CLI knows without any config file, derived from the SDK's canonical registry.
 *
 * This is the difference between "install the CLI and upload something" and "install the CLI, find
 * nine contract addresses, hand-write a JSON file, then upload something." Since the addresses are
 * public deployment artifacts and the canonical ones are the *only* addresses that produce
 * interoperable CIDs, requiring a consumer to supply them was asking them to re-enter a constant
 * with a silent failure mode for getting it wrong.
 *
 * The RPC endpoint is the one thing genuinely worth overriding: these defaults are unkeyed public
 * endpoints, fine for a first upload and rate-limited for anything sustained. `ABXFS_RPC_URL_<chainId>`
 * takes precedence for that chain, and `ABXFS_RPC_URL` for the one chain a command selects (see
 * {@link resolveChain}), so pointing at a keyed provider needs no config file either.
 */
export const BUILTIN_CHAINS: Readonly<Record<string, ChainConfig>> = Object.freeze(
  Object.fromEntries(
    Object.values(CANONICAL_DEPLOYMENTS).map((d) => [
      slugify(d.name),
      Object.freeze({
        chainId: d.chainId,
        // Ordered by `eth_call` gas cap, which is the only axis that matters: every read is an
        // `eth_call`, and resolving a file can cost >70M gas.
        rpcUrl: d.publicRpc[0]!,
        fallbackRpcUrls: d.publicRpc.slice(1),
        ...(d.addresses ? { addresses: d.addresses } : {}),
      }) satisfies ChainConfig,
    ]),
  ),
);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Chains whose endpoint is still the built-in public one: nothing (no config file, no `ABXFS_RPC_URL_<chainId>`)
 * chose it. Only these take the unsuffixed `ABXFS_RPC_URL`, and only when selected.
 */
const builtinRpc = new WeakSet<ChainConfig>();

/**
 * Chains a config file names with no endpoint at all (no `rpcUrl`, no `ABXFS_RPC_URL_<chainId>`, no built-in one), and
 * the refusal to give when one is SELECTED. Loaded rather than refused, so one such entry does not stop every command
 * on every other chain.
 */
const missingRpc = new WeakMap<ChainConfig, string>();

/** `ABXFS_RPC_URL_<chainId>`: the endpoint for that one chain, whatever the config says. */
function chainRpcOverride(chainId: number): string | undefined {
  const v = process.env[`ABXFS_RPC_URL_${chainId}`];
  if (v === undefined || v === "") return undefined;
  assertRpcUrl(`ABXFS_RPC_URL_${chainId}`, v);
  return v;
}

function assertRpcUrl(what: string, v: unknown): asserts v is string {
  let ok = false;
  if (typeof v === "string") {
    try {
      const u = new URL(v);
      ok = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      ok = false;
    }
  }
  // The value itself is never echoed: an RPC URL usually carries an API key.
  if (!ok) throw new Error(`${what} must be an http(s) URL`);
}

interface ConfigSource {
  path: string;
  /**
   * `ABXFS_CONFIG` and the home config are the user's own, set deliberately. A `.abxfs.json` in the
   * working directory is whatever the directory you happen to be standing in says — a cloned repo can
   * ship one — so it is NOT trusted to redirect contract addresses.
   */
  trusted: boolean;
}

/**
 * The config files in LAYERING order: the home config is the BASE, `ABXFS_CONFIG` (also trusted) goes
 * over it, and a `./.abxfs.json` is a vetted overlay on top. Previously the first file that existed
 * won outright, so a cloned repo's `.abxfs.json` silently shadowed the user's own keyed RPC and org.
 */
function defaultConfigPaths(): ConfigSource[] {
  const out: ConfigSource[] = [];
  out.push({ path: resolve(homedir(), ".config/abxfs/config.json"), trusted: true });
  const explicit = process.env["ABXFS_CONFIG"] ? resolve(process.env["ABXFS_CONFIG"]) : undefined;
  if (explicit) out.push({ path: explicit, trusted: true });
  const cwdFile = resolve(process.cwd(), ".abxfs.json");
  if (cwdFile !== explicit) out.push({ path: cwdFile, trusted: false });
  return out;
}

let allowOverridesFlag = false;
/** Set by the global `--allow-config-overrides` flag. */
export function setAllowConfigOverrides(v: boolean): void {
  allowOverridesFlag = v;
}
function overridesAllowed(): boolean {
  return allowOverridesFlag || process.env["ABXFS_ALLOW_CONFIG_OVERRIDES"] === "1";
}

/** Keys that would set a prototype instead of a property when used as a map key. */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The one way config code prints. Every part goes through `safe()`: chain names, keys, values and the path of a
 * file in the current directory are all text a cloned repository chose, and printed raw an escape sequence in
 * them can rewrite the screen or set the clipboard.
 */
function warn(...parts: unknown[]): void {
  console.error(kleur.yellow(parts.map((p) => safe(p)).join(" ")));
}

function loudWarning(file: string, lines: string[], applied: boolean): void {
  const bar = "!".repeat(72);
  console.error(kleur.red(bar));
  console.error(
    kleur.red(
      `WARNING: ${safe(file)} (in the current directory, not a trusted config) ${applied ? "overrides" : "tries to override"} security-relevant settings:`,
    ),
  );
  for (const k of lines) console.error(kleur.red(`   - ${safe(k)}`));
  console.error(
    applied
      ? kleur.yellow("  Applying them because --allow-config-overrides / ABXFS_ALLOW_CONFIG_OVERRIDES=1 is set.")
      : kleur.yellow(
          "  IGNORED. Built-in canonical settings are used. Put them in ABXFS_CONFIG or ~/.config/abxfs/config.json,\n" +
            "  or pass --allow-config-overrides (or ABXFS_ALLOW_CONFIG_OVERRIDES=1), if you really mean it.",
        ),
  );
  console.error(kleur.red(bar));
}

/**
 * Vet a chain entry from an untrusted (working-directory) config.
 *
 * A cloned repo can ship a `.abxfs.json`, so nothing in it may steer where a signed transaction goes
 * or what it costs. Without the opt-in, from such a file ONLY an entry for a chain the CLI already
 * knows (a built-in canonical chain) is read, and from that entry only keys that cannot redirect
 * anything: canonical addresses restated as-is. Everything else is dropped, with a warning that names
 * each key:
 *
 *   - `rpcUrl` / `fallbackRpcUrls` (the node sees every read and chooses every fee quote),
 *   - `addresses` that differ from canonical, a `chainId` that differs from the built-in's,
 *   - `org` (which org a project command acts on) and the upload tunables (`defaultBundleGasBudget`,
 *     `defaultCodec`, `fastLz`),
 *   - whole entries for a chain name the CLI does not know, whatever their chainId (this is how a
 *     file could otherwise select chainId 1, or a chain with no canonical deployment, with attacker
 *     addresses).
 *
 * Returns `null` when the whole entry is dropped.
 */
function vetUntrusted(
  name: string,
  entry: ChainConfigInput,
  existing: ChainConfig | undefined,
  file: string,
): ChainConfigInput | null {
  const allowed = overridesAllowed();
  const ignored: string[] = [];
  if (!existing) {
    ignored.push(`chains.${name} (a chain this CLI has no canonical deployment under that name; chainId ${String(entry.chainId)})`);
    if (!allowed) {
      loudWarning(file, ignored, false);
      return null;
    }
    loudWarning(file, ignored, true);
    return entry;
  }

  const canonical = resolveCanonicalDeployment(existing.chainId)?.addresses as unknown as Record<string, unknown> | undefined;
  const out: ChainConfigInput = { ...entry };
  const drop = (k: keyof ChainConfigInput | string, label?: string) => {
    if ((entry as Record<string, unknown>)[k] === undefined) return;
    ignored.push(label ?? `chains.${name}.${k}`);
    if (!allowed) delete (out as Record<string, unknown>)[k];
  };

  drop("rpcUrl");
  drop("fallbackRpcUrls");
  drop("org");
  drop("defaultBundleGasBudget");
  drop("defaultCodec");
  drop("fastLz");
  if (entry.chainId !== undefined && entry.chainId !== existing.chainId) drop("chainId");

  const addresses: Partial<ContractAddresses> = { ...(entry.addresses ?? {}) };
  for (const [k, v] of Object.entries(entry.addresses ?? {})) {
    const c = canonical?.[k];
    if (typeof v !== "string" || typeof c !== "string" || v.toLowerCase() !== c.toLowerCase()) {
      ignored.push(`chains.${name}.addresses.${k}`);
      if (!allowed) delete (addresses as Record<string, unknown>)[k];
    }
  }
  out.addresses = addresses;

  if (ignored.length > 0) loudWarning(file, ignored, allowed);
  return out;
}

/** A file that is skipped (never an error), with the reason printed. Only for the untrusted working-directory file. */
class SkipConfig extends Error {}

function kindOf(st: Stats): string {
  if (st.isDirectory()) return "a directory";
  if (st.isSymbolicLink()) return "a symlink";
  if (st.isFIFO()) return "a FIFO";
  if (st.isSocket()) return "a socket";
  if (st.isCharacterDevice() || st.isBlockDevice()) return "a device";
  return "not a regular file";
}

/** Read at most `max` bytes from `fd`; more than that is a refusal, so a huge or endless input is never held. */
function readCapped(fd: number, max: number, file: string, Err: new (m: string) => Error): string {
  const buf = Buffer.alloc(max + 1);
  let total = 0;
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, buf, total, buf.length - total, null);
    } catch (e) {
      // O_NONBLOCK on something that is not a regular file (only reachable in a race): no data is not a config.
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") throw new Err("not a regular file");
      throw e;
    }
    if (n === 0) break;
    total += n;
    if (total > max) throw new Err(`${safe(file)} is larger than ${max / 1024} KiB, which no config file needs`);
  }
  return buf.subarray(0, total).toString("utf8");
}

/**
 * The text of one config file, or `null` when there is none.
 *
 * The working-directory file is checked with `lstat` and must be a regular file of at most
 * {@link MAX_CONFIG_BYTES}: a FIFO named `.abxfs.json` used to hang every command in that directory, a symlink could
 * point it at `/dev/zero` or another user's file, and a huge one was read whole. It is then opened with `O_NOFOLLOW`
 * and `O_NONBLOCK` (so a swap between the check and the open can neither follow a link nor block) and checked again
 * with `fstat`. Anything else is skipped with a warning.
 *
 * Your own files (`ABXFS_CONFIG`, the home config) may be symlinks or pipes (`ABXFS_CONFIG=<(…)`), and are read up to
 * the same size; over it, or a directory, is an error, as any broken config you chose is.
 */
function readConfigFile(src: ConfigSource): string | null {
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const nonblock = constants.O_NONBLOCK ?? 0;
  if (src.trusted) {
    let st: Stats;
    try {
      st = statSync(src.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (st.isDirectory()) throw new Error(`Refusing to load ${safe(src.path)}: it is a directory, not a config file.`);
    if (st.isFile() && st.size > MAX_CONFIG_BYTES) {
      throw new Error(`Refusing to load ${safe(src.path)}: it is larger than ${MAX_CONFIG_BYTES / 1024} KiB, which no config file needs.`);
    }
    const fd = openSync(src.path, constants.O_RDONLY);
    try {
      return readCapped(fd, MAX_CONFIG_BYTES, src.path, Error);
    } finally {
      closeSync(fd);
    }
  }

  let st: Stats;
  try {
    st = lstatSync(src.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw new SkipConfig((e as Error).message);
  }
  if (!st.isFile()) throw new SkipConfig(`it is ${kindOf(st)}, and only a regular file is read from the current directory`);
  if (st.size > MAX_CONFIG_BYTES) throw new SkipConfig(`it is larger than ${MAX_CONFIG_BYTES / 1024} KiB, which no config file needs`);
  let fd: number;
  try {
    fd = openSync(src.path, constants.O_RDONLY | nofollow | nonblock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new SkipConfig("it became a symlink while it was being read");
    throw new SkipConfig((e as Error).message);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) throw new SkipConfig("it changed while it was being read");
    return readCapped(fd, MAX_CONFIG_BYTES, src.path, SkipConfig);
  } finally {
    closeSync(fd);
  }
}

/**
 * Load the effective config: built-in canonical chains, overlaid with a config file if one exists.
 *
 * Precedence, narrowest first:
 *   1. `BUILTIN_CHAINS` — every chain with a canonical deployment.
 *   2. Config files, layered: `~/.config/abxfs/config.json` (base), then `ABXFS_CONFIG`, then a
 *      `./.abxfs.json` overlay. Entries merge field-by-field over the builtin. The cwd file is
 *      untrusted: it cannot override addresses, RPC or `org` without opt-in, and a malformed one is
 *      ignored with a warning.
 *   3. `ABXFS_RPC_URL_<chainId>` for that chain's endpoint. (`ABXFS_RPC_URL` is applied later, by
 *      {@link resolveChain}, to the one chain a command selects.)
 */
export function loadConfig(): CliConfig {
  // Builtins get the env override applied here, not only in `mergeChain`. Doing it there alone meant
  // `ABXFS_RPC_URL_*` was silently ignored whenever there was no config file — i.e. in exactly the
  // zero-config case the builtins exist to serve.
  const chains: Record<string, ChainConfig> = {};
  for (const [name, builtin] of Object.entries(BUILTIN_CHAINS)) {
    const override = chainRpcOverride(builtin.chainId);
    if (override) {
      chains[name] = { ...builtin, rpcUrl: override, fallbackRpcUrls: [] };
    } else {
      chains[name] = { ...builtin };
      builtinRpc.add(chains[name]);
    }
  }

  let defaultChain: string | undefined;
  for (const src of defaultConfigPaths()) {
    let parsed: CliConfigInput;
    try {
      const text = readConfigFile(src);
      if (text === null) continue;
      parsed = JSON.parse(text) as CliConfigInput;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Refusing to load ${safe(src.path)}: expected a JSON object.`);
      }
      validateConfig(parsed, src.path);
    } catch (e) {
      // A config the user chose and broke is an error. A `.abxfs.json` in whatever directory they are
      // standing in is not theirs: a cloned repo could otherwise abort every command by shipping a
      // malformed one (or a directory, a FIFO, a link to /dev/zero with that name), so it is reported and skipped.
      if (src.trusted && !(e instanceof SkipConfig)) throw e;
      warn(`warning: ignoring ${src.path} (in the current directory): ${(e as Error).message.split("\n")[0]}`);
      continue;
    }

    for (const [name, rawEntry] of Object.entries(parsed.chains ?? {})) {
      const known = pickKnown(rawEntry);
      const entry = src.trusted ? known : vetUntrusted(name, known, Object.hasOwn(chains, name) ? chains[name] : undefined, src.path);
      if (entry === null) continue;
      chains[name] = mergeChain(name, entry, Object.hasOwn(chains, name) ? chains[name] : undefined);
    }
    let dc = parsed.defaultChain;
    if (dc && !src.trusted && !overridesAllowed()) {
      loudWarning(src.path, [`defaultChain ("${dc}")`], false);
      dc = undefined;
    }
    if (dc) defaultChain = dc;
  }

  return { ...(defaultChain ? { defaultChain } : {}), chains };
}

/** Only the keys a chain entry may carry: unknown ones were reported by {@link validateConfig} and go no further. */
function pickKnown(entry: ChainConfigInput): ChainConfigInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) if (CHAIN_KEYS.has(k)) out[k] = v;
  if (isPlainObject(out["addresses"])) {
    const addresses: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out["addresses"])) {
      if (ADDRESS_KEYS.has(k) || k === "previousGenerations") addresses[k] = v;
    }
    out["addresses"] = addresses;
  }
  return out as unknown as ChainConfigInput;
}

/**
 * Merge a file entry over a builtin (or stand it up alone).
 *
 * Addresses come from the canonical registry when the file omits them, which is what lets a config
 * name a chain without re-entering nine constants. A partial `addresses` block is merged over
 * canonical rather than replacing it — overriding one contract for testing should not blank the rest.
 */
function mergeChain(
  name: string,
  entry: ChainConfigInput,
  builtin: ChainConfig | undefined,
): ChainConfig {
  const chainId = entry.chainId ?? builtin?.chainId;
  if (chainId === undefined) {
    throw new Error(`Refusing to load chain "${safe(name)}": chainId is required.`);
  }

  const canonical = resolveCanonicalDeployment(chainId)?.addresses;
  const base = entry.addresses ?? {};
  const merged = { ...canonical, ...builtin?.addresses, ...base } as Partial<ContractAddresses>;
  const missing = CONTENT_KEYS.filter((k) => !merged[k]);

  // A chain the registry lists but ABX FS has not reached yet loads WITHOUT addresses when the file names
  // none either, so a config that sets its RPC or org is not an error; commands on it then say why
  // they cannot run. A partial address block, or a chain the registry has never heard of, is refused.
  let addresses: ContractAddresses | undefined;
  if (missing.length === 0) addresses = merged as ContractAddresses;
  else if (!(resolveCanonicalDeployment(chainId) && Object.keys(merged).length === 0)) {
    throw new Error(
      `Refusing to load chain "${safe(name)}": chain ${chainId} has no canonical ABX FS deployment, so ` +
        `\`addresses\` must include ${CONTENT_KEYS.join(", ")} (missing: ${missing.join(", ")}). ` +
        "Run `abxfs dev` for a local chain — it prints a ready-made config.",
    );
  }

  const explicitRpc = chainRpcOverride(chainId) ?? entry.rpcUrl;
  const rpcUrl = explicitRpc ?? builtin?.rpcUrl;
  // A user-chosen endpoint keeps no public fallbacks — failing over to a node they did not pick
  // would send their reads somewhere they never agreed to.
  const fallbackRpcUrls = explicitRpc ? [] : (builtin?.fallbackRpcUrls ?? []);

  const out: ChainConfig = { ...builtin, ...entry, chainId, rpcUrl: rpcUrl ?? "", fallbackRpcUrls } as ChainConfig;
  if (addresses) out.addresses = addresses;
  else delete out.addresses;
  // No endpoint: refused when a command selects this chain (`resolveChain`), not here, where it would stop every
  // command on every chain. The unsuffixed ABXFS_RPC_URL is not taken for it: that one is for a chain whose endpoint
  // is the built-in public one, and this chain has none.
  if (!rpcUrl) {
    missingRpc.set(out, `Refusing to use chain "${safe(name)}": rpcUrl is required (or set ABXFS_RPC_URL_${chainId}).`);
  }
  // Still the built-in public endpoint only when neither the file nor the environment chose one.
  if (!explicitRpc && builtin && builtinRpc.has(builtin)) builtinRpc.add(out);
  return out;
}

/** The content-layer addresses every chain entry needs before anything can be read from it. */
const CONTENT_KEYS = ["chunkStore", "fileStore", "directoryStore", "sstore2Backend", "fastLzBackend"] as const satisfies readonly (keyof ContractAddresses)[];

/**
 * A chain's addresses, or a refusal that says why there are none: the chain is one ABX FS supports
 * but has not been deployed to yet.
 */
export function requireAddresses(chain: ChainConfig): ContractAddresses {
  if (chain.addresses) return chain.addresses;
  throw new Error(
    `ABX FS is not deployed on chain ${chain.chainId} yet, so there is nothing to read or write there. ` +
      "Pass `addresses` for it in your config (or run `abxfs dev` for a local chain).",
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Report (never print the value of) every key, at any depth, that names a credential. */
function warnSecretKeys(v: unknown, path: string, file: string, depth = 0): void {
  if (depth > 6 || v === null || typeof v !== "object") return;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (SECRET_KEY_NAME.test(k)) {
      const bar = "!".repeat(72);
      console.error(kleur.red(bar));
      console.error(kleur.red(`WARNING: ${safe(file)} has a key named "${safe(p)}". A config file must never hold a key or a secret.`));
      console.error(
        kleur.red(
          "  It is IGNORED: the CLI reads a private key from ABXFS_PRIVATE_KEY only, and nothing secret from any file. " +
            "Remove it, and treat the value as exposed if this file was ever shared or committed.",
        ),
      );
      console.error(kleur.red(bar));
    }
    warnSecretKeys(child, p, file, depth + 1);
  }
}

/**
 * Check a parsed config before any of it is used: types and shapes are refused with an error (which makes an
 * untrusted file skipped and a trusted one fatal); unknown keys are reported and later dropped; a key that names a
 * credential is reported loudly. Every name in every message is passed through `safe()`.
 */
export function validateConfig(cfg: CliConfigInput, file = "config"): void {
  warnSecretKeys(cfg, "", file);
  for (const k of Object.keys(cfg)) {
    if (!TOP_KEYS.has(k) && !SECRET_KEY_NAME.test(k)) warn(`warning: ${file}: unknown key "${k}" (ignored)`);
  }
  if (cfg.defaultChain !== undefined && typeof cfg.defaultChain !== "string") {
    throw new Error("Refusing to load config: defaultChain must be a string.");
  }
  if (cfg.chains !== undefined && !isPlainObject(cfg.chains)) {
    throw new Error("Refusing to load config: chains must be an object of chain entries.");
  }
  for (const k of Object.keys(cfg.chains ?? {})) {
    if (POISON_KEYS.has(k)) throw new Error(`Refusing to load config: "${safe(k)}" is not a valid chain name.`);
  }
  for (const [name, chain] of Object.entries(cfg.chains ?? {})) {
    const at = `Refusing to load chain "${safe(name)}":`;
    if (!isPlainObject(chain)) throw new Error(`${at} its entry must be an object.`);
    for (const k of Object.keys(chain)) {
      if (!CHAIN_KEYS.has(k) && !SECRET_KEY_NAME.test(k)) warn(`warning: ${file}: unknown key "chains.${name}.${k}" (ignored)`);
    }
    if (chain.chainId !== undefined && (!Number.isSafeInteger(chain.chainId) || chain.chainId <= 0)) {
      throw new Error(`${at} chainId must be a positive integer.`);
    }
    if (chain.rpcUrl !== undefined) assertRpcUrl(`${at} rpcUrl`, chain.rpcUrl);
    if (chain.fallbackRpcUrls !== undefined) {
      if (!Array.isArray(chain.fallbackRpcUrls)) throw new Error(`${at} fallbackRpcUrls must be an array of http(s) URLs.`);
      chain.fallbackRpcUrls.forEach((u, i) => assertRpcUrl(`${at} fallbackRpcUrls[${i}]`, u));
    }
    if (chain.org !== undefined && (typeof chain.org !== "string" || !isAddress(chain.org))) {
      throw new Error(`${at} org must be an address (0x followed by 40 hex digits).`);
    }
    if (chain.defaultCodec !== undefined) codecFromName(String(chain.defaultCodec));
    if (chain.fastLz !== undefined && typeof chain.fastLz !== "boolean") {
      throw new Error(`${at} fastLz must be true or false.`);
    }
    if (
      chain.defaultBundleGasBudget !== undefined &&
      !(typeof chain.defaultBundleGasBudget === "number" && /^[1-9]\d*$/.test(String(chain.defaultBundleGasBudget)) && Number.isSafeInteger(chain.defaultBundleGasBudget))
    ) {
      throw new Error(`${at} defaultBundleGasBudget must be a positive whole number of gas, such as 12000000.`);
    }
    if (chain.addresses !== undefined) {
      if (!isPlainObject(chain.addresses)) throw new Error(`${at} addresses must be an object.`);
      for (const [k, v] of Object.entries(chain.addresses)) {
        if (k === "previousGenerations") {
          if (!Array.isArray(v) || !v.every(isPlainObject)) throw new Error(`${at} addresses.previousGenerations must be an array of objects.`);
          v.forEach((g, i) => {
            for (const [gk, gv] of Object.entries(g as unknown as Record<string, unknown>)) {
              if (!GENERATION_KEYS.has(gk)) warn(`warning: ${file}: unknown key "chains.${name}.addresses.previousGenerations[${i}].${gk}"`);
              else if (typeof gv !== "string" || !isAddress(gv)) throw new Error(`${at} addresses.previousGenerations[${i}].${safe(gk)} must be an address.`);
            }
          });
        } else if (!ADDRESS_KEYS.has(k)) {
          warn(`warning: ${file}: unknown key "chains.${name}.addresses.${k}" (ignored)`);
        } else if (typeof v !== "string" || !isAddress(v)) {
          throw new Error(`${at} addresses.${safe(k)} must be an address (0x followed by 40 hex digits).`);
        }
      }
    }
  }
}

/**
 * Resolve the chain by name (`--chain`), else `ABXFS_CHAIN`, else `defaultChain`, else the single configured chain.
 *
 * There is no built-in default: every canonical network is configured, production ones included, so a
 * command that names none is refused rather than sent to one the caller did not choose. A name that does
 * not match is likely a typo: the error lists what is available instead of only saying no.
 *
 * The unsuffixed `ABXFS_RPC_URL` is applied here, to the selected chain only, and only when its endpoint is still
 * the built-in public one. It once overrode EVERY chain's endpoint, so one variable meant for Base Sepolia
 * silently pointed `--chain ethereum` at a Base Sepolia node too (and, with viem adopting the node's chain id, a
 * write could be signed for the wrong chain). A chain whose `rpcUrl` you configured, or set with
 * `ABXFS_RPC_URL_<chainId>`, keeps it. Which chain it applied to is printed.
 */
export function resolveChain(cfg: CliConfig, name?: string): ChainConfig {
  const names = Object.keys(cfg.chains);
  const fromEnv = process.env["ABXFS_CHAIN"]?.trim() || undefined;
  const key = name ?? fromEnv ?? cfg.defaultChain ?? (names.length === 1 ? names[0] : undefined);

  if (!key) {
    throw new Error(
      names.length === 0
        ? "no chain configured (see `abxfs --help` and https://docs.fs.abx.io/docs/using-abxfs/quickstart)"
        : `no network chosen — pass --chain <name>, set ABXFS_CHAIN, or set defaultChain in ~/.config/abxfs/config.json. Available: ${names.map(safe).join(", ")}.`,
    );
  }

  // Own keys only: `--chain constructor` or `--chain toString` must not find Object.prototype's members.
  const c = Object.hasOwn(cfg.chains, key) ? cfg.chains[key] : undefined;
  if (!c) {
    throw new Error(`unknown chain "${safe(key)}". Available: ${names.map(safe).join(", ") || "(none)"}.`);
  }
  const noEndpoint = missingRpc.get(c);
  if (noEndpoint !== undefined) throw new Error(noEndpoint);

  const global = process.env["ABXFS_RPC_URL"];
  if (global !== undefined && global !== "") {
    if (!builtinRpc.has(c)) {
      warn(`note: ABXFS_RPC_URL is not used for ${key} (chain ${c.chainId}): its endpoint is configured (a config file's rpcUrl or ABXFS_RPC_URL_${c.chainId}).`);
      return c;
    }
    assertRpcUrl("ABXFS_RPC_URL", global);
    warn(`note: ABXFS_RPC_URL applies to the selected chain only: ${key} (chain ${c.chainId}), via ${redactUrl(global)}. Use ABXFS_RPC_URL_<chainId> to set one per chain.`);
    return { ...c, rpcUrl: global, fallbackRpcUrls: [] };
  }
  return c;
}

/** Read the `ABXFS_PRIVATE_KEY` env — and ONLY that one; a generic `PRIVATE_KEY` is never read. Returns undefined when not set. */
export function getPrivateKey(): Hex | undefined {
  const pk = process.env["ABXFS_PRIVATE_KEY"];
  if (!pk) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("ABXFS_PRIVATE_KEY must be 0x-prefixed 32 bytes");
  return pk as Hex;
}

/** Convenience check. */
export function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * The org a project command acts on: `--org`, then `ABXFS_ORG`, then the chain's `org` in config.
 * `undefined` when none is set — {@link requireOrg} turns that into a message that says what to do.
 */
export function resolveOrg(chain: ChainConfig, flag?: string): Address | undefined {
  const raw = flag ?? process.env["ABXFS_ORG"] ?? chain.org;
  if (!raw) return undefined;
  if (!isAddress(raw)) throw new Error(`not a valid org address: ${safe(raw)}`);
  return raw;
}

export function requireOrg(chain: ChainConfig, flag?: string): Address {
  const org = resolveOrg(chain, flag);
  if (org) return org;
  throw new Error(
    "no org specified — projects live in orgs. Pass --org <address>, set ABXFS_ORG, or set `org` for the chain " +
      "in ~/.config/abxfs/config.json. `abxfs org list` shows yours; `abxfs org create <name>` makes one. " +
      (chain.addresses?.orgFactory
        ? ""
        : "(This chain has no org factory deployed: choose a network that has one.)"),
  );
}
