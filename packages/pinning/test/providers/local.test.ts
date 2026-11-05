/**
 * Unit tests for the Kubo (local) pinning provider with a stubbed fetch.
 */
import { describe, expect, it, vi } from "vitest";
import type { IpfsCid } from "@artblocks/abxfs-sdk";

import { localPinningProvider } from "../../src/providers/local.js";

const ROOT = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354" as IpfsCid;
const CAR = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/vnd.ipld.car" });

/**
 * The multipart form a provider sent. The body is a stream of known length (so its upload progress can be watched),
 * not a FormData: parse it the way a server would.
 */
async function formOf(init: RequestInit | undefined): Promise<FormData> {
  const headers = init?.headers as Record<string, string>;
  expect(Number(headers["content-length"])).toBeGreaterThan(0);
  return new Response(init?.body as BodyInit, { headers: { "content-type": headers["content-type"]! } }).formData();
}

const importReply = (cid: string, pinError = "") =>
  [
    JSON.stringify({ Root: { Cid: { "/": cid }, PinErrorMsg: pinError } }),
    JSON.stringify({ Stats: { BlockCount: 1, BlockBytesCount: 4 } }),
  ].join("\n");

describe("localPinningProvider (Kubo)", () => {
  it("posts the CAR to /api/v0/dag/import with pin-roots and returns the imported root", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input as URL);
      expect(url.origin + url.pathname).toBe("http://localhost:5001/api/v0/dag/import");
      expect(url.searchParams.get("pin-roots")).toBe("true");
      expect(init?.method).toBe("POST");
      const body = await formOf(init);
      const file = body.get("file") as File;
      expect(file.name).toBe(`${ROOT}.car`);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
      return new Response(importReply(ROOT), { status: 200 });
    });
    const provider = localPinningProvider({ endpoint: "http://localhost:5001/", fetch: fakeFetch as unknown as typeof fetch });
    await expect(provider.pinCar({ root: ROOT, car: CAR, name: ROOT })).resolves.toEqual({ pinnedCid: ROOT });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("keeps a path prefix on the endpoint (a node behind a proxy)", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      expect(new URL(input as URL).pathname).toBe("/kubo/api/v0/dag/import");
      return new Response(importReply(ROOT), { status: 200 });
    });
    const provider = localPinningProvider({ endpoint: "https://ipfs.example/kubo", fetch: fakeFetch as unknown as typeof fetch });
    await provider.pinCar({ root: ROOT, car: CAR, name: ROOT });
  });

  it("throws when Kubo could not pin the root (a block missing from the CAR)", async () => {
    const fakeFetch = vi.fn(async () => new Response(importReply(ROOT, "block was not found locally (offline)"), { status: 200 }));
    const provider = localPinningProvider({ endpoint: "http://localhost:5001", fetch: fakeFetch as unknown as typeof fetch });
    await expect(provider.pinCar({ root: ROOT, car: CAR, name: ROOT })).rejects.toThrow(/pinning .* failed: block was not found/);
  });

  it("throws on an HTTP error and on a reply with no Root", async () => {
    const failing = localPinningProvider({
      endpoint: "http://localhost:5001",
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(failing.pinCar({ root: ROOT, car: CAR, name: ROOT })).rejects.toThrow(/dag\/import failed: 500 boom/);
    const empty = localPinningProvider({
      endpoint: "http://localhost:5001",
      fetch: (async () => new Response(JSON.stringify({ Stats: {} }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(empty.pinCar({ root: ROOT, car: CAR, name: ROOT })).rejects.toThrow(/no Root/);
  });

  it("sends custom headers", async () => {
    const fakeFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Basic abc");
      return new Response(importReply(ROOT), { status: 200 });
    });
    const provider = localPinningProvider({
      endpoint: "http://127.0.0.1:5001",
      headers: { Authorization: "Basic abc" },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await provider.pinCar({ root: ROOT, car: CAR, name: ROOT });
  });

  it("unpin posts pin/rm and tolerates 404", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input as URL);
      expect(url.pathname).toBe("/api/v0/pin/rm");
      expect(url.searchParams.get("arg")).toBe(ROOT);
      return new Response("", { status: 404 });
    });
    const provider = localPinningProvider({ endpoint: "http://localhost:5001", fetch: fakeFetch as unknown as typeof fetch });
    await expect(provider.unpin(ROOT)).resolves.toBeUndefined();
  });

  it("isPinned reads pin/ls, and an error status means not pinned", async () => {
    const pinned = localPinningProvider({
      endpoint: "http://localhost:5001",
      fetch: (async (input: URL | RequestInfo) => {
        const url = new URL(input as URL);
        expect(url.pathname).toBe("/api/v0/pin/ls");
        expect(url.searchParams.get("type")).toBe("all");
        return new Response(JSON.stringify({ Keys: { [ROOT]: { Type: "recursive" } } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await pinned.isPinned(ROOT)).toBe(true);
    const notPinned = localPinningProvider({
      endpoint: "http://localhost:5001",
      fetch: (async () => new Response(JSON.stringify({ Message: "not pinned" }), { status: 500 })) as unknown as typeof fetch,
    });
    expect(await notPinned.isPinned(ROOT)).toBe(false);
  });
});
