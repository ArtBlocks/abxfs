/**
 * Unit tests for the Pinata provider (v3 Files API) with a stubbed fetch.
 */
import { describe, expect, it, vi } from "vitest";
import type { IpfsCid } from "@artblocks/abxfs-sdk";

import { pinataPinningProvider } from "../../src/providers/pinata.js";

const ROOT = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354" as IpfsCid;
const OTHER = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as IpfsCid;
const CAR = new Blob([new Uint8Array([9, 8, 7])], { type: "application/vnd.ipld.car" });

/**
 * The multipart form a provider sent. The body is a stream of known length (so its upload progress can be watched),
 * not a FormData: parse it the way a server would.
 */
async function formOf(init: RequestInit | undefined): Promise<FormData> {
  const headers = init?.headers as Record<string, string>;
  expect(Number(headers["content-length"])).toBeGreaterThan(0);
  return new Response(init?.body as BodyInit, { headers: { "content-type": headers["content-type"]! } }).formData();
}

const asUrl = (input: URL | RequestInfo) => new URL(typeof input === "string" ? input : (input as URL).toString());

describe("pinataPinningProvider", () => {
  it("uploads the CAR to uploads.pinata.cloud/v3/files as a public raw CAR with bearer auth", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(asUrl(input).toString()).toBe("https://uploads.pinata.cloud/v3/files");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-jwt");
      const body = await formOf(init);
      expect(body.get("network")).toBe("public");
      expect(body.get("car")).toBe("true");
      expect(body.get("name")).toBe("site");
      const file = body.get("file") as File;
      expect(file.name).toBe("site.car");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
      return new Response(JSON.stringify({ data: { id: "0191-abc", cid: ROOT } }), { status: 200 });
    });
    const provider = pinataPinningProvider({ apiKey: "test-jwt", fetch: fakeFetch as unknown as typeof fetch });
    await expect(provider.pinCar({ root: ROOT, car: CAR, name: "site" })).resolves.toEqual({ pinnedCid: ROOT });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("returns the cid Pinata reports, even when it is not the CAR's root (the orchestrator checks)", async () => {
    const provider = pinataPinningProvider({
      apiKey: "jwt",
      fetch: (async () => new Response(JSON.stringify({ data: { cid: OTHER } }), { status: 200 })) as unknown as typeof fetch,
    });
    expect((await provider.pinCar({ root: ROOT, car: CAR, name: ROOT })).pinnedCid).toBe(OTHER);
  });

  it("throws on an HTTP error and on a reply without data.cid", async () => {
    const failing = pinataPinningProvider({
      apiKey: "jwt",
      fetch: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(failing.pinCar({ root: ROOT, car: CAR, name: ROOT })).rejects.toThrow(/upload failed: 403 nope/);
    const empty = pinataPinningProvider({
      apiKey: "jwt",
      fetch: (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(empty.pinCar({ root: ROOT, car: CAR, name: ROOT })).rejects.toThrow(/no data.cid/);
  });

  it("a custom endpoint stands in for both hosts unless the upload host is given", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (input: URL | RequestInfo) => {
      seen.push(asUrl(input).origin);
      return new Response(JSON.stringify({ data: { cid: ROOT, files: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await pinataPinningProvider({ apiKey: "jwt", endpoint: "https://proxy.example", fetch: fakeFetch }).pinCar({ root: ROOT, car: CAR, name: ROOT });
    await pinataPinningProvider({
      apiKey: "jwt",
      endpoint: "https://proxy.example",
      uploadEndpoint: "https://up.example",
      fetch: fakeFetch,
    }).pinCar({ root: ROOT, car: CAR, name: ROOT });
    expect(seen).toEqual(["https://proxy.example", "https://up.example"]);
  });

  it("isPinned lists public files filtered by cid", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = asUrl(input);
      expect(url.origin + url.pathname).toBe("https://api.pinata.cloud/v3/files/public");
      expect(url.searchParams.get("cid")).toBe(ROOT);
      expect(url.searchParams.get("limit")).toBe("1");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ data: { files: [{ id: "0191-abc", cid: ROOT }], next_page_token: "" } }), { status: 200 });
    });
    const provider = pinataPinningProvider({ apiKey: "jwt", fetch: fakeFetch as unknown as typeof fetch });
    expect(await provider.isPinned(ROOT)).toBe(true);
  });

  it("isPinned is false for no match, a mismatched cid, or an error", async () => {
    const reply = (body: unknown, status = 200) =>
      pinataPinningProvider({ apiKey: "jwt", fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });
    expect(await reply({ data: { files: [] } }).isPinned(ROOT)).toBe(false);
    expect(await reply({ data: { files: [{ id: "x", cid: OTHER }] } }).isPinned(ROOT)).toBe(false);
    expect(await reply({}, 500).isPinned(ROOT)).toBe(false);
  });

  it("unpin deletes every public file under the cid, following pages", async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = asUrl(input);
      calls.push(`${init?.method} ${url.pathname}${url.searchParams.get("pageToken") ? `?page=${url.searchParams.get("pageToken")}` : ""}`);
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const page = url.searchParams.get("pageToken");
      const body = page
        ? { data: { files: [{ id: "id-2", cid: ROOT }], next_page_token: "" } }
        : { data: { files: [{ id: "id-1", cid: ROOT }, { id: "id-x", cid: OTHER }], next_page_token: "p2" } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const provider = pinataPinningProvider({ apiKey: "jwt", fetch: fakeFetch as unknown as typeof fetch });
    await provider.unpin(ROOT);
    expect(calls).toEqual([
      "GET /v3/files/public",
      "GET /v3/files/public?page=p2",
      "DELETE /v3/files/public/id-1",
      "DELETE /v3/files/public/id-2",
    ]);
  });

  it("unpin refuses a file id that is not Pinata-shaped before it reaches a URL", async () => {
    const fakeFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new Error("should not delete");
      return new Response(JSON.stringify({ data: { files: [{ id: "../admin", cid: ROOT }] } }), { status: 200 });
    });
    const provider = pinataPinningProvider({ apiKey: "jwt", fetch: fakeFetch as unknown as typeof fetch });
    await expect(provider.unpin(ROOT)).rejects.toThrow(/unexpected file id/);
  });
});
