/**
 * Turning a deployment's environment into gateway chains.
 *
 * This is the only file that reads configuration, so everything else stays a pure function of its
 * arguments. Addresses come from the SDK's canonical registry — they are public deployment
 * artifacts, and the canonical ones are the only ones that produce interoperable CIDs — and the RPC
 * endpoint comes from the environment, because a keyed provider URL genuinely is a secret.
 */
import { isIP } from "node:net";

import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from "viem";
import * as viemChains from "viem/chains";
import {
  CANONICAL_DEPLOYMENTS,
  type CanonicalDeployment,
  type ContractAddresses,
} from "@abxfs/sdk";

import { chainCheckedFetch, strictBatchFetch } from "./upstream.js";
import type { GatewayChain } from "./types.js";

/**
 * Chain names → chain ids, derived from the registry by the same rule the CLI names its built-in chains
 * (`Base Sepolia` → `base-sepolia`, `Arbitrum One` → `arbitrum-one`), so one name means one chain in both
 * tools. Anything numeric is taken as an id.
 */
const SLUGS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.values(CANONICAL_DEPLOYMENTS).map((d) => [
      d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      d.chainId,
    ]),
  ),
);

/** The chain names {@link parseChainList} reads, for the messages that ask for one. */
export const CHAIN_NAMES = `${Object.keys(SLUGS).join(", ")}, or a chain id`;

export function parseChainList(raw: string | undefined): number[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const id = SLUGS[s.toLowerCase()] ?? Number(s);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`unknown chain "${s}"`);
      return id;
    });
}

/**
 * A setting that names ONE chain (`--default-chain` / `ABXFS_DEFAULT_CHAIN`, the mirror's `--chain`), read the same way
 * by the library and both bins. Blank is unset (`undefined`), unless `required`; a list, or a value that names no chain
 * (`,`), is refused, never read as its first chain or as none. `name` is the setting as the operator gave it.
 */
export function parseOneChain(raw: string | undefined, name: string, opts: { required?: boolean } = {}): number | undefined {
  let ids: number[] | undefined;
  try {
    ids = parseChainList(raw);
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ids === undefined && !opts.required) return undefined;
  if (ids?.length !== 1) throw new Error(`${name} expects one chain: ${CHAIN_NAMES} (got "${raw ?? ""}")`);
  return ids[0]!;
}

/**
 * viem's own chain definition when it knows one. A bare `defineChain` declares no `contracts`, so
 * viem has no multicall3 address and every batched read fails — which is exactly what happened to the
 * CLI on Base Sepolia, a chain that has multicall3 at the standard address.
 */
function viemChainFor(id: number, name: string, rpcUrl: string): Chain {
  const known = (Object.values(viemChains) as unknown as Chain[]).find(
    (c) => typeof c === "object" && c !== null && c.id === id,
  );
  if (known) return { ...known, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({
    id,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * The RPC for a chain: `ABXFS_RPC_URL_<id>`, else `ABXFS_RPC_URL`, else the registry's public
 * endpoints with failover. A public endpoint is rate limited and has a low `eth_call` gas cap —
 * resolving a 1 MB file costs ~72M gas, more than some will execute at all — so a gateway anyone
 * depends on should be given its own.
 */
export function gatewayChainFor(
  deployment: CanonicalDeployment,
  env: NodeJS.ProcessEnv = process.env,
): GatewayChain {
  const explicit = env[`ABXFS_RPC_URL_${deployment.chainId}`] ?? env["ABXFS_RPC_URL"];
  const urls = explicit ? [explicit] : [...deployment.publicRpc];
  // Bounded reads (viem's defaults are a 10s timeout and 3 retries per call): a hung RPC fails in about 8s, not 40.
  const opts = {
    timeout: 4_000,
    retryCount: 1,
    batch: true,
    fetchFn: chainCheckedFetch(deployment.chainId, strictBatchFetch()),
  } as const;
  const transport = urls.length === 1 ? http(urls[0]!, opts) : fallback(urls.map((u) => http(u, opts)));

  const client = createPublicClient({
    chain: viemChainFor(deployment.chainId, deployment.name, urls[0]!),
    transport,
  }) as PublicClient;

  return { id: deployment.chainId, name: deployment.name, contracts: deployment.addresses as ContractAddresses, client };
}

/** `--max-file-bytes` / `ABXFS_MAX_FILE_BYTES`: a positive whole number of bytes, at most 13 digits. */
export function parseMaxFileBytes(raw: string): number {
  if (!/^[1-9][0-9]{0,12}$/.test(raw)) throw new Error(`--max-file-bytes expects a positive integer (got "${raw}")`);
  return Number(raw);
}

/** `--root-max-age` / `ABXFS_ROOT_MAX_AGE`: a whole number of seconds (0 allowed), canonical spelling only. */
export function parseRootMaxAge(raw: string): number {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) throw new Error(`--root-max-age expects a whole number of seconds (got "${raw}")`);
  return Number(raw);
}

/** `--host` / `HOST`: the address to listen on, an IP address or a host name (`127.0.0.1`, `0.0.0.0`, `::`, `localhost`). */
export function parseListenHost(raw: string): string {
  const hostName = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  if (isIP(raw) !== 0 || hostName.test(raw)) return raw;
  throw new Error(`--host expects an IP address or a host name to listen on, such as 127.0.0.1, 0.0.0.0 or :: (got "${raw}")`);
}

/**
 * `--cors`: the `access-control-allow-origin` value, `*` or exactly ONE origin as a browser sends it (`https://app.example`,
 * no path and no trailing slash: anything else matches no request, so the setting would silently do nothing).
 */
export function parseCorsOrigin(raw: string): string {
  if (raw === "*") return raw;
  let origin: string | null = null;
  try {
    origin = new URL(raw).origin;
  } catch {
    origin = null;
  }
  if (origin !== null && origin !== "null" && origin === raw) return raw;
  throw new Error(`--cors expects "*" or one origin, such as https://app.example (got "${raw}")`);
}

/** `--base-path`: where path mode mounts, a path of plain segments (`/g`, `/abxfs/g`). */
export function parseBasePath(raw: string): string {
  if (/^(\/[A-Za-z0-9._~-]+)+\/?$/.test(raw)) return raw;
  throw new Error(`--base-path expects a path such as /g (got "${raw}")`);
}

/**
 * The loaded chains with a deployment, or a clear error. The registry lists every supported chain with no addresses
 * until a deployment there is verified (`packages/sdk/src/canonical.ts`), and a chain without them has nothing to
 * read: serving or mirroring it would fail on its first read. A chain that is not deployed is dropped with a note
 * (`onSkip`) while others are served; if none is left, this throws "not deployed" (and notes nothing: the one error says
 * it). The default chain moves to the first deployed one when its own is not.
 */
export function requireDeployed(loaded: LoadedChains, onSkip: (msg: string) => void = () => {}): LoadedChains {
  const deployed = loaded.chains.filter((c) => c.contracts !== undefined);
  if (deployed.length > 0) {
    for (const c of loaded.chains) {
      if (c.contracts === undefined) onSkip(`chain ${c.id} (${c.name}) is not deployed yet: the SDK registry has no addresses for it`);
    }
  }
  if (deployed.length === 0) {
    throw new Error(
      `not deployed: none of the requested chains (${loaded.chains.map((c) => c.id).join(", ")}) has ABX FS ` +
        "addresses in the SDK registry yet",
    );
  }
  const defaultChainId = deployed.some((c) => c.id === loaded.defaultChainId) ? loaded.defaultChainId : deployed[0]!.id;
  return { chains: deployed, defaultChainId };
}

export interface LoadedChains {
  chains: GatewayChain[];
  defaultChainId: number;
}

/**
 * Every canonical chain, or the ones named, in the order named. The default for bare `/cid/` requests (and the
 * chain a root host asks first) is the one named by `ABXFS_DEFAULT_CHAIN`, else the first chain served. No network
 * is preferred by name: which one an operator serves first is theirs to choose.
 */
export function chainsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  only?: number[],
  defaultChain?: number,
): LoadedChains {
  const deployments = only
    ? [...new Set(only)].flatMap((id) => CANONICAL_DEPLOYMENTS[id] ?? [])
    : Object.values(CANONICAL_DEPLOYMENTS);
  if (deployments.length === 0) {
    throw new Error("no chains to serve: none of the requested chains has a canonical deployment");
  }

  const chains = deployments.map((d) => gatewayChainFor(d, env));
  const requested = defaultChain ?? parseOneChain(env["ABXFS_DEFAULT_CHAIN"], "ABXFS_DEFAULT_CHAIN");
  const defaultChainId = requested ?? deployments[0]!.chainId;

  if (!chains.some((c) => c.id === defaultChainId)) {
    throw new Error(`default chain ${defaultChainId} is not among the chains being served`);
  }
  return { chains, defaultChainId };
}
