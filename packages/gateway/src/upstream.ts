/**
 * Telling "the chain said no" apart from "the chain could not be asked".
 *
 * The distinction is the whole point of this file. A read that REVERTED is a definitive answer
 * (the token is not minted, the factory does not know the org) and may be remembered. A read that failed
 * for any other reason (a 429, a timeout, a 5xx, an aborted fetch, a replica that dropped the call) says
 * nothing about the chain, and must never be remembered as "does not exist": it would turn a rate-limited
 * RPC into a 404 held by this process and by every shared cache in front of it.
 *
 * viem wraps every failure in a chain of causes (`ContractFunctionExecutionError` > `CallExecutionError` >
 * `ExecutionRevertedError` / `HttpRequestError` / `TimeoutError` ...), so classification walks the chain.
 */
import { isOrg, orgGenerations, type ContractAddresses, type OrgGeneration } from "@abxfs/sdk";
import type { Address, PublicClient } from "viem";

import { GatewayError } from "./errors.js";

/**
 * The ONLY error shapes a real revert can have. viem builds a revert out of exactly these layers
 * (`ContractFunctionExecutionError > [ContractFunctionRevertedError >] CallExecutionError >
 * ExecutionRevertedError > [InvalidInputRpcError >] RpcRequestError`, with the node's own JSON-RPC error
 * object, which has no name, at the bottom). This is an ALLOW-list on purpose: any other layer in the chain
 * (`HttpRequestError`, `TimeoutError`, `InternalRpcError`, `LimitExceededRpcError`,
 * `ResourceUnavailableRpcError`, `UnknownRpcError`, `ContractFunctionZeroDataError`, ...) means the
 * request did not get a clean answer from the EVM, and a name nobody listed can never be read as "no".
 *
 * Why the viem NAME alone proves nothing: `ExecutionRevertedError` is also what viem makes of a -32005
 * rate limit whose message happens to contain "execution reverted", of a 502 page that says so, and of
 * `-32000 gas required exceeds allowance`. The evidence is the JSON-RPC error code underneath.
 */
const REVERT_LAYERS = new Set([
  "ContractFunctionExecutionError",
  "ContractFunctionRevertedError",
  "AbiErrorSignatureNotFoundError",
  "CallExecutionError",
  "ExecutionRevertedError",
  "InvalidInputRpcError",
  "RpcRequestError",
]);

/**
 * The error and everything under it, bounded (a hostile or cyclic `cause` must not hang a request). This is
 * viem's own `BaseError.walk()` order; it is spelled out because the SDK and the gateway can resolve two
 * copies of viem, and `walk` only exists on errors from the copy that made them.
 */
function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 12) {
    seen.add(cur);
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

const nameOf = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : "";
};
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** `execution reverted` and nothing but a reason after it: not `execution reverted (request exceeded 10s time limit)`. */
const REVERT_MESSAGE = /^execution reverted(?::|$)/i;

/**
 * Did the EVM itself reject this call? A revert is ONLY:
 *
 *  (a) a JSON-RPC error with `code === 3` (the EIP-1474 execution-reverted code, which is what carries
 *      revert data), or `-32000` whose message STARTS WITH `execution reverted` (geth's spelling of the
 *      same thing) and has nothing after it but a reason; and the chain beneath it is a revert chain and
 *      nothing else (see {@link REVERT_LAYERS});
 *  (b) a `ContractFunctionRevertedError` carrying a decoded custom error or non-empty revert bytes, with no
 *      transport layer anywhere in its chain (a multicall result viem decoded without an RPC error);
 *  (c) the SDK's own `project … does not exist (ownerOf reverted)`, a plain Error built from a multicall
 *      sub-call result that reports a REVERT (never a zero-data or decoding failure).
 *
 * Everything else is "the chain could not be asked": transport errors, HTTP statuses, a body that is not
 * JSON-RPC, -32603, -32005, -32002, -32016, -32000 for gas or resource limits, an empty `0x` result
 * (zero data: a replica that dropped the call, or an address with no code; nothing in the gateway reads an
 * address it has not already established has code, so it is never evidence of absence), a timeout, an
 * abort. Returns false for all of them.
 */
export function isRevert(err: unknown): boolean {
  const chain = causeChain(err);
  if (chain.length === 0) return false;

  // (c) the SDK's own wrapper, which is a plain Error and carries the failed sub-call as TEXT.
  const first = chain[0] as { message?: unknown };
  if (nameOf(first) === "Error" && chain.length === 1) {
    const m = text(first.message);
    const prefix = /^project \S+ does not exist \(ownerOf reverted\): /.exec(m);
    if (!prefix) return false;
    // What follows is the failed sub-call, as text. It must say REVERT, and must not be a decode/zero-data failure.
    const detail = m.slice(prefix[0].length);
    return /revert/i.test(detail) && !/zero.?data|returned no data|HttpRequest|Timeout|InternalRpc|LimitExceeded/i.test(detail);
  }

  // Every layer must be one a revert is made of. A single foreign layer disqualifies the whole chain.
  if (!chain.every((e) => nameOf(e) === "" || REVERT_LAYERS.has(nameOf(e)))) return false;
  if (chain.some((e) => typeof (e as { status?: unknown }).status === "number")) return false;

  // The node's own error is the layer that carries a numeric `code` (an `RpcRequestError`, or the unnamed
  // JSON-RPC error object under it). Its message is the node's, not viem's.
  const rpc = chain.filter((e) => typeof (e as { code?: unknown }).code === "number");
  if (rpc.length > 0) {
    const code = (rpc[rpc.length - 1] as { code: number }).code;
    if (rpc.some((e) => (e as { code: number }).code !== code)) return false;
    if (code === 3) return true;
    if (code === -32000) {
      const raw = rpc[rpc.length - 1] as { message?: unknown; details?: unknown };
      const message = (text(raw.message) || text(raw.details)).trim();
      return REVERT_MESSAGE.test(message);
    }
    return false;
  }

  // (b) no RPC error in the chain: a revert viem decoded itself. Only with the bytes (or the decoded error) in hand.
  return chain.some((e) => {
    if (nameOf(e) !== "ContractFunctionRevertedError") return false;
    const r = e as { data?: unknown; raw?: unknown };
    return r.data !== undefined || (typeof r.raw === "string" && r.raw !== "0x" && r.raw.length > 2);
  });
}

/**
 * Did the call come back EMPTY (`0x`)? viem reports that as a zero-data error. Alone it proves nothing: it is
 * what a contract with no code answers, and equally what a replica that dropped the call answers. The only
 * way to tell them apart is to ask for the code ({@link lookupGeneration} does, once, for a factory).
 */
export function isZeroData(err: unknown): boolean {
  const chain = causeChain(err);
  const zero = chain.some((e) => nameOf(e) === "ContractFunctionZeroDataError" || nameOf(e) === "AbiDecodingZeroDataError");
  return zero && chain.every((e) => nameOf(e) === "" || nameOf(e) === "ContractFunctionExecutionError" || nameOf(e) === "ContractFunctionZeroDataError" || nameOf(e) === "AbiDecodingZeroDataError");
}

/** A failure that is not the chain's answer. Never cached, never a 404. Retryable. */
export function upstreamUnavailable(): GatewayError {
  return new GatewayError("the chain could not be read right now; retry shortly", 503);
}

/**
 * Run a read whose only DEFINITIVE failure is a revert. A revert becomes `onRevert()`; anything else is a
 * retryable 503 (and is NOT cached by the caller, because it throws before any caching happens).
 */
export async function readOrRevert<T, R>(read: () => Promise<T>, onRevert: (err: unknown) => R): Promise<T | R> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (isRevert(err)) return onRevert(err);
    throw upstreamUnavailable();
  }
}

export type GenerationLookup =
  | { found: OrgGeneration; unknown: false }
  | { found: null; unknown: boolean };

/**
 * Which factory generation created `org`. Unlike the SDK's `generationOfOrg` (which swallows EVERY error as
 * "not created by this factory" so the interactive client never throws), this asks each generation itself and
 * keeps the three outcomes apart:
 *
 *  - some generation answered `true`: found (a `true` is definitive even if an older factory errored);
 *  - every generation answered `false` or reverted: definitively not an org;
 *  - none said `true` and at least one could not be asked: UNKNOWN. The caller must not cache this.
 */
export async function lookupGeneration(
  client: PublicClient,
  addresses: ContractAddresses,
  org: Address,
): Promise<GenerationLookup> {
  // Every generation is asked AT ONCE: asking them one after another made a dead RPC cost (generations x the
  // RPC's own timeout) before the visitor learned anything. A `true` from any one is definitive and wins as soon
  // as it arrives; otherwise all of them are waited for, so "unknown" still means one could not be asked.
  const generations = orgGenerations(addresses);
  if (generations.length === 0) return { found: null, unknown: false };
  return new Promise<GenerationLookup>((resolve) => {
    let pending = generations.length;
    let unknown = false;
    let done = false;
    const settle = () => {
      if (!done && --pending === 0) {
        done = true;
        resolve({ found: null, unknown });
      }
    };
    for (const generation of generations) {
      isOrg(client, generation.orgFactory, org).then(
        (yes) => {
          if (yes && !done) {
            done = true;
            resolve({ found: generation, unknown: false });
          } else settle();
        },
        async (err) => {
          if (isRevert(err)) return settle();
          // An empty answer is only "no such factory" when the address is PROVEN to hold no code; otherwise it is
          // a replica that dropped the call, and the lookup is unknown (never cached as "not an org").
          if (isZeroData(err)) {
            try {
              const code = await client.getCode({ address: generation.orgFactory });
              if (code === undefined || code === "0x") return settle();
            } catch {
              /* could not prove it: unknown */
            }
          }
          unknown = true;
          settle();
        },
      );
    }
  });
}

/**
 * Share ONE in-flight promise per key. A cold cache under load is a stampede: N visitors for the same
 * address each paid the same RPC reads. The entry lives only while the work does (cleaned up on settle,
 * success or failure, so a failure is never remembered here: that is the caller's cache's job, and it
 * caches only definitive answers), and the map is bounded: when it is full the work simply runs unshared.
 */
export function singleFlight<T>(flights: Map<string, Promise<T>>, key: string, work: () => Promise<T>, limit = 2_000): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing;
  if (flights.size >= limit) return work();
  const promise = work().finally(() => {
    if (flights.get(key) === promise) flights.delete(key);
  });
  flights.set(key, promise);
  return promise;
}

/** The RPC endpoint answers for another chain than the one it was configured for. */
export class WrongChainError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number | undefined,
  ) {
    super(`the RPC endpoint for chain ${expected} answers for chain ${actual ?? "unknown"}: every read from it is refused`);
    this.name = "WrongChainError";
  }
}

/** The most bytes an `eth_chainId` answer may be. A real one is about 50. */
export const CHAIN_ID_PROBE_MAX_BYTES = 64 * 1024;
/** How long the shared `eth_chainId` check may take, on its own clock (viem's own default request timeout). */
export const CHAIN_ID_PROBE_TIMEOUT_MS = 10_000;
/** How long an endpoint that answered for the wrong chain is refused before it is asked again. */
export const WRONG_CHAIN_TTL_MS = 5 * 60_000;

/** At most `max` bytes of a body as text, or null past that (the rest is not read). */
async function readTextCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `promise`, or a rejection with the signal's reason as soon as `signal` aborts. The promise itself runs on. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * A `fetch` for the RPC transport that only talks to an endpoint answering for `chainId`.
 *
 * The content stores and the factory sit at the same address on every chain, so an endpoint for the wrong chain (the
 * bare `ABXFS_RPC_URL` falling through to a chain it was not meant for, a pasted testnet URL) answers every read
 * plausibly: it would serve another chain's content under this chain's URLs and filter subjects. So the first
 * request to each URL asks it `eth_chainId` first. A URL that answers for another chain fails every request for
 * {@link WRONG_CHAIN_TTL_MS} (logged when found), then is asked again: one fetch lives as long as its process, and an
 * operator who fixes the endpoint behind the same URL must not need a restart. One whose check could not complete is
 * asked again on the next request; one that answered for the right chain is never asked again.
 *
 * The check is SHARED by every request that arrives while it runs, so it runs on its own clock
 * ({@link CHAIN_ID_PROBE_TIMEOUT_MS}), never on the first caller's signal: a first visitor who gave up used to abort
 * the check for everyone waiting on it. Each caller still stops waiting when its own signal aborts. Its answer is read
 * to at most {@link CHAIN_ID_PROBE_MAX_BYTES}.
 *
 * Make ONE per chain and keep it (a module-level cache): the check is remembered inside it, so a new one per read
 * asks `eth_chainId` again every time.
 */
export function chainCheckedFetch(
  chainId: number,
  inner: typeof fetch = (...a) => fetch(...a),
  options: { probeTimeoutMs?: number; wrongChainTtlMs?: number } = {},
): typeof fetch {
  const probeTimeoutMs = options.probeTimeoutMs ?? CHAIN_ID_PROBE_TIMEOUT_MS;
  const wrongChainTtlMs = options.wrongChainTtlMs ?? WRONG_CHAIN_TTL_MS;
  const checks = new Map<string, Promise<void>>();
  /** When a URL's wrong-chain refusal lapses and it is asked again. */
  const refusedUntil = new Map<string, number>();
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const until = refusedUntil.get(url);
    if (until !== undefined && until <= Date.now()) {
      refusedUntil.delete(url);
      checks.delete(url);
    }
    let check = checks.get(url);
    if (!check) {
      check = (async () => {
        const res = await inner(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        const text = await readTextCapped(res, CHAIN_ID_PROBE_MAX_BYTES);
        if (text === null) throw new Error(`eth_chainId answered with more than ${CHAIN_ID_PROBE_MAX_BYTES} bytes (HTTP ${res.status})`);
        let result: unknown;
        try {
          result = (JSON.parse(text) as { result?: unknown }).result;
        } catch {
          throw new Error(`eth_chainId answered with something that is not JSON-RPC (HTTP ${res.status})`);
        }
        if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(result)) {
          throw new Error(`eth_chainId answered without a chain id (HTTP ${res.status})`);
        }
        const actual = Number(BigInt(result));
        if (actual !== chainId) {
          const err = new WrongChainError(chainId, actual);
          console.error(`[abxfs-gateway] ${err.message}`);
          throw err;
        }
      })();
      checks.set(url, check);
      // This check is still the URL's when it settles: another is made only once the entry is gone, and the entry goes
      // only here, or once a wrong-chain refusal that THIS handler set has lapsed (by then this has run).
      check.catch((err: unknown) => {
        if (err instanceof WrongChainError) refusedUntil.set(url, Date.now() + wrongChainTtlMs);
        else checks.delete(url);
      });
    }
    await untilAborted(check, init?.signal);
    return inner(input, init);
  };
}

/**
 * The most bytes one batch answer is read to: viem's own `maxResponseBodySize` default, which it enforces on what this
 * hands it anyway. Buffering past it only to have viem refuse the result would hold memory for nothing.
 */
export const BATCH_RESPONSE_MAX_BYTES = 10_485_760;

/**
 * A `fetch` for the RPC transport that refuses a JSON-RPC BATCH answer whose ids do not match the request.
 *
 * viem does NOT check ids: it sorts a batch answer by id and hands each call the result at its position. So a
 * provider that answers a batch with the wrong ids (a known proxy quirk) attaches another call's answer to ours: a
 * `-32000 execution reverted` meant for a different call becomes "this org does not exist" for this one, and one
 * call's chunk bytes become another's. Nothing downstream can tell either apart from a real answer, so it is stopped
 * here: a mismatched batch is a bad gateway (an outage: 503, never cached).
 *
 * EVERY batch is checked, at any size. The large ones are exactly the ones that matter most: a batch that carries
 * chunk data (concurrent visitors' reads share one batch per tick) is the one a mismatch would silently corrupt, and
 * a root host caches what it serves `immutable`. (An earlier version passed answers over 4 MiB through unchecked, on
 * the mistaken belief that viem validated them.) The answer is read once; only the `id` of each element is parsed,
 * by {@link BatchIdScanner}, so a large answer is not decoded or parsed twice; viem then reads the same bytes.
 *
 * A non-batch request, or an answer that is not a JSON array (a bare error object, an HTML page), is returned as the
 * provider sent it, for viem to classify as it always did.
 *
 * A batch answer is buffered to at most `maxBytes` ({@link BATCH_RESPONSE_MAX_BYTES} by default, which is viem's own
 * cap on a response body): past it, or past a `Content-Length` that says so, the rest is not read and the answer is a
 * 502, as viem would refuse it after the fact. Pass the same value as the transport's `maxResponseBodySize` if you
 * raise that.
 */
export function strictBatchFetch(inner: typeof fetch = (...a) => fetch(...a), options: { maxBytes?: number } = {}): typeof fetch {
  const maxBytes = options.maxBytes ?? BATCH_RESPONSE_MAX_BYTES;
  const tooLarge = () =>
    new Response(`JSON-RPC batch response larger than ${maxBytes} bytes`, {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/plain" },
    });
  return async (input, init) => {
    const res = await inner(input, init);
    const body = init?.body;
    if (typeof body !== "string" || !body.startsWith("[")) return res;
    let wanted: unknown[];
    try {
      wanted = (JSON.parse(body) as Array<{ id?: unknown }>).map((r) => r?.id);
    } catch {
      return res;
    }
    if (!res.body) return res;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.body.cancel().catch(() => {});
      return tooLarge();
    }

    const scanner = new BatchIdScanner();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          reader.cancel().catch(() => {});
          return tooLarge();
        }
        chunks.push(value);
        scanner.push(value);
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err; // a body that broke off mid-read: viem reports it as the transport failure it is
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    // The body was consumed here, so viem gets the same bytes in a fresh Response. Its length and coding are those of
    // what was read (fetch has already decoded any Content-Encoding), not of the wire.
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const nullBody = res.status === 101 || res.status === 103 || res.status === 204 || res.status === 205 || res.status === 304;
    const replay = () => new Response(nullBody ? null : bytes, { status: res.status, statusText: res.statusText, headers });

    const verdict = scanner.finish();
    if (verdict.kind === "not-an-array") return replay();
    if (verdict.kind === "ids") {
      const have = new Map<unknown, number>();
      for (const id of verdict.ids) have.set(id, (have.get(id) ?? 0) + 1);
      if (verdict.ids.length === wanted.length && wanted.every((id) => have.get(id) === 1)) return replay();
    }
    return new Response("JSON-RPC batch response ids do not match the request", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/plain" },
    });
  };
}

/** An element's `id` that could not be read (malformed, repeated, too long): matches no request id. */
const UNREADABLE_ID = Symbol("unreadable id");
/** An element with no `id` member at all. */
const MISSING_ID = Symbol("missing id");

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const isWhitespace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * Reads the `id` of every element of a JSON array, byte by byte, without decoding or parsing anything else: a batch
 * answer of many megabytes of hex costs one pass over its bytes and a handful of tiny `JSON.parse` calls.
 *
 * It tracks only what it must: string boundaries (so a `"id"` inside a result string is never mistaken for a key),
 * nesting depth, and, inside each top-level element object, which key a value belongs to. The value of a top-level
 * `id` member is captured raw (at most 256 bytes) and parsed alone, so `1`, `"1"` and `null` stay distinct exactly as
 * `JSON.parse` would make them. Anything it cannot read as a well-formed array of elements is "malformed", which the
 * caller treats as a mismatch: a batch answer that is not one is an outage either way.
 */
export class BatchIdScanner {
  private started = false;
  private isArray = false;
  private closed = false;
  private malformed = false;
  private depth = 0;
  private inString = false;
  private escape = false;
  /** At depth 1: the next non-whitespace byte starts an element. */
  private expectElement = true;
  /** Inside a top-level element object (depth 2): the next string is a key. */
  private expectKey = false;
  private keyBytes: number[] | null = null;
  private lastKey: string | null = null;
  private capture: number[] | null = null;
  private elementId: unknown = MISSING_ID;
  private inElement = false;
  private readonly ids: unknown[] = [];

  push(chunk: Uint8Array): void {
    // Inside a plain string (a result's hex, which is nearly all of a large answer) only `"` and `\` matter: jump to
    // the next of either with the native search instead of visiting every byte. Each position is searched for once.
    let quote = -2;
    let backslash = -2;
    let i = 0;
    while (i < chunk.length) {
      if (this.malformed || (this.started && !this.isArray)) return;
      if (this.inString && !this.escape && this.keyBytes === null && this.capture === null) {
        if (quote !== -1 && quote < i) quote = chunk.indexOf(QUOTE, i);
        if (backslash !== -1 && backslash < i) backslash = chunk.indexOf(BACKSLASH, i);
        const next = quote < 0 ? backslash : backslash < 0 ? quote : Math.min(quote, backslash);
        if (next < 0) return;
        i = next;
      }
      this.byte(chunk[i]!);
      i++;
    }
  }

  finish(): { kind: "not-an-array" } | { kind: "malformed" } | { kind: "ids"; ids: unknown[] } {
    if (!this.started || !this.isArray) return { kind: "not-an-array" };
    if (this.malformed || !this.closed || this.inString) return { kind: "malformed" };
    return { kind: "ids", ids: this.ids };
  }

  private byte(b: number): void {
    if (!this.started) {
      // Leading whitespace, and a UTF-8 byte order mark (which `Response.json()` would strip).
      if (isWhitespace(b) || b === 0xef || b === 0xbb || b === 0xbf) return;
      this.started = true;
      this.isArray = b === OPEN_ARRAY;
      if (this.isArray) this.depth = 1;
      return;
    }
    if (this.closed) {
      if (!isWhitespace(b)) this.malformed = true;
      return;
    }
    if (this.capture) {
      this.capture.push(b);
      if (this.capture.length > 256) this.malformed = true;
    }
    if (this.inString) {
      if (this.escape) this.escape = false;
      else if (b === BACKSLASH) this.escape = true;
      else if (b === QUOTE) {
        this.inString = false;
        if (this.keyBytes) {
          this.lastKey = this.decodeKey(this.keyBytes);
          this.keyBytes = null;
          this.expectKey = false;
        }
        return;
      }
      if (this.keyBytes) {
        this.keyBytes.push(b);
        if (this.keyBytes.length > 64) this.keyBytes.length = 64; // a long key is not "id" either way
      }
      return;
    }
    if (isWhitespace(b)) return;

    if (this.depth === 1 && this.expectElement && b !== CLOSE_ARRAY) {
      this.expectElement = false;
      this.inElement = true;
      this.elementId = MISSING_ID;
    }

    switch (b) {
      case QUOTE:
        this.inString = true;
        if (this.depth === 2 && this.expectKey && !this.capture) this.keyBytes = [];
        return;
      case OPEN_OBJECT:
      case OPEN_ARRAY:
        this.depth++;
        if (this.depth === 2 && b === OPEN_OBJECT) this.expectKey = true;
        return;
      case CLOSE_OBJECT:
      case CLOSE_ARRAY:
        if (this.depth === 2 && this.capture) this.endCapture(1);
        // Never below zero: depth starts at 1 when the array opens, and once it is back to 0 `closed` is set and
        // every later byte returns above, before this switch.
        this.depth--;
        if (this.depth === 0) {
          if (b !== CLOSE_ARRAY) this.malformed = true;
          this.endElement();
          this.closed = true;
        }
        return;
      case COMMA:
        if (this.depth === 2) {
          if (this.capture) this.endCapture(1);
          this.expectKey = true;
        } else if (this.depth === 1) {
          this.endElement();
          this.expectElement = true;
        }
        return;
      case COLON:
        if (this.depth === 2 && this.lastKey !== null) {
          if (this.lastKey === "id") {
            if (this.elementId !== MISSING_ID) this.elementId = UNREADABLE_ID; // a second `id`: trust neither
            else this.capture = [];
          }
          this.lastKey = null;
        }
        return;
      default:
        return;
    }
  }

  /**
   * The captured value, minus the delimiter byte that ended it. A capture starts only at the FIRST `id` of an element
   * (a second one marks the element unreadable instead, and starts none), and no key is read while one runs, so the
   * element's id is still unset here.
   */
  private endCapture(trailing: number): void {
    const raw = this.capture!.slice(0, this.capture!.length - trailing);
    this.capture = null;
    try {
      this.elementId = JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
    } catch {
      this.elementId = UNREADABLE_ID;
    }
  }

  private endElement(): void {
    if (!this.inElement) return;
    this.inElement = false;
    this.ids.push(this.elementId);
  }

  private decodeKey(bytes: number[]): string | null {
    try {
      return JSON.parse(`"${new TextDecoder().decode(new Uint8Array(bytes))}"`) as string;
    } catch {
      return null;
    }
  }
}
