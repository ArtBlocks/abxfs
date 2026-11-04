/**
 * S-M1: a FastLZ chunk is inflated at the write-time read-back, and Solady's decoder copies min(distance, 32) bytes a
 * step, so a run or a small repeating pattern inflates at up to ~60 gas a byte. The old model priced inflation at 10
 * gas a byte, packed bundles of run-heavy, RGBA or sparse chunks at 17-44M, and a legacy chain refuses anything over
 * 2^24: such an upload could never finish. Here the chain's block (and so every transaction and estimate) is 2^24.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { uploadFiles } from "../../src/upload.js";
import { planFile } from "../../src/plan.js";
import { readFile } from "../../src/read.js";
import { LEGACY_GAS_SCHEDULE } from "../../src/gas-schedule.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const TX_CAP = 16_777_216;

let h: AnvilHarness;
beforeAll(async () => {
  h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", String(TX_CAP)] });
}, 120_000);
afterAll(async () => h?.stop());

/** 64 bands of one byte each, 20,000 bytes a band: solid fills, silence, zero padding. */
function runs(): Uint8Array {
  const out = new Uint8Array(64 * 20_000);
  for (let v = 1; v <= 64; v++) out.fill(v, (v - 1) * 20_000, v * 20_000);
  return out;
}

/** A raw 512 x 512 RGBA bitmap of flat-colour bands, 20 rows a band. */
function rgba(): Uint8Array {
  const W = 512;
  const out = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    const band = Math.floor(y / 20);
    const px = [(band * 37) & 0xff, (band * 91) & 0xff, (band * 53) & 0xff, 255];
    for (let x = 0; x < W; x++) out.set(px, (y * W + x) * 4);
  }
  return out;
}

describe("run-heavy and RGBA uploads finish on a chain capped at 2^24 per transaction", () => {
  for (const [name, make] of [["a file of 1-byte runs", runs], ["an RGBA bitmap", rgba]] as const) {
    it(`${name}: every bundle fits, every chunk is FastLZ, and the bytes read back`, async () => {
      const bytes = make();
      const backends = { raw: h.addresses.sstore2Backend, fastLz: h.addresses.fastLzBackend };
      const planned = await planFile({ backends, bytes, path: "img.bin" });
      // The case the old model got wrong: every chunk compresses to a few hundred bytes of short-distance matches.
      expect(planned.chunks.every((c) => c.backend === h.addresses.fastLzBackend)).toBe(true);

      const sent: Array<{ estimatedGas: number; txHash: `0x${string}` }> = [];
      const res = await uploadFiles({ publicClient: h.publicClient, walletClient: h.walletClient }, h.addresses, [{ path: "img.bin", bytes, mimeType: "application/octet-stream" }], {
        gasSchedule: LEGACY_GAS_SCHEDULE,
        onBundleSent: (b) => sent.push(b),
      });
      expect(res.rootCid).toMatch(/^0x[0-9a-f]{64}$/);
      for (const b of sent) {
        const r = await h.publicClient.getTransactionReceipt({ hash: b.txHash });
        expect(r.status).toBe("success");
        expect(Number(r.gasUsed)).toBeLessThanOrEqual(TX_CAP);
        // The estimate the bundle was packed with is never below what it used (less the 21k base it excludes).
        expect(b.estimatedGas).toBeGreaterThanOrEqual(Number(r.gasUsed) - 21_000);
      }
      const back = await readFile(h.publicClient, h.addresses, res.files[0]!.cid);
      expect(back.bytes).toEqual(bytes);
    }, 600_000);
  }
});
