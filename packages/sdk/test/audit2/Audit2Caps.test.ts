/**
 * AUDIT2: do the client caps really bound time and memory under bomb inputs?
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { flzDecompress } from "../../src/fastlz.js";
import { LimitExceededError } from "../../src/limits.js";
import { walkDirectory } from "../../src/read.js";
import { autoRegisterNodeCodecs, getFileCodec, CODEC_GZIP } from "../../src/compression.js";
import { registerWebCodecs } from "../../src/web-codecs.js";
import { verifyLocalIpfsCid } from "../../src/verify.js";
import type { AbxfsCid } from "../../src/index.js";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;
const addresses = {
  chunkStore: "0x0000000000000000000000000000000000000c11",
  directoryStore: "0x0000000000000000000000000000000000000d57",
  fileStore: "0x0000000000000000000000000000000000000f11",
} as never;

/**
 * A hostile RPC that answers the paged directory reads (`entryCount`, `getEntries`) from `entriesOf(cid)` and refuses
 * every file read, so the walkers see whatever DAG the test builds.
 */
function dirClient(entriesOf: (cid: AbxfsCid) => Array<{ name: string; cid: AbxfsCid; isDirectory: boolean }>) {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      const cid = args[0] as AbxfsCid;
      if (functionName === "entryCount") return BigInt(entriesOf(cid).length);
      if (functionName === "getEntries") return entriesOf(cid).slice(Number(args[1]), Number(args[2]));
      throw new Error(`not a file: ${functionName}`);
    },
  } as never;
}

/** A FastLZ stream: one literal then maximal back-references (264 bytes out per 3 bytes in). */
function flzBomb(outputBytes: number): Uint8Array {
  const parts: number[] = [0, 0x41]; // literal 'A'
  let out = 1;
  while (out < outputBytes) {
    // t=7 (long match): 0xE0 | hi(offset), len byte (255 => 9+255=264), lo(offset); offset 1 => run of 'A'
    parts.push(0xe0, 255, 0);
    out += 264;
  }
  return Uint8Array.from(parts);
}

describe("AUDIT2 decompression bombs", () => {
  it("fastlz: ~88x bomb is refused at a small explicit cap, fast, without allocating the output", () => {
    const bomb = flzBomb(64 * 1024 * 1024); // inflates to 64 MiB from ~0.7 MiB
    expect(bomb.length).toBeLessThan(1_000_000);
    const t = Date.now();
    expect(() => flzDecompress(bomb, 1024 * 1024)).toThrow(/exceeds/);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("fastlz: at the DEFAULT 256 MiB cap a 3 MiB input still costs 256 MiB of tab memory (bounded, not small)", () => {
    const bomb = flzBomb(300 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const t = Date.now();
    expect(() => flzDecompress(bomb)).toThrow(/exceeds/);
    peak = process.memoryUsage().arrayBuffers;
    // informational: time and buffer growth at the default cap
    console.log(`fastlz default-cap bomb: input ${(bomb.length / 1048576).toFixed(1)} MiB, ${Date.now() - t} ms, arrayBuffers delta ${((peak - before) / 1048576).toFixed(0)} MiB (post-GC may read lower)`);
  }, 60_000);

  it("gzip (node): a 200 MiB-of-zeros bomb is refused at a 1 MiB cap", async () => {
    await autoRegisterNodeCodecs();
    const gz = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    await expect(getFileCodec(CODEC_GZIP).decode(gz, { maxOutputBytes: 1024 * 1024 })).rejects.toThrow();
  }, 60_000);

  it("gzip (web streams): the same bomb is cancelled mid-stream at the cap", async () => {
    registerWebCodecs();
    const gz = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    const t = Date.now();
    await expect(getFileCodec(CODEC_GZIP).decode(gz, { maxOutputBytes: 1024 * 1024 })).rejects.toThrow(/exceeds/);
    expect(Date.now() - t).toBeLessThan(10_000);
  }, 60_000);
});

describe("AUDIT2 walkers against a HOSTILE RPC (DAGs an honest chain cannot contain)", () => {
  it("a directory that lists ITSELF is refused as a cycle (it used to await its own memoised promise forever)", async () => {
    const client = dirClient(() => [{ name: "loop", cid: c(1), isDirectory: true }]);
    await expect(walkDirectory(client, addresses, c(1))).rejects.toThrow(/cycle/);
  });

  it("the same self-link is refused by verifyLocalIpfsCid", async () => {
    const client = dirClient(() => [{ name: "loop", cid: c(1), isDirectory: true }]);
    await expect(verifyLocalIpfsCid(client, addresses, c(1))).rejects.toThrow(/cycle/);
  });

  it("a two-directory cycle (A->B->A) is refused as well", async () => {
    const client = dirClient((cid) => [{ name: "x", cid: c(Number(BigInt(cid)) === 1 ? 2 : 1), isDirectory: true }]);
    await expect(walkDirectory(client, addresses, c(1))).rejects.toThrow(/cycle/);
  });

  it("a flat directory of 150k entries is cut off at the node cap (the entry array itself is RPC-sized)", async () => {
    const entries = Array.from({ length: 150_000 }, (_, i) => ({ name: `f${i}`, cid: c(i + 10), isDirectory: false }));
    const client = dirClient(() => entries);
    await expect(walkDirectory(client, addresses, c(1))).rejects.toThrow(LimitExceededError);
  });

  it("a 2^40 diamond made only of files at each level hits the cap quickly", async () => {
    const client = dirClient((cid) => {
      const l = Number(BigInt(cid));
      return [
        { name: "a", cid: c(l + 1), isDirectory: true },
        { name: "b", cid: c(l + 1), isDirectory: true },
        { name: "f", cid: c(9999), isDirectory: false },
      ];
    });
    const t = Date.now();
    await expect(walkDirectory(client, addresses, c(0))).rejects.toThrow(LimitExceededError);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
