import type { PublicClient } from "viem";
import type { ContractAddresses } from "@abxfs/sdk";


/** One chain a gateway can read from: its contracts, and a client that reaches it. */
export interface GatewayChain {
  id: number;
  name?: string;
  contracts: ContractAddresses;
  client: PublicClient;
}

/**
 * What a filter decides about one request.
 *
 * `status` defaults to 451 (a policy refusal). A filter whose own state is unavailable answers 503
 * instead: "I cannot tell right now" is not "this is blocked", but it must not become "served" either.
 */
export type FilterDecision = { allow: true } | { allow: false; reason?: string; status?: 451 | 503 };

export interface FilterContext {
  /**
   * Everything the request names — a project, its org, or a root. A request is refused by a deny rule
   * if ANY of them matches. See `subjects.ts`.
   *
   * The handler calls the filter up to THREE times for one request: first with what the URL names (before
   * any chain read); for a project, again with the ROOT the project resolved to added; and again, once the
   * path is located, with the CID actually SERVED added (a file, or the directory being listed), when that is
   * not the root itself. So a filter MUST be idempotent and side-effect free, and must treat a `root:` subject
   * it sees on any request as it would on a root request. (A blocked file is therefore refused under every
   * directory, root host and project that serves it, not only at its own URL.)
   */
  subjects: string[];
  /** The HTTP request, when there is one. A mirror applies the same filter to ledger entries, which have none. */
  request?: Request;
}

/**
 * Your policy, as a function. Return `{ allow: false }` to refuse with 451.
 *
 * It runs before the chain is read, so a refused request costs nothing, and it sees only what the URL
 * names — never the content. Filtering by what the bytes are is a different job and not this one.
 * With no filter at all the gateway serves everything it can resolve, which is the protocol's own
 * position: anyone can write bytes, and the gateway is a reader.
 */
export type Filter = (ctx: FilterContext) => FilterDecision | Promise<FilterDecision>;

export interface GatewayOptions {
  /**
   * Send `access-control-allow-origin: <value>` (and expose the `x-abxfs-*` headers) on every response.
   * Off by default. Content is public and carries no credentials, so `*` is reasonable for a public
   * gateway; it lets a page read a project's host, which the app's own viewers need.
   */
  cors?: string;
  /** The chains to serve, or a lookup. A chain id not found is a 404. */
  chains: GatewayChain[] | ((chainId: number) => GatewayChain | undefined);
  /** The chain a root request resolves against first. A root CID carries none. */
  defaultChainId: number;
  /**
   * Host mode only. Other chains a raw-root host (`c-<root>.<base>`) may be looked up on when the default
   * does not store the root. Content is shared by every chain (the stores are CREATE2-deployed, so the CID
   * space is the same), and the bytes are verified against the root either way. Each is one cheap probe,
   * bounded by this list, and a chain that answers is remembered per root. Default: the default chain only.
   */
  rootChains?: number[];

  /*
   * Exactly ONE of the three addressing modes below must be chosen. There is no default: which
   * origin model a gateway runs is a security decision, and an unset one would silently be the worst.
   */

  /**
   * Serve per-project origins. The Host header names the content, as
   * `<chain>-<org>-<id>[-v<n>].<baseHost>` (a project) or `c-<root>.<baseHost>` (raw content by root),
   * and the request path is the path INSIDE it, so a website's own `/style.css` just works and one
   * project's code never shares an origin with another's. Strict, canonical parsing only; anything
   * else under `baseHost` is a 404. `baseHost` carries its port when it has one (`localhost:3001`).
   * This is what a production deployment should run.
   */
  hostMode?: { baseHost: string };
  /**
   * Serve ONE project at the root of the host, instead of the whole namespace. Every path is a path
   * inside the project. By default it follows `latest`; name a `tag` or `version` to pin it.
   */
  project?: { chainId: number; org: string; tokenId: bigint | number; tag?: string; version?: number };
  /**
   * The shared-origin `<basePath>/p/<chain>/<org>/<id>/…` and `<basePath>/cid/<root>/…` layout. UNSAFE for
   * content you do not trust: every project is served from ONE origin, so any project's script can
   * read, replace or impersonate every other's (localStorage, cookies, service workers). Use it only
   * for content you control, or behind a gateway you do not let people browse with credentials.
   */
  pathMode?: { basePath?: string };

  /** Refuse requests by policy. Default: none. Must be idempotent; see {@link FilterContext.subjects}. */
  filter?: Filter;
  /** The body of a 451. Default is a short, neutral sentence. */
  refusalMessage?: string;
  /** Extra headers on a 451 (the content origin sends `Clear-Site-Data` here). */
  refusalHeaders?: Record<string, string>;
  /**
   * Most bytes one file may be: stored bytes, and inflated bytes for a compressed one. Default 64 MiB.
   * A file past it is a 413, not a read that runs the process out of memory.
   */
  maxFileBytes?: number;
  /**
   * How long (seconds) a shared cache may hold a 404 for an address nothing lives at (an unknown org or
   * token). Default 30; 0 turns it off. Never applied to anything that can become true by publishing.
   */
  notFoundTtl?: number;
  /**
   * Seconds a root host's response for the ROOT ITSELF may be cached. Default: a year, `immutable`, which is right
   * only when the filter runs AHEAD of every cache that holds those responses (in middleware ahead of the CDN, say): an
   * immutable response a CDN or a browser already holds cannot be revoked by a block made later. A gateway behind a
   * CDN it cannot purge, whose filter runs only in this handler, should set a short value. Anything other than the
   * root itself (a directory root's `index.html`, a sub-path) is never immutable whatever this is. 0 sends
   * `no-cache`.
   */
  rootMaxAge?: number;
  /**
   * The most one request may take end to end, in milliseconds. Past it the answer is a retryable 503 with
   * `no-store` and `Retry-After`. Default 15000; 0 turns it off.
   */
  requestTimeoutMs?: number;
  /** Where unexpected failures are logged (with URLs scrubbed). Default `console.error`. */
  onError?: (detail: string) => void;
}
