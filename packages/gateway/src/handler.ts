/**
 * The gateway as a function: `Request` in, `Response` out.
 *
 * Standard Fetch types on purpose, so the same handler runs inside a Next.js route, behind
 * `node:http` (see `server.ts`), in Bun, or in a Worker. Everything specific to a deployment — which
 * chains, which RPC, what to refuse — is an option, and nothing here reads the environment.
 *
 * What a request ADDRESSES is derived exactly once, strictly (`addressing.ts` for path layouts,
 * `parseContentHost` from the SDK for per-project hosts), and the filter's subjects come from that
 * same result. There is no second parser to disagree with it.
 */
import { parseContentHost, registerWebCodecs } from "@abxfs/sdk";

import {
  parseGatewayPath,
  parseOrg,
  parseSubpath,
  splitPathname,
  type Addressing,
} from "./addressing.js";
import { GatewayError } from "./errors.js";
import { servedType } from "./mime.js";
import { cacheControlFor, locate, resolveRoot, serveContent, type Located, type RangeSpec, type ResolvedRequest } from "./resolve.js";
import { rootSubject, subjectsForAddressing } from "./subjects.js";
import type { Filter, FilterDecision, GatewayChain, GatewayOptions } from "./types.js";

/** Most bytes one served file may be (stored, and inflated). */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Seconds a shared cache may hold a "nothing lives here" 404. */
export const DEFAULT_NOT_FOUND_TTL = 30;
/**
 * The most one request may take, in milliseconds, end to end (resolving, reading, verifying). Past it the
 * visitor gets a retryable 503. Without one, a hung RPC held a visitor for the RPC client's own timeout times
 * its retries, per read, per step: 41s for a project host and 82s for a root host were measured.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * How long the default chain gets to answer a root probe before the other served chains are asked as well.
 * Most roots live on the default chain, so most requests cost one probe; a root that lives elsewhere pays
 * this once instead of waiting for the default chain's whole timeout.
 */
export const ROOT_PROBE_HEAD_START_MS = 150;

const DEFAULT_REFUSAL =
  "This content is not available from this gateway.\n\n" +
  "It has not been removed from the blockchain, and it is still readable through any other reader.\n";

export type GatewayHandler = (request: Request) => Promise<Response>;

interface Target {
  chainId: number;
  addressing: Addressing;
  subpath: string;
  /** Segments of the request path, for the directory redirect. */
  pathname: string;
  /** A raw-root host: the chain is a guess (a root names none), so other served chains may be tried. */
  rootHost?: boolean;
}

export function createGateway(options: GatewayOptions): GatewayHandler {
  // gzip arrives through the platform's Compression Streams API. Without this the gateway cannot
  // inflate a gzip-stored file at all: `readFile` looks up a registered decompressor by id.
  registerWebCodecs();

  const modes = [options.hostMode, options.project, options.pathMode].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "createGateway: choose exactly one of `hostMode` (per-project origins; recommended), `project` " +
        "(one project at the host root) or `pathMode` (shared origin; unsafe for untrusted content)",
    );
  }

  const baseHost = options.hostMode ? normalizeBaseHost(options.hostMode.baseHost) : null;
  const basePath = normalizeBase(options.pathMode?.basePath ?? "/g");
  const fixedProject = options.project ? normalizeProject(options.project) : null;
  const lookup =
    typeof options.chains === "function"
      ? options.chains
      : (id: number) => (options.chains as GatewayChain[]).find((c) => c.id === id);
  // One project on a chain this gateway does not serve could never be answered: every request would be a 404.
  if (fixedProject && Array.isArray(options.chains) && !lookup(fixedProject.chainId)) {
    throw new Error(`createGateway: the project is on chain ${fixedProject.chainId}, which is not among the chains this gateway serves`);
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const notFoundTtl = options.notFoundTtl ?? DEFAULT_NOT_FOUND_TTL;
  if (options.rootMaxAge !== undefined && !(Number.isSafeInteger(options.rootMaxAge) && options.rootMaxAge >= 0)) {
    throw new Error(`createGateway: rootMaxAge must be a whole number of seconds, 0 or more (got ${options.rootMaxAge})`);
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logError = options.onError ?? ((detail: string) => console.error(`[gateway] ${detail}`));
  /** Chains a root host may be looked up on, the default first. A root carries no chain; content is shared. */
  const rootChainIds = [...new Set([options.defaultChainId, ...(options.rootChains ?? [])])];
  /** Which chain held a root, once one has. A root is immutable and never leaves the store, so this stays true. */
  const rootWinners = new Map<string, number>();
  const rootConfigLogged = new Set<number>();

  /**
   * A root names no chain, so a root host asks the default chain first and, when that chain does not store
   * it, the other served chains too (a cheap `cidKind` probe each, bounded by the chain list). The probes run
   * IN PARALLEL, the default chain with a small head start, so a hung chain costs one timeout rather than one
   * per chain, and the first chain that HAS the root wins. A losing probe that has not started is never
   * started; one already in flight cannot be cancelled (the SDK takes no signal) and its result is dropped.
   * The winner is remembered. A chain that could not be asked is never read as "not stored": if nothing else
   * has the root the answer is a retryable error, not a 404.
   */
  async function resolveRootHost(t: Target): Promise<ResolvedRequest> {
    const addressing = t.addressing;
    if (addressing.kind !== "cid") throw new GatewayError("not found", 404);
    const known = rootWinners.get(addressing.rootCid);
    const order = known === undefined ? rootChainIds : [known, ...rootChainIds.filter((id) => id !== known)];
    let notFound: GatewayError | undefined;
    let transient: unknown;
    let configError: unknown;

    const probes: Array<{ id: number; chain: GatewayChain }> = [];
    for (const id of order) {
      try {
        const chain = lookup(id);
        if (chain) probes.push({ id, chain });
      } catch (err) {
        if (id === t.chainId) configError = err;
        else if (!rootConfigLogged.has(id)) {
          rootConfigLogged.add(id);
          logError(`root lookup skips chain ${id}: ${scrub(err)}`);
        }
      }
    }

    const winner = await new Promise<ResolvedRequest | null>((resolve) => {
      let next = 0;
      let inFlight = 0;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: ResolvedRequest | null) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const launch = () => {
        if (finished || next >= probes.length) return;
        const { id, chain } = probes[next++]!;
        inFlight++;
        resolveRoot(chain, addressing, t.subpath).then(
          (resolved) => {
            inFlight--;
            rootWinners.set(addressing.rootCid, id);
            if (rootWinners.size > 5_000) rootWinners.delete(rootWinners.keys().next().value as string);
            finish(resolved);
          },
          (err) => {
            inFlight--;
            if (err instanceof GatewayError && err.status === 404) notFound ??= err;
            else transient ??= err;
            // An answer of "not here" releases the next chain at once; no need to wait out the head start.
            if (!finished) {
              if (next < probes.length) {
                if (timer) clearTimeout(timer);
                timer = undefined;
                launch();
                arm();
              } else if (inFlight === 0) finish(null);
            }
          },
        );
      };
      // Everyone after the one just started waits only for the head start, then runs alongside it.
      const arm = () => {
        if (finished || next >= probes.length || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          while (!finished && next < probes.length) launch();
        }, ROOT_PROBE_HEAD_START_MS);
      };
      if (probes.length === 0) return finish(null);
      launch();
      arm();
    });

    if (winner) return winner;
    if (transient) throw transient;
    if (configError) throw configError;
    throw notFound ?? new GatewayError(`root ${addressing.rootCid} is not stored on any chain this gateway serves`, 404);
  }

  /** Work out what a request addresses. Pure: no filter, no chain. */
  function target(request: Request, url: URL): Target {
    const { segments } = splitPathname(url.pathname);

    if (baseHost) {
      const parsed = parseContentHost(requestHost(request, url), baseHost);
      if (!parsed) throw new GatewayError("not found", 404);
      const subpath = parseSubpath(segments);
      if (parsed.kind === "root") {
        return { chainId: requireDefault(options.defaultChainId), addressing: { kind: "cid", rootCid: parsed.rootCid }, subpath, pathname: url.pathname, rootHost: true };
      }
      const org = parsed.org.toLowerCase() as `0x${string}`;
      const addressing: Addressing =
        parsed.version !== undefined
          ? { kind: "version", org, tokenId: parsed.tokenId, version: parsed.version }
          : { kind: "latest", org, tokenId: parsed.tokenId };
      return { chainId: parsed.chainId, addressing, subpath, pathname: url.pathname };
    }

    if (fixedProject) {
      return { chainId: fixedProject.chainId, addressing: fixedProject.addressing, subpath: parseSubpath(segments), pathname: url.pathname };
    }

    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      throw new GatewayError("not found", 404);
    }
    const inner = url.pathname.slice(basePath.length);
    const rest = splitPathname(inner === "" ? "/" : inner).segments;
    const parsed = parseGatewayPath(rest, { defaultChainId: options.defaultChainId });
    return { ...parsed, pathname: url.pathname };
  }

  async function applyFilter(filter: Filter | undefined, subjects: string[], request: Request): Promise<Response | null> {
    if (!filter) return null;
    const decision: FilterDecision = await filter({ subjects, request });
    if (decision.allow) return null;
    if (decision.status === 503) return text("service unavailable", 503, { "retry-after": "5" });
    return refusal(options.refusalMessage ?? DEFAULT_REFUSAL, options.refusalHeaders);
  }

  async function handle(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return text("method not allowed", 405, { allow: "GET, HEAD" });
    }

    try {
      const url = new URL(request.url);
      const t = target(request, url);
      const subjects = subjectsForAddressing(t.chainId, t.addressing);

      // Refuse before reading anything. The subjects come from the parse alone, so this costs no RPC
      // call and a refused request never touches the chain.
      const refused = await applyFilter(options.filter, subjects, request);
      if (refused) return refused;

      let resolved: ResolvedRequest;
      if (t.rootHost && rootChainIds.length > 1) {
        resolved = await resolveRootHost(t);
      } else {
        const chain = lookup(t.chainId);
        if (!chain) throw new GatewayError(`chain ${t.chainId} is not served by this gateway`, 404);
        resolved = await resolveRoot(chain, t.addressing, t.subpath);
      }

      // The root a PROJECT resolved to is only knowable now. Ask again with it added, so a root that
      // was blocked is blocked through every project that republishes it, not only at its own URL.
      const checked = t.addressing.kind !== "cid" ? [...subjects, rootSubject(resolved.rootCid)] : subjects;
      if (t.addressing.kind !== "cid") {
        const again = await applyFilter(options.filter, checked, request);
        if (again) return again;
      }

      // What the path names is read FIRST, so only a directory that exists is redirected (below): `/nope` is a 404
      // straight away, not a 307 to `/nope/` followed by the same 404.
      const located = await locate(resolved);

      // And the CID actually SERVED (a file, or the directory being listed) is a subject too, known only now. Without
      // this a blocked root was matched exactly and nothing else: its subdirectories and files were served at their
      // own root hosts, and a blocked file was served by any directory or project that named it (one SSTORE for a
      // wrapper directory). Costs no RPC: `locate` has already read what it is.
      //
      // A directory's `index.html` serves that DIRECTORY's page, so the directory is served too and is checked with
      // the file: a bare block of a directory with an `index.html` was otherwise served through any wrapper directory
      // at `/<name>/`, because only the file's CID reached the filter.
      const servedCid = located.type === "listing" ? located.dirCid : located.cid;
      const rootLc = resolved.rootCid.toLowerCase();
      // What caches may keep is keyed to the served FILE (or listing) alone: see `cacheControlFor`.
      const servesRoot = servedCid.toLowerCase() === rootLc;
      const servedSubjects: string[] = [];
      for (const cid of [servedCid, located.type === "file" ? located.dirCid : undefined]) {
        if (!cid || cid.toLowerCase() === rootLc) continue;
        const subject = rootSubject(cid);
        if (!servedSubjects.includes(subject)) servedSubjects.push(subject);
      }
      if (servedSubjects.length > 0) {
        const served = await applyFilter(options.filter, [...checked, ...servedSubjects], request);
        if (served) return served;
      }

      // A directory URL must end in `/` or every bare-relative link inside it resolves one level too
      // high. Redirect before serving rather than rewriting links, so the browser's address bar —
      // which is what relative resolution actually uses — is correct.
      const redirect = directoryRedirect(url, located);
      if (redirect) return redirect;

      // Content is addressed by hash, so the CID plus sub-path IS a strong validator. A listing page adds its
      // position: page 2 of a directory is not page 1. It depends on nothing that is read below, so a client that
      // already holds this representation is answered before a single byte of content is read.
      const listingStart = located.type === "listing" ? parseListingStart(url) : 0;
      const etag = `"${resolved.rootCid}:${encodeURIComponent(resolved.subpath)}${listingStart > 0 ? `:s${listingStart}` : ""}"`;
      const cacheControl = cacheControlFor(t.addressing, { servesRoot, ...(options.rootMaxAge !== undefined ? { rootMaxAge: options.rootMaxAge } : {}) });
      if (etagMatches(request.headers.get("if-none-match"), etag)) {
        return new Response(null, {
          status: 304,
          headers: {
            etag,
            "cache-control": cacheControl,
            "x-abxfs-root": resolved.rootCid,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(located.type === "file" ? { "accept-ranges": "bytes" } : {}),
          },
        });
      }
      // A range on a file is offered to the reader first: a file is then read only where the range is (the store
      // finds the chunk holding any byte offset in one call). What it cannot answer that way (a file with a codec)
      // comes back whole, within the size cap, and is sliced below.
      const rangeSpec = located.type === "file" ? rangeSpecOf(request.headers.get("range"), request.headers.get("if-range"), etag) : null;

      // A listing's links name where it is served (the directory URL ends in `/` by now): see `renderListing`.
      const listingBase = located.type === "listing" ? `//${requestHost(request, url)}${url.pathname}` : undefined;
      const body = await serveContent(resolved, { maxFileBytes, located, range: rangeSpec, listingStart, ...(listingBase ? { listingBase } : {}) });
      // The declared type as the browser will read it: one valid MIME type, or `application/octet-stream`. See `mime.ts`.
      const type = servedType(body.mimeType);

      const headers = new Headers({
        "content-type": type.contentType,
        "content-length": String(body.bytes.byteLength),
        "cache-control": cacheControl,
        // The root a URL resolved to, and which path served it. Both are diagnostics a caller cannot
        // otherwise recover, and they make "is IPFS actually being used?" answerable with curl -I.
        "x-abxfs-root": resolved.rootCid,
        etag,
        // Anyone can write bytes to this protocol, so the declared type must be the only type the
        // browser considers. Without this, a text/plain upload that happens to look like HTML can be
        // sniffed into one and run here.
        "x-content-type-options": "nosniff",
        // A project page must not tell the next site which project (or which URL inside it) sent you.
        "referrer-policy": "no-referrer",
      });
      for (const [k, v] of Object.entries(body.headers ?? {})) headers.set(k, v);

      /*
       * SVG, XHTML, XML and XSL are active document formats: navigate straight to one and any script inside
       * it runs on THIS origin. The content layer is permissionless, so that input is attacker
       * controlled by design. `sandbox` with no allow-list drops it into an opaque origin, which kills
       * script execution on direct navigation, and nothing legitimate is lost: an SVG referenced from a
       * project's own page loads through <img> or CSS, where it is never scripted either way. A declared
       * type that is not ONE valid MIME type is served as `application/octet-stream` and sandboxed too.
       *
       * HTML is deliberately NOT sandboxed — serving a working website from a CID is the product. That
       * is exactly why hostMode gives every project its OWN origin, and why X-Frame-Options is not set
       * here: marketplaces embed a project's page in an iframe.
       */
      if (type.sandbox) headers.set("content-security-policy", "sandbox");

      headers.set("accept-ranges", "bytes");

      if (body.range?.kind === "unsatisfiable") {
        const h = new Headers(headers);
        h.set("content-range", `bytes */${body.range.total}`);
        h.set("content-length", "0");
        h.set("cache-control", "no-store, no-transform");
        return new Response(null, { status: 416, headers: h });
      }
      if (body.range?.kind === "partial") {
        const r = body.range;
        headers.set("content-range", `bytes ${r.start}-${r.end}/${r.total}`);
        headers.set("content-length", String(r.end - r.start + 1));
        headers.set("cache-control", `${headers.get("cache-control") ?? "public"}, no-transform`);
        if (method === "HEAD") return new Response(null, { status: 206, headers });
        return new Response(body.bytes as unknown as BodyInit, { status: 206, headers });
      }

      // A single byte range, for a client that seeks (video, audio, a PDF viewer). Anything this does not
      // understand (several ranges, another unit, a malformed header) is answered with the whole file, which
      // the RFC allows. `If-Range` is honoured with the ETag: a validator that is not ours means the client's
      // partial copy is of something else, so it gets the whole file.
      const range = byteRange(request.headers.get("range"), request.headers.get("if-range"), headers.get("etag")!, body.bytes.byteLength);
      if (range === "unsatisfiable") {
        const h = new Headers(headers);
        h.set("content-range", `bytes */${body.bytes.byteLength}`);
        h.set("content-length", "0");
        h.set("cache-control", "no-store, no-transform");
        return new Response(null, { status: 416, headers: h });
      }
      if (range) {
        headers.set("content-range", `bytes ${range.start}-${range.end}/${body.bytes.byteLength}`);
        headers.set("content-length", String(range.end - range.start + 1));
        // `Content-Range` describes the bytes as they are stored. A proxy or framework that gzips the body
        // under it would hand a resuming client a slice of a DIFFERENT byte stream, and the file is corrupt.
        headers.set("cache-control", `${headers.get("cache-control") ?? "public"}, no-transform`);
        if (method === "HEAD") return new Response(null, { status: 206, headers });
        return new Response(body.bytes.subarray(range.start, range.end + 1) as unknown as BodyInit, { status: 206, headers });
      }
      if (method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(body.bytes as unknown as BodyInit, { status: 200, headers });
    } catch (err) {
      if (err instanceof GatewayError) {
        // Bots that walk nonexistent hosts are absorbed by the edge for a few seconds. Only the 404s that
        // mean "nothing lives at this address", and never `stale-while-revalidate`: after the TTL the next
        // request is a real answer, not a stale one.
        if (err.status === 404 && err.negativeCacheable && notFoundTtl > 0) {
          const ttl = Math.min(notFoundTtl, err.negativeTtl ?? notFoundTtl);
          return text(err.message, 404, { "cache-control": `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=0` });
        }
        // An upstream that could not be read is the one failure a client should retry, and a cache must not keep.
        if (err.status === 503) return text(err.message, 503, { "retry-after": "5" });
        // A file over the limit, in a codec this gateway cannot decode, or whose decoded content does not match its
        // hash: each is a fact about immutable bytes, so it is cached rather than recomputed (and the chunks re-read)
        // on every hit, and the visitor is told which one it is.
        if (err.edgeTtl) {
          return text(err.message, err.status, { "cache-control": `public, max-age=0, s-maxage=${err.edgeTtl}, stale-while-revalidate=0`, vary: "Range" });
        }
        // A server-side configuration fault (a chain with no RPC, a missing default) is the OPERATOR's to read,
        // in the log. The visitor gets a generic body: never an environment variable's name.
        if (err.status >= 500) {
          logError(`configuration or upstream fault (status ${err.status}): ${scrub(err)}`);
          return text("this gateway cannot serve that right now", err.status, err.status === 500 ? {} : { "retry-after": "5" });
        }
        return text(err.message, err.status);
      }
      // The detail of an upstream failure can carry the RPC URL, API key included (viem embeds it).
      // It goes to the operator's log, scrubbed, and never to the visitor.
      logError(scrub(err));
      return text("upstream error", 502);
    }
  }

  /** `handle` under the per-request deadline: a hung upstream becomes a retryable 503, never an open connection. */
  async function handleWithDeadline(request: Request): Promise<Response> {
    if (!(requestTimeoutMs > 0)) return handle(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        logError(`request exceeded its ${requestTimeoutMs}ms deadline (upstream too slow or hung)`);
        resolve(text("the chain could not be read in time; retry shortly", 503, { "retry-after": "5" }));
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([handle(request), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!options.cors) return handleWithDeadline;
  // Content is public and carries no credentials, so letting any page read it is how a public gateway
  // behaves; it is what lets the app's own viewers and the publish check read a project's host.
  return async (request) => {
    const res = await handleWithDeadline(request);
    const headers = new Headers(res.headers);
    headers.set("access-control-allow-origin", options.cors!);
    headers.set("access-control-expose-headers", "x-abxfs-root, etag, content-range, accept-ranges");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * A single `Range` the file reader can answer itself: `bytes=a-b`, `bytes=a-` or `bytes=-n` (a file's length is
 * known before any chunk is read). Null for everything else (several ranges, another unit, noise: the whole file) and
 * for an `If-Range` that is not this representation's ETag.
 */
export function rangeSpecOf(header: string | null, ifRange: string | null, etag: string): RangeSpec | null {
  if (!header) return null;
  if (ifRange !== null && ifRange.trim() !== etag) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "") return b === "" ? null : { suffix: Number(b) };
  const start = Number(a);
  if (b === "") return { start };
  const end = Number(b);
  return end < start ? null : { start, end };
}

/** The host a request was sent to, as the browser named it: what host mode routes on, and where a listing links. */
function requestHost(request: Request, url: URL): string {
  return request.headers.get("host") ?? url.host;
}

/** `?start=N` on a directory listing: canonical digits only (a second spelling of an entry index is not honoured). */
function parseListingStart(url: URL): number {
  const raw = url.searchParams.get("start");
  return raw !== null && /^(0|[1-9]\d{0,8})$/.test(raw) ? Number(raw) : 0;
}

/**
 * The byte range a `Range` header asks for, `"unsatisfiable"` (416), or null (serve everything). Single
 * `bytes=a-b`, `bytes=a-` and `bytes=-n` only.
 */
export function byteRange(
  header: string | null,
  ifRange: string | null,
  etag: string,
  length: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  // A validator that is not this representation's ETag (a date, a weak tag, someone else's) voids the range.
  if (ifRange !== null && ifRange.trim() !== etag) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m) return null; // another unit, several ranges (a comma), or noise: the whole file
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "" && b === "") return null;
  if (a === "") {
    // suffix: the last n bytes
    const n = Number(b);
    if (n === 0 || length === 0) return "unsatisfiable";
    return { start: Math.max(0, length - n), end: length - 1 };
  }
  const start = Number(a);
  if (b !== "" && Number(b) < start) return null; // syntactically invalid: ignored
  if (start >= length) return "unsatisfiable";
  const end = b === "" ? length - 1 : Math.min(Number(b), length - 1);
  return { start, end };
}

function requireDefault(id: number): number {
  if (Number.isSafeInteger(id) && id > 0) return id;
  throw new GatewayError("this gateway has no default chain configured for root requests", 500);
}

/** Remove anything URL-shaped from an error before it is logged anywhere. */
export function scrub(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, "<url>").slice(0, 600);
}

/**
 * A content domain as the host-mode router compares it: a bare host and optional port, lowercased. Throws for anything
 * else (a URL, a path, a wildcard), naming `name`, the option or flag it came from: `abxfs-gateway` checks its
 * `--content-domain` with this before any chain is read, so the flag and the option can never disagree.
 */
export function normalizeBaseHost(host: string, name = "hostMode.baseHost"): string {
  const h = host.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/.test(h)) {
    throw new Error(`${name} must be a bare host (and optional port), got "${host}"`);
  }
  return h;
}

function normalizeBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeProject(p: NonNullable<GatewayOptions["project"]>): { chainId: number; addressing: Addressing } {
  if (!Number.isSafeInteger(p.chainId) || p.chainId < 1) throw new Error(`invalid project chain id: ${p.chainId}`);
  const org = parseOrg(p.org);
  const tokenId = BigInt(p.tokenId);
  if (tokenId < 0n) throw new Error(`invalid project token id: ${p.tokenId}`);
  if (p.version !== undefined && (!Number.isSafeInteger(p.version) || p.version < 1)) {
    throw new Error(`invalid project version: ${p.version}`);
  }
  const addressing: Addressing =
    p.tag !== undefined
      ? { kind: "tag", org, tokenId, tag: p.tag }
      : p.version !== undefined
        ? { kind: "version", org, tokenId, version: p.version }
        : { kind: "latest", org, tokenId };
  return { chainId: p.chainId, addressing };
}

/**
 * Does `If-None-Match` name this ETag? A comma-separated list, weak tags compared weakly (RFC 9110 §13.1.2), and `*`
 * (a representation exists: the path was located). An ETag here never holds a comma (the sub-path is
 * percent-encoded), so splitting on commas is exact.
 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const tag = raw.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

/** A failure is never cached: a 404 here is usually "not published yet", which changes. */
function text(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}

/**
 * 451 rather than 404: the content exists, is findable, and this gateway is declining to serve it.
 * RFC 7725 defines both the code and the `blocked-by` relation, but who is declining is the
 * operator's to say, so no link is added here.
 */
function refusal(message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status: 451,
    headers: {
      ...extra,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Redirect a directory URL to its trailing-slash form. A 307 rather than a 301: a permanent redirect on a
 * path that may later serve a file sticks in a browser cache and cannot be cleared without clearing site
 * data.
 *
 * Only a path that IS a directory in the root is redirected (the caller has already located it), so a
 * path that names nothing is a plain 404 with no hop, and a directory whose name has a dot (`v1.2/`)
 * still gets its slash.
 *
 * The target is built from the already-validated path, and is refused outright if its PATH could be read as
 * anything but a path on THIS origin (`//host`, a backslash): the audit found `/.//host` becoming
 * `Location: //host/`. The query cannot move the host (it comes after the path), so a backslash in it is
 * percent-encoded rather than refused: `/dir?x=a\b` is the same 307 as `/dir?x=1`.
 */
function directoryRedirect(url: URL, located: Located): Response | null {
  if (url.pathname.endsWith("/")) return null;
  if (!located.directory) return null;

  const path = `/${url.pathname.replace(/^\/+/, "")}/`;
  if (path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) {
    throw new GatewayError("bad request path", 400);
  }
  const location = `${path}${url.search.replace(/\\/g, "%5C").replace(/[\r\n]/g, "")}`;
  return new Response(null, { status: 307, headers: { location, "cache-control": "no-store" } });
}
