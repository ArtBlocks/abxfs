/**
 * Delta audit (pinning): the dispatcher that replaces undici's implicit timeouts, and the branches the audit's coverage
 * found unreached: an invalid URL, a cancelled upload, a request without a body, a redirect through an injected fetch,
 * a body that fails mid-read, a reply that is not JSON, Kubo's and Pinata's error answers, and Pinata's early stop.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpfsCid } from "@artblocks/abxfs-sdk";

import { UNDICI_GLOBAL_DISPATCHER, UNDICI_GLOBAL_DISPATCHER_2, httpClient, jsonOf, undiciGlobalDispatcher, undiciRuntime } from "../src/http.js";
import { localPinningProvider } from "../src/providers/local.js";
import { pinataPinningProvider } from "../src/providers/pinata.js";

const ROOT = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" as IpfsCid;
const g = globalThis as unknown as Record<symbol, unknown>;

describe("the dispatcher for Node's own fetch", () => {
  const realFetch = globalThis.fetch;
  const saved = { one: g[UNDICI_GLOBAL_DISPATCHER], two: g[UNDICI_GLOBAL_DISPATCHER_2], version: undiciRuntime.version };
  /** Run as if Node's own undici were `version` (`6.23.0` is Node 22's, `7.28.0` Node 24's, `8.9.0` Node 26's). */
  const asUndici = (version: string | undefined) => (undiciRuntime.version = () => version);
  beforeEach(() => asUndici("8.9.0"));
  afterEach(() => {
    globalThis.fetch = realFetch;
    g[UNDICI_GLOBAL_DISPATCHER] = saved.one;
    g[UNDICI_GLOBAL_DISPATCHER_2] = saved.two;
    undiciRuntime.version = saved.version;
  });

  /** The global dispatcher as undici 7+ keeps it (Node 24 and 26): under `.2`, with nothing under `.1`. */
  function setGlobal(d: unknown): void {
    g[UNDICI_GLOBAL_DISPATCHER_2] = d;
    g[UNDICI_GLOBAL_DISPATCHER] = undefined;
  }

  /** Stub the global fetch (so `httpClient()` picks it up as Node's own) and record the init each request gets. */
  function stubFetch(): Array<RequestInit & { dispatcher?: unknown }> {
    const inits: Array<RequestInit & { dispatcher?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "data:,") return new Response("");
      inits.push(init as RequestInit);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return inits;
  }

  it("on undici 7 and later (Node 24 and 26) the lookup reads `.2` first and falls back to `.1`", () => {
    const two = { v: 2 };
    const one = { v: 1 };
    for (const version of ["7.0.0", "7.28.0", "8.9.0", "10.0.0"]) {
      asUndici(version);
      g[UNDICI_GLOBAL_DISPATCHER_2] = two;
      g[UNDICI_GLOBAL_DISPATCHER] = one;
      expect(undiciGlobalDispatcher()).toBe(two);
      g[UNDICI_GLOBAL_DISPATCHER_2] = undefined;
      expect(undiciGlobalDispatcher()).toBe(one);
      g[UNDICI_GLOBAL_DISPATCHER] = undefined;
      expect(undiciGlobalDispatcher()).toBeUndefined();
    }
  });

  it("on undici 6 (Node 22), or with no version at all, the lookup reads `.1` ONLY, whatever is under `.2`", () => {
    // What merely require()-ing undici 8 does to a Node 22 process: its own Agent under `.2`, a wrapper under `.1`.
    const two = { v: 2 };
    const one = { v: 1 };
    for (const version of ["6.23.0", "6.0.0", "5.28.4", undefined, "", "not a version"]) {
      asUndici(version);
      g[UNDICI_GLOBAL_DISPATCHER_2] = two;
      g[UNDICI_GLOBAL_DISPATCHER] = one;
      expect(undiciGlobalDispatcher()).toBe(one);
      g[UNDICI_GLOBAL_DISPATCHER] = undefined;
      expect(undiciGlobalDispatcher()).toBeUndefined();
    }
  });

  it("the version is Node's own by default: `process.versions.undici`", () => {
    undiciRuntime.version = saved.version;
    expect(undiciRuntime.version()).toBe(process.versions.undici);
  });

  it("Node 22 with undici 8 loaded: the undici 8 Agent under `.2` is never handed to fetch; the wrapper under `.1` is left alone", async () => {
    asUndici("6.23.0");
    const made: object[] = [];
    class Agent {
      constructor(readonly opts?: object) {
        if (opts) made.push(opts);
      }
    }
    class Dispatcher1Wrapper {}
    g[UNDICI_GLOBAL_DISPATCHER_2] = new Agent();
    g[UNDICI_GLOBAL_DISPATCHER] = new Dispatcher1Wrapper();
    const inits = stubFetch();
    const r = await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(r.status).toBe(200);
    expect(made).toEqual([]);
    expect(inits[0]).not.toHaveProperty("dispatcher");
  });

  it("a plain Agent is replaced by one of its own class with the watchdog's timeouts", async () => {
    const made: object[] = [];
    class Agent {
      constructor(readonly opts: object) {
        made.push(opts);
      }
    }
    setGlobal(new Agent({ mine: true }));
    made.length = 0;
    const inits = stubFetch();
    const http = httpClient({ timeouts: { connectMs: 1234 } });
    await http.request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    await http.request({ provider: "p", what: "w", url: "http://127.0.0.1:1/y", method: "GET" });
    // One dispatcher for the client, made on the first request; the global Agent's own options are not carried over.
    expect(made).toEqual([{ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 1234 }]);
    expect(inits[0]!.dispatcher).toBeInstanceOf(Agent);
    expect(inits[1]!.dispatcher).toBe(inits[0]!.dispatcher);
  });

  it("Node 26: the Agent under `.2` is the one replaced, not the compatibility wrapper under `.1`", async () => {
    class Agent {
      constructor(readonly opts?: object) {}
    }
    class Dispatcher1Wrapper {}
    g[UNDICI_GLOBAL_DISPATCHER_2] = new Agent();
    g[UNDICI_GLOBAL_DISPATCHER] = new Dispatcher1Wrapper();
    const inits = stubFetch();
    await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(inits[0]!.dispatcher).toBeInstanceOf(Agent);
  });

  it("Node 22: an Agent under `.1` alone is still found and replaced", async () => {
    asUndici("6.23.0");
    class Agent {
      constructor(readonly opts?: object) {}
    }
    g[UNDICI_GLOBAL_DISPATCHER_2] = undefined;
    g[UNDICI_GLOBAL_DISPATCHER] = new Agent();
    const inits = stubFetch();
    await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(inits[0]!.dispatcher).toBeInstanceOf(Agent);
  });

  it("any other global dispatcher (a ProxyAgent, a MockAgent) is left alone: no dispatcher is passed", async () => {
    class ProxyAgent {}
    setGlobal(new ProxyAgent());
    const inits = stubFetch();
    await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(inits[0]).not.toHaveProperty("dispatcher");
  });

  it("a dispatcher class whose constructor throws falls back to fetch's defaults", async () => {
    class Agent {
      constructor(opts?: object) {
        if (opts) throw new Error("unsupported option");
      }
    }
    setGlobal(new Agent());
    const inits = stubFetch();
    await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(inits[0]).not.toHaveProperty("dispatcher");
  });

  it("when no request has installed the global dispatcher yet, a data: fetch installs it first", async () => {
    setGlobal(undefined);
    const seen: string[] = [];
    class Agent {}
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      if (String(url) === "data:,") {
        g[UNDICI_GLOBAL_DISPATCHER_2] = new Agent(); // what Node does on its first fetch
        return new Response("");
      }
      return new Response("{}");
    }) as typeof fetch;
    await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(seen).toEqual(["data:,", "http://127.0.0.1:1/x"]);
  });

  it("a fetch that refuses the data: URL leaves fetch's defaults, and the request still goes out", async () => {
    setGlobal(undefined);
    const seen: Array<{ url: string; dispatcher: unknown }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      seen.push({ url: String(url), dispatcher: init?.dispatcher });
      if (String(url) === "data:,") throw new TypeError("fetch failed: data: URLs are not allowed here");
      return new Response("{}");
    }) as typeof fetch;
    const r = await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:1/x", method: "GET" });
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(["data:,", "http://127.0.0.1:1/x"]);
    expect(seen[1]!.dispatcher).toBeUndefined();
  });

  it("in a real Node process (whatever Node runs this): no global dispatcher before the first fetch, and the client replaces Node's Agent", () => {
    // The module as Node runs it, transpiled on its own (it imports nothing), in a child so this process's dispatcher
    // state does not matter. The child asserts THROUGH the exported lookup: on Node 26 the old `.1` read found a wrapper
    // and silently passed no dispatcher.
    const dir = mkdtempSync(join(tmpdir(), "abxfs-pinning-http-"));
    const src = readFileSync(join(__dirname, "../src/http.ts"), "utf8");
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = join(dir, "http.mjs");
    writeFileSync(mod, js);
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { httpClient, undiciGlobalDispatcher } = await import(${JSON.stringify(pathToFileURL(mod).href)});
         void globalThis.fetch;
         const before = typeof undiciGlobalDispatcher();
         // Only now: on Node 24 loading node:http installs the global dispatcher too.
         const { createServer } = await import("node:http");
         const realFetch = globalThis.fetch;
         let used;
         globalThis.fetch = (url, init) => { if (String(url) !== "data:,") used = init?.dispatcher; return realFetch(url, init); };
         const server = createServer((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
         await new Promise((r) => server.listen(0, "127.0.0.1", r));
         const r = await httpClient().request({ provider: "p", what: "w", url: "http://127.0.0.1:" + server.address().port + "/", method: "GET" });
         server.close();
         const global = undiciGlobalDispatcher();
         console.log(JSON.stringify({ before, status: r.status, global: global?.constructor?.name, used: used?.constructor?.name, sameClass: used?.constructor === global?.constructor, fresh: used !== undefined && used !== global }));`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(JSON.parse(out)).toEqual({ before: "undefined", status: 200, global: "Agent", used: "Agent", sameClass: true, fresh: true });
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

describe("httpClient branches", () => {
  it("an invalid URL is named as such, not quoted", async () => {
    const http = httpClient({ fetch: (async () => Promise.reject(new TypeError("Invalid URL"))) as unknown as typeof fetch });
    await expect(http.request({ provider: "kubo", what: "pin/ls", url: "not a url ?key=SECRET", method: "GET" })).rejects.toThrow(
      /kubo pin\/ls at \(invalid url\) failed: Invalid URL/,
    );
  });

  it("a request without a body is bounded by connect + response time", async () => {
    vi.useFakeTimers();
    try {
      let aborted: unknown;
      const http = httpClient({
        timeouts: { connectMs: 10, responseMs: 20 },
        fetch: ((_: unknown, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal!.addEventListener("abort", () => {
              aborted = init.signal!.reason;
              reject(init.signal!.reason);
            });
          })) as unknown as typeof fetch,
      });
      const p = http.request({ provider: "kubo", what: "pin/ls", url: "http://127.0.0.1:1/", method: "GET" });
      const settled = expect(p).rejects.toThrow(/timed out: no response within 0.03s/);
      await vi.advanceTimersByTimeAsync(31);
      await settled;
      expect(String(aborted)).toMatch(/no response within/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fetch that cancels the upload body cancels the Blob's stream too", async () => {
    let cancelled = false;
    const http = httpClient({
      fetch: (async (_: unknown, init: RequestInit) => {
        const body = init.body as ReadableStream<Uint8Array>;
        const reader = body.getReader();
        await reader.read();
        await reader.cancel("enough");
        cancelled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await http.request({
      provider: "kubo",
      what: "dag/import",
      url: "http://127.0.0.1:1/",
      method: "POST",
      body: { blob: new Blob([new Uint8Array(200_000)]), contentType: "application/octet-stream" },
    });
    expect(res.ok).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("an injected fetch that follows no rule and returns a redirect is refused, its body cancelled", async () => {
    let bodyCancelled = false;
    const http = httpClient({
      fetch: (async () =>
        new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 307, headers: { location: "https://elsewhere.example/" } },
        )) as unknown as typeof fetch,
    });
    await expect(http.request({ provider: "pinata", what: "upload", url: "https://api.pinata.cloud/x", method: "GET" })).rejects.toThrow(
      /answered with a redirect \(307\), which is never followed/,
    );
    expect(bodyCancelled).toBe(true);
  });

  it("a body that fails mid-read is reported with its code", async () => {
    const http = httpClient({
      fetch: (async () =>
        new Response(
          new ReadableStream({
            pull(ctl) {
              ctl.error(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }));
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(http.request({ provider: "kubo", what: "pin/ls", url: "http://127.0.0.1:1/", method: "GET" })).rejects.toThrow(
      /kubo pin\/ls at 127\.0\.0\.1:1: reading the response failed: other side closed \(UND_ERR_SOCKET\)/,
    );
  });

  it("a reply that is not JSON is refused, quoting it in part", () => {
    expect(() => jsonOf({ status: 200, ok: true, text: "<html>gateway error</html>", truncated: false }, "[x] list")).toThrow(
      /\[x\] list: the response is not JSON: <html>gateway error<\/html>/,
    );
  });
});

describe("provider error answers", () => {
  const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("Kubo: an unpin that fails with anything but 404 is an error", async () => {
    const p = localPinningProvider({ endpoint: "http://localhost:5001", fetch: reply(500, "datastore closed") });
    await expect(p.unpin(ROOT)).rejects.toThrow(/kubo unpin failed: 500 datastore closed/);
  });

  it("Pinata: a key check that fails without 401/403 says so; an unpin delete that fails is an error", async () => {
    await expect(pinataPinningProvider({ apiKey: "jwt", fetch: reply(503, "maintenance") }).preflight!()).rejects.toThrow(
      /pinata key check failed: 503 maintenance/,
    );
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: { files: [{ id: "file-1", cid: ROOT }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(pinataPinningProvider({ apiKey: "jwt", fetch: fakeFetch }).unpin(ROOT)).rejects.toThrow(/pinata unpin failed: 500 boom/);
  });

  it("Pinata: isPinned stops at the first match, without reading the pages after it", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { files: [{ id: "file-1", cid: ROOT }], next_page_token: "more" } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await pinataPinningProvider({ apiKey: "jwt", fetch: fakeFetch }).isPinned(ROOT)).toBe(true);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("1");
  });
});

void createServer;
void (null as unknown as AddressInfo);
