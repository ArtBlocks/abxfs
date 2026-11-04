/**
 * Resource limits for anything that walks or inflates content read from a permissionless chain.
 *
 * Anyone can write a directory DAG that shares sub-directories (exponential blow-up when walked as a
 * tree), a file whose compressed bytes inflate ~88x (FastLZ) or far more (gzip), or content that makes
 * the resolver burn an entire `eth_call` budget. Clients cap all of it and say so clearly.
 */

/** Distinct nodes (directories + files) a single traversal may visit or emit. */
export const DEFAULT_MAX_NODES = 100_000;
/** Total bytes a single traversal may read. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
/** The most one file may inflate to. */
export const DEFAULT_MAX_INFLATE_BYTES = 256 * 1024 * 1024; // 256 MiB
/** Gas passed explicitly on resolver `eth_call`s, so a hostile tree cannot spend a node's whole cap. */
export const DEFAULT_RESOLVER_CALL_GAS = 30_000_000n;

/** How deeply directories may nest. An honest tree is a handful of levels; a hostile one is not. */
export const DEFAULT_MAX_DEPTH = 1000;

export interface TraversalLimits {
  /** Default {@link DEFAULT_MAX_NODES}. */
  maxNodes?: number;
  /** Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
}

export class LimitExceededError extends Error {
  /**
   * Which limit: `calls` is the `eth_call` budget of one chunk read (`read.ts`, `maxCalls`): the content may be fine,
   * but its backend, or the node, kept refusing calls.
   */
  readonly limit: "nodes" | "bytes" | "inflate" | "depth" | "calls";
  constructor(limit: "nodes" | "bytes" | "inflate" | "depth" | "calls", max: number, what?: string) {
    super(
      `${what ?? "content"} exceeds the client limit of ${max.toLocaleString("en-US")} ` +
        `${limit === "nodes" ? "nodes" : limit === "depth" ? "levels of nesting" : limit === "calls" ? "eth_calls" : "bytes"}` +
        (limit === "inflate" ? " when decompressed" : "") +
        "; refusing to continue. Raise the limit explicitly if this is expected.",
    );
    this.name = "LimitExceededError";
    this.limit = limit;
  }
}

/** Counts nodes and bytes against {@link TraversalLimits}; throws {@link LimitExceededError}. */
export class TraversalBudget {
  nodes = 0;
  bytes = 0;
  readonly maxNodes: number;
  readonly maxBytes: number;
  constructor(limits: TraversalLimits = {}) {
    this.maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  }
  node(): void {
    if (++this.nodes > this.maxNodes) throw new LimitExceededError("nodes", this.maxNodes, "tree");
  }
  addBytes(n: number): void {
    this.bytes += n;
    if (this.bytes > this.maxBytes) throw new LimitExceededError("bytes", this.maxBytes, "tree");
  }
}

/** A node in the chain of directories above the one being read (parent pointers: no copying). */
export interface Ancestry {
  key: string;
  parent: Ancestry | undefined;
  depth: number;
}

/**
 * Extend `parent` with the directory `key` about to be read. Throws when `key` is already above it (a
 * cycle: an honest chain cannot hold one, because a cid commits to its children, so the RPC is lying) and
 * when nesting exceeds {@link DEFAULT_MAX_DEPTH}. Checking costs O(depth), bounded by that cap.
 */
export function descend(parent: Ancestry | undefined, key: string, what = "directory"): Ancestry {
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > DEFAULT_MAX_DEPTH) throw new LimitExceededError("depth", DEFAULT_MAX_DEPTH, what);
  for (let a = parent; a; a = a.parent) {
    if (a.key === key) throw new Error(`directory cycle: ${key} lists itself as a descendant (the RPC is lying)`);
  }
  return { key, parent, depth };
}
