/**
 * The one way a pinning provider talks HTTP: bounded in time, bounded in size, never redirected.
 *
 *   - Time. Node's fetch (undici) applies a 300 s `headersTimeout` measured from the START of the request, upload
 *     included, so a healthy upload of a large CAR over a slow link died at five minutes while still sending. Here
 *     the dispatcher's own header and body timeouts are off and a watchdog does the job on PROGRESS instead: the
 *     upload must keep moving (no {@link HttpTimeouts.stallMs} without a byte), the response must start within
 *     {@link HttpTimeouts.responseMs} of the upload ending, and its body must keep moving too. Connecting has its own
 *     limit. A server that accepts the connection and never reads, or never answers, fails in bounded time.
 *   - Size. Every response is read through a capped reader ({@link MAX_RESPONSE_BYTES}): an endless or huge body
 *     (a hostile or broken endpoint) is cut off, not buffered, and an error body is quoted only in part.
 *   - Redirects are an error. A credential sent to one origin must not follow a redirect to another.
 *
 * Every error names the provider, what was being done, the endpoint's host (never its path or query, where a key
 * can live) and the network error's code (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, ...).
 */

export interface HttpTimeouts {
  /** Establishing the connection. Default 30 s. */
  connectMs?: number;
  /** Longest pause in the upload, or in the response body, before giving up. Default 60 s. */
  stallMs?: number;
  /** Longest wait for the response headers once the request (body included) is sent. Default 300 s. */
  responseMs?: number;
}

export const DEFAULT_TIMEOUTS: Readonly<Required<HttpTimeouts>> = Object.freeze({
  connectMs: 30_000,
  stallMs: 60_000,
  responseMs: 300_000,
});

/** The most of any response body that is read: a JSON reply or an error message is a few hundred bytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** How much of an error body is quoted in an error message. */
export const MAX_ERROR_TEXT = 500;

/** The grain at which upload progress is seen: the body is handed to the socket this much at a time. */
const UPLOAD_SLICE = 64 * 1024;

export interface HttpResult {
  status: number;
  ok: boolean;
  /** The body as text, at most {@link MAX_RESPONSE_BYTES}. */
  text: string;
  /** The body was longer than {@link MAX_RESPONSE_BYTES} and was cut off. */
  truncated: boolean;
}

export interface HttpRequest {
  /** `kubo`, `pinata`, ... */
  provider: string;
  /** What is being done, for messages: `dag/import`, `upload`, `list`. */
  what: string;
  url: URL | string;
  method: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  /** A request body of known size (see {@link multipartBody}); its upload progress is what the watchdog watches. */
  body?: { blob: Blob; contentType: string };
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResult>;
}

/**
 * The cross-version symbol undici 6 keeps its global dispatcher under (Node 22). Node 24 keeps the same `Agent` under
 * it and {@link UNDICI_GLOBAL_DISPATCHER_2}; Node 26 keeps its `Agent` under `.2` only, and under `.1` a compatibility
 * wrapper (`Dispatcher1Wrapper`) whose class is no dispatcher of the version `fetch` expects. Measured 2026-10-30:
 * Node 22's and Node 24's `fetch` read `.1`, Node 26's reads `.2`, and Node 24's accepts an undici 8 `Agent`.
 */
export const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/** The symbol undici 7 and later keep their global dispatcher under (Node 24 and 26). */
export const UNDICI_GLOBAL_DISPATCHER_2 = Symbol.for("undici.globalDispatcher.2");

/**
 * Where this module reads the version of the undici behind Node's own `fetch`: `process.versions.undici` (6.x on Node
 * 22, 7.x on Node 24, 8.x on Node 26), `undefined` outside Node. Mutable only for tests, which pin it so that every
 * Node's branch runs whatever Node runs the suite.
 */
export const undiciRuntime: { version: () => string | undefined } = {
  version: () => (globalThis as { process?: { versions?: Record<string, string | undefined> } }).process?.versions?.undici,
};

/**
 * The global dispatcher of the undici that runs Node's own `fetch`, or `undefined` (no request has installed one yet,
 * or this is not Node). Which symbol holds it depends on that undici's version ({@link undiciRuntime}):
 *
 *   - undici 7 and later (Node 24 and 26): the one under {@link UNDICI_GLOBAL_DISPATCHER_2}, else the one under
 *     {@link UNDICI_GLOBAL_DISPATCHER}. Reading `.1` first made the replacement a no-op on Node 26, where `.1` holds a
 *     compatibility wrapper.
 *   - anything older, or no version (Node 22's undici 6): the one under {@link UNDICI_GLOBAL_DISPATCHER} ONLY. Undici 6
 *     never writes `.2`, but a newer undici loaded into the same process does: merely `require()`-ing undici 8 puts its
 *     own `Agent` under `.2` (and a wrapper under `.1`). An instance of that class handed to Node 22's `fetch` failed
 *     every request (`invalid onRequestStart method`, `UND_ERR_INVALID_ARG`).
 */
export function undiciGlobalDispatcher(): unknown {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const major = Number.parseInt(undiciRuntime.version() ?? "", 10);
  return major >= 7 ? (g[UNDICI_GLOBAL_DISPATCHER_2] ?? g[UNDICI_GLOBAL_DISPATCHER]) : g[UNDICI_GLOBAL_DISPATCHER];
}

/**
 * A dispatcher from the undici that runs Node's own `fetch`, with its implicit timeouts off (the watchdog replaces
 * them) and an explicit connect timeout. Node does not export undici, but its global dispatcher is reachable through
 * the cross-version symbols undici itself uses for it ({@link undiciGlobalDispatcher}), and a new instance of its class
 * is a dispatcher of exactly the version `fetch` expects.
 *
 * Node installs that global dispatcher on the FIRST `fetch` call, not when `fetch` is first touched (Node 22, 24, 26),
 * so in a process whose first request is this one there is none yet. A `data:` fetch installs it without touching the
 * network, and is made first when it is missing; without it, the first upload would run with undici's 300 s
 * `headersTimeout` from the start of the request, which is what this module exists to replace.
 *
 * Only Node's own classes are replaced: a plain `Agent` (Node's default) and an `EnvHttpProxyAgent` (installed by
 * `NODE_USE_ENV_PROXY`; a new one reads the same proxy variables). The new instance has default options plus these
 * timeouts: options of a global `Agent` someone configured themselves (TLS, connection limits) are NOT carried over.
 * Any other global dispatcher (a `ProxyAgent`, a `MockAgent`, a custom one) is left alone and `fetch` uses it with
 * undici's own timeouts, as it does outside Node or if any of this stops holding (`undefined`). To keep a configured
 * transport and still get the watchdog, pass `httpClient({ fetch })` a fetch that supplies its own dispatcher.
 */
async function nodeDispatcher(connectMs: number): Promise<unknown> {
  try {
    if (undiciGlobalDispatcher() === undefined) {
      await globalThis.fetch("data:,").then((r) => r.arrayBuffer(), () => undefined);
    }
    const Ctor = (undiciGlobalDispatcher() as { constructor?: new (opts: object) => unknown } | undefined)?.constructor;
    if (!Ctor || (Ctor.name !== "Agent" && Ctor.name !== "EnvHttpProxyAgent")) return undefined;
    return new Ctor({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: connectMs });
  } catch {
    return undefined;
  }
}

function hostOf(url: URL | string): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return "(invalid url)";
  }
}

/** The network error's code, from the error or its cause chain (`ECONNREFUSED`, `UND_ERR_SOCKET`, ...). */
function codeOf(err: unknown): string | undefined {
  for (let e = err, i = 0; e && i < 6; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

function causeText(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, i = 0; e && i < 6; e = (e as { cause?: unknown }).cause, i++) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m && !parts.includes(m)) parts.push(m);
  }
  return parts.join(": ") || String(err);
}

/** At most {@link MAX_ERROR_TEXT} characters of an error body, on one line. */
export function errorText(r: HttpResult): string {
  const t = r.text.replace(/\s+/g, " ").trim();
  return t.length > MAX_ERROR_TEXT || r.truncated ? `${t.slice(0, MAX_ERROR_TEXT)}… (truncated)` : t;
}

/** A `multipart/form-data` body as one Blob, so its size is known and the CAR inside it is never copied. */
export function multipartBody(
  parts: Array<{ name: string; value: string } | { name: string; blob: Blob; filename: string; type: string }>,
): { blob: Blob; contentType: string } {
  const boundary = `----abxfs-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  // As the WHATWG form encoder does: a quote, CR or LF in a name cannot break out of the header.
  const q = (s: string) => s.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const chunks: BlobPart[] = [];
  for (const p of parts) {
    if ("blob" in p) {
      chunks.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${q(p.name)}"; filename="${q(p.filename)}"\r\nContent-Type: ${p.type}\r\n\r\n`,
        p.blob,
        "\r\n",
      );
    } else {
      chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${q(p.name)}"\r\n\r\n${p.value}\r\n`);
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return { blob: new Blob(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

class Watchdog {
  readonly controller = new AbortController();
  reason: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  arm(ms: number, why: () => string): void {
    this.disarm();
    // Once the request is over, nothing re-arms it: a body stream cancelled by the abort still settles a pending
    // pull, and a timer armed then would hold the process open for the full response timeout.
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.reason = why();
      this.controller.abort(new Error(this.reason));
    }, ms);
  }
  disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** The request is over, however it ended: disarm for good. */
  close(): void {
    this.closed = true;
    this.disarm();
  }
}

/** Read `body` up to `max` bytes, re-arming the watchdog on every chunk; cancel the rest. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, dog: Watchdog, stallMs: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let received = 0;
  try {
    for (;;) {
      dog.arm(stallMs, () => `the response stalled: no data for ${stallMs / 1000}s (${received} bytes received)`);
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const room = max - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total = max;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    dog.disarm();
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  return { bytes, truncated };
}

/** An {@link HttpClient} over `fetch` (default: Node's), with the guarantees described at the top of this file. */
export function httpClient(opts: { fetch?: typeof fetch; timeouts?: HttpTimeouts } = {}): HttpClient {
  const t: Required<HttpTimeouts> = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const doFetch = opts.fetch ?? globalThis.fetch;
  // Only Node's own fetch gets the dispatcher: an injected fetch (a test, a wrapper) keeps its own transport. Made
  // once, on the first request.
  let dispatcher: Promise<unknown> | undefined;
  const getDispatcher = () => (opts.fetch ? undefined : (dispatcher ??= nodeDispatcher(t.connectMs)));

  return {
    async request(req) {
      const host = hostOf(req.url);
      const label = `[abxfs-pinning] ${req.provider} ${req.what} at ${host}`;
      const dog = new Watchdog();
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      let body: ReadableStream<Uint8Array> | undefined;
      if (req.body) {
        const total = req.body.blob.size;
        let sent = 0;
        headers["content-type"] = req.body.contentType;
        headers["content-length"] = String(total);
        const stalled = () => `the upload stalled: no progress for ${t.stallMs / 1000}s (${sent} of ${total} bytes sent)`;
        dog.arm(t.connectMs + t.stallMs, stalled);
        // Pulled one chunk at a time (high-water mark 0), so a pull means the socket took the previous chunk: that is
        // the progress the watchdog watches. (`blob.stream().pipeThrough(…)` is drained eagerly, the whole body at
        // once, and would show "all sent" while nothing had left the machine.)
        // A Blob's stream can hand over a whole part (the entire CAR) as one chunk, so chunks are re-cut to
        // UPLOAD_SLICE bytes: progress is then seen at that grain.
        const source = req.body.blob.stream().getReader();
        let pending = new Uint8Array(0);
        body = new ReadableStream<Uint8Array>(
          {
            async pull(ctl) {
              if (pending.byteLength === 0) {
                const { done, value } = await source.read();
                if (done) {
                  dog.arm(t.responseMs, () => `no response within ${t.responseMs / 1000}s of the upload finishing (${total} bytes sent)`);
                  ctl.close();
                  return;
                }
                pending = value;
              }
              const slice = pending.subarray(0, UPLOAD_SLICE);
              pending = pending.subarray(slice.byteLength);
              sent += slice.byteLength;
              dog.arm(t.stallMs, stalled);
              ctl.enqueue(slice);
            },
            cancel(reason) {
              return source.cancel(reason);
            },
          },
          { highWaterMark: 0 },
        );
      } else {
        dog.arm(t.connectMs + t.responseMs, () => `no response within ${(t.connectMs + t.responseMs) / 1000}s`);
      }

      let res: Response;
      try {
        const d = await getDispatcher();
        res = await doFetch(req.url, {
          method: req.method,
          headers,
          ...(body ? { body, duplex: "half" } : {}),
          signal: dog.controller.signal,
          redirect: "error",
          ...(d ? { dispatcher: d } : {}),
        } as RequestInit);
      } catch (e) {
        dog.close();
        if (dog.reason) throw new Error(`${label} timed out: ${dog.reason}`, { cause: e });
        const code = codeOf(e);
        throw new Error(`${label} failed: ${causeText(e)}${code ? ` (${code})` : ""}`, { cause: e });
      }
      if (res.status >= 300 && res.status < 400) {
        // Only reachable with an injected fetch that ignores `redirect: "error"`.
        await res.body?.cancel().catch(() => undefined);
        dog.close();
        throw new Error(`${label} answered with a redirect (${res.status}), which is never followed`);
      }
      let read: { bytes: Uint8Array; truncated: boolean };
      try {
        read = await readCapped(res.body, MAX_RESPONSE_BYTES, dog, t.stallMs);
      } catch (e) {
        if (dog.reason) throw new Error(`${label} timed out: ${dog.reason}`, { cause: e });
        const code = codeOf(e);
        throw new Error(`${label}: reading the response failed: ${causeText(e)}${code ? ` (${code})` : ""}`, { cause: e });
      } finally {
        dog.close();
      }
      return {
        status: res.status,
        ok: res.ok,
        text: new TextDecoder().decode(read.bytes),
        truncated: read.truncated,
      };
    },
  };
}

/** Parse a JSON reply, refusing one that was cut off at {@link MAX_RESPONSE_BYTES} or is not JSON. */
export function jsonOf<T>(r: HttpResult, label: string): T {
  if (r.truncated) throw new Error(`${label}: the response is larger than ${MAX_RESPONSE_BYTES} bytes, which no reply here needs`);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new Error(`${label}: the response is not JSON: ${errorText(r)}`);
  }
}
