/**
 * AUDIT 9, L1: on Node the gateway can decode `br` (and `zstd` where `node:zlib` has it) as well as gzip and deflate.
 * `registerNodeCodecs` adds them CAPPED, so a brotli bomb costs the cap and is a cached 413. Its own file: it changes
 * the process-wide codec registry, which `Audit9Codecs` relies on NOT having `br`.
 */
import { brotliCompressSync } from "node:zlib";
import { keccak256 } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { CODEC_BROTLI, codecLabel, getFileCodec, hasFileCodec, rootContentLabel } from "@abxfs/sdk";

import { registerNodeCodecs } from "../../src/codecs.js";
import { createGateway } from "../../src/handler.js";
import { FakeChain } from "../fake-chain.js";

let names: string[] = [];
beforeAll(async () => {
  names = await registerNodeCodecs({ maxOutputBytes: 1024 * 1024 });
});

function serve(stored: Uint8Array, outputHash: string) {
  const fc = new FakeChain();
  const { cid } = fc.addFile([stored], "text/plain");
  const inner = fc.client as { readContract: (a: { functionName: string }) => Promise<unknown> };
  const client = { ...(inner as object), readContract: async (a: { functionName: string }) => { const r = await inner.readContract(a); return a.functionName === "getFileInfo" ? { ...(r as object), codec: codecLabel("br"), outputHash } : r; } };
  // createGateway puts the platform's streaming gzip/deflate back on top; br stays the capped Node one.
  const gw = createGateway({ chains: [{ id: 84532, contracts: fc.contracts, client } as never], hostMode: { baseHost: "c.example" }, maxFileBytes: 4 * 1024 * 1024, onError: () => {} });
  const host = `${rootContentLabel(84532, cid)}.c.example`;
  return { fc, get: () => gw(new Request(`https://${host}/`, { headers: { host } })) };
}

describe("registerNodeCodecs", () => {
  it("registers br (and the others Node has)", () => {
    expect(names).toEqual(expect.arrayContaining(["gzip", "deflate", "br"]));
    expect(hasFileCodec(CODEC_BROTLI)).toBe(true);
  });

  it("a br file is served", async () => {
    const content = new TextEncoder().encode("brotli on chain");
    const { get } = serve(new Uint8Array(brotliCompressSync(content)), keccak256(content));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("brotli on chain");
  });

  it("the decoder never inflates past its own cap, whatever the caller asks", async () => {
    const bomb = new Uint8Array(brotliCompressSync(Buffer.alloc(8 * 1024 * 1024)));
    await expect(Promise.resolve(getFileCodec(CODEC_BROTLI).decode(bomb, { maxOutputBytes: 64 * 1024 * 1024 }))).rejects.toThrow(/larger than 1048576/);
  });

  it("a br bomb through the gateway is a cached 413 that reads nothing the second time", async () => {
    const { fc, get } = serve(new Uint8Array(brotliCompressSync(Buffer.alloc(64 * 1024 * 1024))), `0x${"ab".repeat(32)}`);
    expect((await get()).status).toBe(413);
    fc.reset();
    expect((await get()).status).toBe(413);
    expect(fc.count("multicall:read")).toBe(0);
  });

  it("keeps a codec that is already registered (the gateway's streaming gzip), so call order does not matter", async () => {
    const { CODEC_GZIP, registerWebCodecs } = await import("@abxfs/sdk");
    registerWebCodecs();
    const web = getFileCodec(CODEC_GZIP);
    await registerNodeCodecs({ maxOutputBytes: 1024 });
    expect(getFileCodec(CODEC_GZIP)).toBe(web);
    expect(hasFileCodec(CODEC_BROTLI)).toBe(true);
  });

  it("refuses a cap that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(registerNodeCodecs({ maxOutputBytes: bad }), String(bad)).rejects.toThrow(/maxOutputBytes/);
  });
});
