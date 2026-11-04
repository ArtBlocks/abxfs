/**
 * The pinning providers against real local HTTP servers that misbehave (CLI audit F7, F15): an endless body, an
 * upload the server never reads, a server that never answers, a slow but healthy link, a redirect to another origin,
 * a refused connection. Every one must end in bounded time and memory, with an error that names the host and the
 * network error's code, and a slow upload that keeps moving must succeed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AbxfsCid, AbxfsClient, IpfsCid } from "@abxfs/sdk";

import { MAX_RESPONSE_BYTES } from "../src/http.js";
import { pinDirectory } from "../src/pin.js";
import { localPinningProvider } from "../src/providers/local.js";
import { MAX_LIST_PAGES, pinataPinningProvider } from "../src/providers/pinata.js";
import type { PinningProvider } from "../src/types.js";

const ROOT = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" as IpfsCid;
const importReply = JSON.stringify({ Root: { Cid: { "/": ROOT }, PinErrorMsg: "" } }) + "\n";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Answer forever: 1 MiB chunks as fast as the client takes them. Records whether the client hung up. */
function endless(status: number, state: { closed: boolean }) {
  const chunk = Buffer.alloc(1 << 20, 0x61);
  return (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.on("close", () => (state.closed = true));
      const pump = () => {
        while (!state.closed && res.write(chunk)) {
          /* keep writing */
        }
        if (!state.closed) res.once("drain", pump);
      };
      pump();
    });
  };
}

const car = (bytes: number) => new Blob([new Uint8Array(bytes)]);

/** A local port nothing listens on (fetch refuses the "bad" low ports outright, so port 9 would not do). */
async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

describe("F7: response bodies are read through a cap", () => {
  it("an endless 200 body is cut off at 1 MiB: bounded time and memory, and the connection is dropped", async () => {
    const state = { closed: false };
    const url = await serve(endless(200, state));
    const before = process.memoryUsage().arrayBuffers;
    const t = Date.now();
    const err = await localPinningProvider({ endpoint: url }).pinCar({ root: ROOT, car: car(10), name: "x" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no Root in the response \(it was cut off at 1 MiB\)/);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 100));
    expect(state.closed).toBe(true);
  });

  it("an endless error body is quoted in part, and the message stays short", async () => {
    const state = { closed: false };
    const url = await serve(endless(500, state));
    const t = Date.now();
    const err = await localPinningProvider({ endpoint: url }).pinCar({ root: ROOT, car: car(10), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/dag\/import failed: 500 a+… \(truncated\)/);
    expect((err as Error).message.length).toBeLessThan(800);
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it("a JSON reply past the cap is refused, not parsed (Pinata)", async () => {
    const state = { closed: false };
    const url = await serve(endless(200, state));
    const err = await pinataPinningProvider({ apiKey: "jwt", endpoint: url }).pinCar({ root: ROOT, car: car(10), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(new RegExp(`larger than ${MAX_RESPONSE_BYTES} bytes`));
  });
});

describe("F7: progress-based timeouts", () => {
  it("a slow but progressing upload succeeds, even though it takes far longer than the stall and response limits", async () => {
    let got = 0;
    const url = await serve((req, res) => {
      req.on("data", (c: Buffer) => {
        got += c.length;
        req.pause();
        setTimeout(() => req.resume(), 25); // ~ a few MiB/s: always moving, never fast
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(importReply);
      });
    });
    const size = 12 * 1024 * 1024;
    const t = Date.now();
    const p = localPinningProvider({ endpoint: url, timeouts: { stallMs: 1_000, responseMs: 2_500, connectMs: 2_000 } });
    await expect(p.pinCar({ root: ROOT, car: car(size), name: "x" })).resolves.toEqual({ pinnedCid: ROOT });
    expect(Date.now() - t).toBeGreaterThan(3_500); // longer than both limits together: neither is measured from the start
    expect(got).toBeGreaterThanOrEqual(size);
  }, 30_000);

  it("a request that ended leaves no timer behind (a stalled one once held the process open for 300 s)", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const url = await serve(() => {
      /* never read, never answer */
    });
    const before = timers();
    const p = localPinningProvider({ endpoint: url, timeouts: { stallMs: 200, responseMs: 300_000, connectMs: 2_000 } });
    await expect(p.pinCar({ root: ROOT, car: car(64 * 1024 * 1024), name: "x" })).rejects.toThrow(/stalled/);
    await new Promise((r) => setTimeout(r, 300));
    expect(timers()).toBeLessThanOrEqual(before);
  }, 30_000);

  it("a stalled upload (the server never reads) times out, naming the host and how far it got", async () => {
    const url = await serve(() => {
      /* never read, never answer */
    });
    const t = Date.now();
    const p = localPinningProvider({ endpoint: url, timeouts: { stallMs: 300, responseMs: 60_000, connectMs: 2_000 } });
    const err = await p.pinCar({ root: ROOT, car: car(64 * 1024 * 1024), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/kubo dag\/import at 127\.0\.0\.1:\d+ timed out: the upload stalled: no progress for 0\.3s \(\d+ of \d+ bytes sent\)/);
    expect(Date.now() - t).toBeLessThan(10_000);
  }, 30_000);

  it("a server that takes the upload and never answers times out on the response, counted from the upload's end", async () => {
    const url = await serve((req) => req.resume());
    const p = localPinningProvider({ endpoint: url, timeouts: { stallMs: 5_000, responseMs: 300, connectMs: 2_000 } });
    const err = await p.pinCar({ root: ROOT, car: car(1024), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/timed out: no response within 0\.3s of the upload finishing/);
  });

  it("a response body that stops moving times out", async () => {
    const url = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"Root":'); // and nothing more, ever
      });
    });
    const p = localPinningProvider({ endpoint: url, timeouts: { stallMs: 300, responseMs: 5_000, connectMs: 2_000 } });
    const err = await p.pinCar({ root: ROOT, car: car(16), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/timed out: the response stalled/);
  });
});

describe("F7: redirects and network errors", () => {
  it("a redirect is never followed: the key never reaches the second origin", async () => {
    let seen = false;
    const other = await serve((req, res) => {
      seen = true;
      req.resume();
      res.end(JSON.stringify({ data: { cid: ROOT } }));
    });
    const first = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(307, { location: `${other}/captured` });
        res.end();
      });
    });
    const err = await pinataPinningProvider({ apiKey: "SECRET-JWT-VALUE", endpoint: first }).pinCar({ root: ROOT, car: car(4), name: "n" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/pinata upload at 127\.0\.0\.1:\d+ failed: .*redirect/i);
    expect((err as Error).message).not.toContain("SECRET-JWT-VALUE");
    expect(seen).toBe(false);
  });

  it("a refused connection names the host and the error code", async () => {
    const endpoint = await closedPort();
    const err = await localPinningProvider({ endpoint }).pinCar({ root: ROOT, car: car(4), name: "x" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/kubo dag\/import at 127\.0\.0\.1:\d+ failed: .*\(ECONNREFUSED\)/);
  });
});

describe("F15: providers are checked before anything is derived", () => {
  it("Kubo: /api/v0/version must answer with a Version", async () => {
    const ok = await serve((req, res) => {
      expect(req.url).toBe("/api/v0/version");
      expect(req.method).toBe("POST");
      res.end(JSON.stringify({ Version: "0.30.0" }));
    });
    await expect(localPinningProvider({ endpoint: ok }).preflight!()).resolves.toBeUndefined();
    const notKubo = await serve((_req, res) => res.end("<html>hello</html>"));
    await expect(localPinningProvider({ endpoint: notKubo }).preflight!()).rejects.toThrow(/without a Version/);
    const missing = await serve((_req, res) => {
      res.statusCode = 404;
      res.end("404 page not found");
    });
    await expect(localPinningProvider({ endpoint: missing }).preflight!()).rejects.toThrow(/not a usable Kubo RPC API: 404/);
    await expect(localPinningProvider({ endpoint: await closedPort() }).preflight!()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("Pinata: a rejected key is said to be one", async () => {
    const url = await serve((req, res) => {
      expect(req.headers.authorization).toBe("Bearer bad-jwt");
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    await expect(pinataPinningProvider({ apiKey: "bad-jwt", endpoint: url }).preflight!()).rejects.toThrow(/rejected the API key \(401\)/);
    const good = await serve((req, res) => {
      expect(req.url).toBe("/v3/files/public?limit=1");
      res.end(JSON.stringify({ data: { files: [] } }));
    });
    await expect(pinataPinningProvider({ apiKey: "good", endpoint: good }).preflight!()).resolves.toBeUndefined();
  });
});

describe("Pinata unpin paging", () => {
  it("deletes what it found and says so when more pages remain than it reads", async () => {
    const deleted: string[] = [];
    let page = 0;
    const url = await serve((req, res) => {
      if (req.method === "DELETE") {
        deleted.push(req.url!);
        res.end();
        return;
      }
      page++;
      res.end(JSON.stringify({ data: { files: [{ id: `id-${page}`, cid: ROOT }], next_page_token: `p${page + 1}` } }));
    });
    const err = await pinataPinningProvider({ apiKey: "jwt", endpoint: url }).unpin(ROOT).catch((e: Error) => e);
    expect((err as Error).message).toMatch(new RegExp(`deleted ${MAX_LIST_PAGES} file\\(s\\).*more remain past ${MAX_LIST_PAGES} pages`));
    expect(deleted.length).toBe(MAX_LIST_PAGES);
    expect(page).toBe(MAX_LIST_PAGES);
  });
});

describe("a tree that fails part way", () => {
  it("a file read failing mid-tree rejects the pin, and nothing is uploaded", async () => {
    const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;
    const entries = [
      { name: "a.txt", cid: c(10), isDirectory: false },
      { name: "b.txt", cid: c(11), isDirectory: false },
    ];
    const client = {
      addresses: {
        chunkStore: "0x0000000000000000000000000000000000000c57",
        directoryStore: "0x0000000000000000000000000000000000000d57",
        fileStore: "0x0000000000000000000000000000000000000f1e",
      },
      publicClient: {
        async readContract({ address, functionName, args }: { address: string; functionName: string; args: [AbxfsCid, bigint?, bigint?] }) {
          if (address.endsWith("0d57")) return functionName === "getEntries" ? entries.slice(Number(args[1]), Number(args[2])) : BigInt(entries.length);
          throw new Error(`the RPC went away reading ${args[0]}`);
        },
      },
    } as unknown as AbxfsClient;
    let uploaded = false;
    const provider: PinningProvider = {
      name: "mock",
      async pinCar({ root }) {
        uploaded = true;
        return { pinnedCid: root };
      },
      async unpin() {},
      async isPinned() {
        return false;
      },
    };
    await expect(pinDirectory({ client, directoryCid: c(1), provider })).rejects.toThrow(/the RPC went away/);
    expect(uploaded).toBe(false);
  });
});
