/**
 * The gas model under both schedules, pinned to what the chain measured.
 *
 * Every number below is `eth_simulateV1` of the current stores, one call per simulated block (so every account and slot
 * is cold), on 2026-10-29: Ethereum mainnet for the legacy schedule, Sepolia for EIP-8037 (live there since
 * 2026-10-06). Under EIP-8037 a block's gasUsed is max(execution, state) and the call's is their sum, which gives the
 * state part exactly. Totals include the 21,000 transaction base; the model's per-call estimates do not.
 *
 * The model must never be BELOW a measurement (a low estimate packs a bundle that fails simulation) and should not be
 * far above one (a high one wastes transactions). Under EIP-8037 the state part is arithmetic and must match exactly.
 *
 * FastLZ chunks are inflated at the write-time read-back, and that cost follows the stream (`flzDecodeWork`): the pins
 * that carry their stream are held to the same 15% + 60k as everything else. Two mainnet pins predate that and their
 * streams were not kept, so the model prices them with the length-only envelope and they are held to "never below".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Address, Hex, PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import {
  EIP8037_GAS_SCHEDULE,
  LEGACY_GAS_SCHEDULE,
  clearGasScheduleCache,
  detectGasSchedule,
  gasScheduleForChain,
  stateGas,
  type GasEstimate,
  type GasSchedule,
} from "../src/gas-schedule.js";
import {
  branchBlobSize,
  branchExecution,
  chunkLeafBlobSize,
  chunkLeafExecution,
  createDirectoryGas,
  createFileGas,
  entryLeafBlobSize,
  entryLeafExecution,
  nodeGasEstimate,
  nodeStateGas,
  type BranchShape,
} from "../src/node-gas.js";
import {
  ESTIMATE_GAS_CAP,
  GAS_ESTIMATES,
  contentWriteGas,
  flzDecodeGasOfWork,
  fitsSingleCall,
  packBundles,
  resolveBundleLimits,
  resolveMaxBundleGas,
  resolveSingleCallLimits,
  type BundleableCall,
} from "../src/gas.js";
import { packEntryTree } from "../src/nodes.js";
import { asAbxfsCid } from "../src/types.js";
import { flzCompress, flzDecodeWork } from "../src/fastlz.js";
import { dict3Sep2, sparse } from "./helpers/flz-adversarial.js";

const TX_BASE = 21_000;

/** One measured call: the model's estimate for it under a schedule, and what the chain charged. */
interface Case {
  label: string;
  model: (s: GasSchedule) => GasEstimate;
  legacy: number;
  eip8037: { total: number; state: number };
  /** Priced by an envelope (the stream is not known): held to "never below" only. */
  envelope?: boolean;
}

/**
 * Full FastLZ chunks whose streams are known, measured as `ChunkStore.write` receipts on anvil (Cancun, legacy pricing,
 * 2026-10-29). A short back-reference distance copies few bytes a step, so a run or a small repeating pattern costs far
 * more to inflate than its few stored bytes suggest: the 1-byte run below is 981k where the old per-byte model said
 * 418k, and a bundle packed on that model failed the 2^24 cap.
 */
const N = 24_575;
const RUN = new Uint8Array(N).fill(0x61);
const RGBA_BANDS = Uint8Array.from({ length: N }, (_, i) => {
  const band = Math.floor(i / 2048);
  return [(band * 17) & 0xff, (band * 29) & 0xff, (band * 43) & 0xff, 0xff][i % 4]!;
});
const PHRASE = new TextEncoder().encode("The quick brown fox jumps over the lazy dog; pack my box with five dozen liquor jugs. 0123456789!?");
const PERIOD_100 = Uint8Array.from({ length: N }, (_, i) => PHRASE[i % PHRASE.length]!);

/**
 * A FastLZ write measured on a legacy chain, with its EIP-8037 numbers DERIVED rather than simulated: the receipt's
 * execution (total minus the legacy state arithmetic) plus EIP-8038's access charges for three slots and an account,
 * and the state arithmetic of the 8037 schedule. Execution does not depend on the schedule beyond those charges.
 */
function flzCase(label: string, data: Uint8Array, legacy: number): Case {
  const input = flzCompress(data);
  const created = { codeBytes: input.length + 1, accounts: 1, slots: 3 };
  const execution = legacy - TX_BASE - stateGas(created, LEGACY_GAS_SCHEDULE);
  const state = stateGas(created, EIP8037_GAS_SCHEDULE);
  const access = 3 * EIP8037_GAS_SCHEDULE.newSlotExecution + EIP8037_GAS_SCHEDULE.newAccountExecution;
  return {
    label,
    model: (s) => contentWriteGas(input.length, { dataLength: data.length, input, schedule: s }),
    legacy,
    eip8037: { total: execution + access + state + TX_BASE, state },
  };
}

const node = (execution: number, blob: number) => (s: GasSchedule): GasEstimate => ({
  execution: execution + s.newSlotExecution + s.newAccountExecution,
  state: nodeStateGas(blob, s),
});
const chunkLeaf = (n: number) => node(chunkLeafExecution(n), chunkLeafBlobSize(n));
const entryLeaf = (n: number, nameLen: number) => node(entryLeafExecution(n, n * nameLen), entryLeafBlobSize(n, n * nameLen));
const dirBranch = (n: number, nameLen: number, level: number) => {
  const shape: BranchShape = { level, edgeNameBytes: (n - 1) * 2 * nameLen };
  return node(branchExecution(n, false, shape), branchBlobSize(n));
};

const CASES: Case[] = [
  {
    label: "write 24,575 B raw",
    model: (s) => contentWriteGas(24_575, { schedule: s }),
    legacy: 5_604_298,
    eip8037: { total: 38_717_722, state: 38_078_640 },
  },
  {
    label: "write 500 B raw",
    model: (s) => contentWriteGas(500, { schedule: s }),
    legacy: 246_155,
    eip8037: { total: 1_335_353, state: 1_243_890 },
  },
  {
    label: "write 24,575 B of text through FastLZ (366 B stored)",
    model: (s) => contentWriteGas(366, { dataLength: 24_575, schedule: s }),
    legacy: 413_799,
    eip8037: { total: 1_324_741, state: 1_038_870 },
    envelope: true,
  },
  {
    label: "write 24,575 B barely compressible through FastLZ (23,257 B stored)",
    model: (s) => contentWriteGas(23_257, { dataLength: 24_575, schedule: s }),
    legacy: 5_429_406 - 3 * 200, // mainnet's sample stored 23,260 B: the same write with 3 bytes less code
    eip8037: { total: 36_790_772, state: 36_062_100 },
    envelope: true,
  },
  // Short distances: one copy step per byte or per four. These are what the old per-byte model under-priced.
  flzCase("write a 24,575-byte run of one byte through FastLZ (291 B stored)", RUN, 1_002_555),
  flzCase("write 24,575 B of RGBA bands through FastLZ (343 B stored)", RGBA_BANDS, 692_191),
  // A long distance (a 100-byte period): 32 bytes a copy step.
  flzCase("write 24,575 B of a 100-byte period through FastLZ (388 B stored)", PERIOD_100, 419_101),
  // Many short tokens (the delta audit's fresh corpus, 2026-10-30, anvil Cancun legacy receipts): the 2026-10-29
  // per-literal and per-match figures were 1.6%, 1.7% and (the no-stream envelope) 0.8% below these.
  flzCase("write 24,575 B of 3-byte dictionary words between 2 random bytes through FastLZ (dict3-sep2, 24,289 B stored)", dict3Sep2(), 7_651_246),
  flzCase("write 24,575 B of 2 zeros then 3 random bytes in 1..64 through FastLZ (sparse5-a64-z2, 23,263 B stored)", sparse(5, 64, 2), 7_485_111),
  flzCase("write 24,575 B of 2 zeros then 1 random byte in 1..64 through FastLZ (sparse3-a64-z2, 16,202 B stored)", sparse(3, 64, 2), 6_277_729),
  { label: "chunk leaf 646 (contract maximum)", model: chunkLeaf(646), legacy: 10_861_612, eip8037: { total: 43_764_264, state: 37_843_020 } },
  { label: "chunk leaf 512 (SDK maximum)", model: chunkLeaf(512), legacy: 8_625_019, eip8037: { total: 34_754_237, state: 30_052_260 } },
  { label: "chunk leaf 160", model: chunkLeaf(160), legacy: 2_753_704, eip8037: { total: 11_090_418, state: 9_586_980 } },
  { label: "chunk leaf 1", model: chunkLeaf(1), legacy: 103_602, eip8037: { total: 403_334, state: 342_720 } },
  { label: "entry leaf 323 x 8 B names", model: entryLeaf(323, 8), legacy: 5_193_215, eip8037: { total: 24_349_649, state: 22_032_000 } },
  { label: "entry leaf 60 x 255 B names", model: entryLeaf(60, 255), legacy: 4_397_331, eip8037: { total: 27_874_211, state: 27_001_440 } },
  { label: "entry leaf 163 x 64 B names", model: entryLeaf(163, 64), legacy: 4_685_404, eip8037: { total: 26_619_184, state: 25_226_640 } },
  {
    label: "file branch 128",
    model: node(branchExecution(128, true), branchBlobSize(128, true)),
    legacy: 1_768_153,
    eip8037: { total: 9_170_711, state: 8_512_920 },
  },
  { label: "directory branch L1 128 x 8 B", model: dirBranch(128, 8, 1), legacy: 2_507_840, eip8037: { total: 9_041_602, state: 7_337_880 } },
  { label: "directory branch L1 128 x 32 B", model: dirBranch(128, 32, 1), legacy: 2_505_995, eip8037: { total: 9_039_793, state: 7_337_880 } },
  { label: "directory branch L1 128 x 64 B", model: dirBranch(128, 64, 1), legacy: 2_527_878, eip8037: { total: 9_061_604, state: 7_337_880 } },
  { label: "directory branch L1 128 x 128 B", model: dirBranch(128, 128, 1), legacy: 2_572_483, eip8037: { total: 9_106_185, state: 7_337_880 } },
  { label: "directory branch L1 128 x 255 B", model: dirBranch(128, 255, 1), legacy: 2_669_144, eip8037: { total: 9_203_002, state: 7_337_880 } },
  { label: "directory branch L2 128 x 255 B", model: dirBranch(128, 255, 2), legacy: 4_152_397, eip8037: { total: 10_825_859, state: 7_337_880 } },
  { label: "directory branch L3 128 x 255 B", model: dirBranch(128, 255, 3), legacy: 5_652_355, eip8037: { total: 12_465_757, state: 7_337_880 } },
  { label: "directory branch L3 128 x 8 B", model: dirBranch(128, 8, 3), legacy: 5_460_032, eip8037: { total: 12_273_206, state: 7_337_880 } },
  { label: "directory branch L3 128 x 64 B", model: dirBranch(128, 64, 3), legacy: 5_487_047, eip8037: { total: 12_300_341, state: 7_337_880 } },
  { label: "directory branch L1 2 x 8 B", model: dirBranch(2, 8, 1), legacy: 117_692, eip8037: { total: 466_534, state: 397_800 } },
  { label: "directory branch L1 2 x 255 B", model: dirBranch(2, 255, 1), legacy: 118_723, eip8037: { total: 467_541, state: 397_800 } },
  { label: "directory branch L1 34 x 8 B", model: dirBranch(34, 8, 1), legacy: 720_507, eip8037: { total: 2_640_065, state: 2_160_360 } },
  {
    label: "createFile, 9-byte mime",
    model: (s) => createFileGas({ mimeBytes: 9, hasRoot: true, hasCodec: false }, s),
    legacy: 74_627,
    eip8037: { total: 244_567, state: 195_840 },
  },
  {
    label: "createFile, 127-byte mime and a codec",
    model: (s) => createFileGas({ mimeBytes: 127, hasRoot: true, hasCodec: true }, s),
    legacy: 210_770,
    eip8037: { total: 908_218, state: 783_360 },
  },
  { label: "createDirectory", model: (s) => createDirectoryGas(s), legacy: 48_609, eip8037: { total: 130_629, state: 97_920 } },
];

const total = (e: GasEstimate) => e.execution + e.state;

describe("the gas model against measured gas", () => {
  for (const c of CASES) {
    it(`${c.label}: legacy`, () => {
      const measured = c.legacy - TX_BASE;
      const model = total(c.model(LEGACY_GAS_SCHEDULE));
      expect(model).toBeGreaterThanOrEqual(measured);
      if (!c.envelope) expect(model).toBeLessThanOrEqual(measured * 1.15 + 60_000);
    });
    it(`${c.label}: EIP-8037`, () => {
      const measured = c.eip8037.total - TX_BASE;
      const est = c.model(EIP8037_GAS_SCHEDULE);
      // State is arithmetic on bytes, accounts and slots: exact.
      expect(est.state).toBe(c.eip8037.state);
      expect(total(est)).toBeGreaterThanOrEqual(measured);
      if (!c.envelope) expect(total(est)).toBeLessThanOrEqual(measured * 1.15 + 60_000);
      // And execution on its own (what the 2^24 cap counts) is never under-estimated.
      expect(est.execution).toBeGreaterThanOrEqual(measured - c.eip8037.state);
    });
  }

  it("the frozen limits fit one transaction under both schedules, with the default limits", () => {
    for (const s of [LEGACY_GAS_SCHEDULE, EIP8037_GAS_SCHEDULE]) {
      const ceiling = resolveSingleCallLimits({ schedule: s });
      for (const c of CASES.filter((x) => x.label !== "chunk leaf 646 (contract maximum)")) {
        expect(fitsSingleCall(c.model(s), ceiling), `${c.label} (${s.name})`).toBe(true);
      }
    }
  });
});

describe("bundle limits per schedule", () => {
  const T = "0x00000000000000000000000000000000000000c5" as Address;
  const write = (bytes: number, s: GasSchedule): BundleableCall => {
    const g = contentWriteGas(bytes, { schedule: s });
    return { target: T, data: ("0x" + "ab".repeat(bytes + 200)) as Hex, estimatedGas: total(g), estimatedStateGas: g.state };
  };

  it("legacy: one total limit, exactly resolveMaxBundleGas", () => {
    const l = resolveBundleLimits({ bundleGasBudget: 12_000_000 });
    expect(l.maxBundleGas).toBe(resolveMaxBundleGas({ bundleGasBudget: 12_000_000 }));
    expect(l.maxBundleExecutionGas).toBeUndefined();
  });

  it("EIP-8037: the budget bounds execution under 2^24, and the total stays under 90% of a 50M simulation", () => {
    const l = resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000 });
    expect(l.maxBundleExecutionGas).toBe(12_000_000);
    expect(l.maxBundleGas).toBe(45_000_000);
    expect(resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 1e9 }).maxBundleExecutionGas).toBeLessThan(ESTIMATE_GAS_CAP);
    // A known block gas limit tightens the total: 40M x 0.8.
    expect(resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000, blockGasLimit: 40_000_000 }).maxBundleGas).toBe(32_000_000);
    // A node configured to simulate more lets bundles carry more.
    expect(resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000, simulationGasCap: 200_000_000 }).maxBundleGas).toBe(180_000_000);
  });

  it("EIP-8037: every full chunk is its own transaction; under legacy two share one", () => {
    const limits8037 = resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000 });
    expect(packBundles([0, 1, 2].map(() => write(24_575, EIP8037_GAS_SCHEDULE)), limits8037)).toHaveLength(3);
    const limitsLegacy = resolveBundleLimits({ bundleGasBudget: 12_000_000 });
    expect(packBundles([0, 1, 2, 3].map(() => write(24_575, LEGACY_GAS_SCHEDULE)), limitsLegacy)).toHaveLength(2);
  });

  it("EIP-8037: small chunks still share bundles, bounded by the total, not by execution", () => {
    const limits = resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000 });
    const bundles = packBundles(Array.from({ length: 100 }, () => write(500, EIP8037_GAS_SCHEDULE)), limits);
    for (const b of bundles) {
      expect(b.estimatedGas).toBeLessThanOrEqual(limits.maxBundleGas);
      expect(b.estimatedGas - (b.estimatedStateGas ?? 0)).toBeLessThanOrEqual(limits.maxBundleExecutionGas!);
    }
    expect(bundles.length).toBe(Math.ceil(100 / bundles[0]!.calls.length));
    expect(bundles[0]!.calls.length).toBeGreaterThanOrEqual(30);
  });

  it("EIP-8037: execution binds when the state is small (directory branches of long names)", () => {
    const limits = resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000 });
    const g = dirBranch(128, 255, 3)(EIP8037_GAS_SCHEDULE);
    const call: BundleableCall = { target: T, data: "0x00", estimatedGas: total(g), estimatedStateGas: g.state };
    // Three would be 38M total (under 45M) but 16M of execution (over 12M): two, then one.
    expect(g.execution * 3).toBeGreaterThan(12_000_000);
    expect(total(g) * 3).toBeLessThan(45_000_000);
    expect(packBundles([call, call, call], limits).map((b) => b.calls.length)).toEqual([2, 1]);
  });

  it("calldata is bounded too, so the 64-gas-a-byte floor stays under the per-transaction cap", () => {
    const limits = resolveBundleLimits({ schedule: EIP8037_GAS_SCHEDULE, bundleGasBudget: 12_000_000 });
    const big: BundleableCall = { target: T, data: ("0x" + "00".repeat(100_000)) as Hex, estimatedGas: 100_000, estimatedStateGas: 0 };
    const bundles = packBundles([big, big, big], limits);
    for (const b of bundles) expect(b.calls.length * 100_000 * 64).toBeLessThan(ESTIMATE_GAS_CAP);
    expect(bundles.length).toBeGreaterThan(1);
  });
});

describe("single-call limits per schedule", () => {
  it("EIP-8037: a full chunk fits by default, and not under a 45M block", () => {
    const full = contentWriteGas(24_575, { schedule: EIP8037_GAS_SCHEDULE });
    expect(fitsSingleCall(full, resolveSingleCallLimits({ schedule: EIP8037_GAS_SCHEDULE }))).toBe(true);
    expect(fitsSingleCall(full, resolveSingleCallLimits({ schedule: EIP8037_GAS_SCHEDULE, blockGasLimit: 45_000_000 }))).toBe(false);
  });

  it("a packed node is priced from its legacy estimate: same execution plus the schedule's charges, new state", () => {
    const tree = packEntryTree([{ name: "a", cid: asAbxfsCid(`0x${"11".repeat(32)}`), isDirectory: false }]);
    const n = tree.nodes[0]!;
    const legacy = nodeGasEstimate(n, LEGACY_GAS_SCHEDULE);
    expect(legacy.execution + legacy.state).toBe(n.estimatedGas);
    const next = nodeGasEstimate(n, EIP8037_GAS_SCHEDULE);
    expect(next.execution).toBe(legacy.execution + 12_100 + 12_000);
    expect(next.state).toBe(nodeStateGas(n.blob.length, EIP8037_GAS_SCHEDULE));
  });

  it("directory branches are priced by their edge names: long names cost more than short ones", () => {
    const entries = (len: number) =>
      Array.from({ length: 3000 }, (_, i) => ({
        name: String(i).padStart(6, "0") + "n".repeat(len - 6),
        cid: asAbxfsCid(`0x${"22".repeat(32)}`),
        isDirectory: false,
      }));
    const branchGas = (len: number) => packEntryTree(entries(len)).nodes.filter((x) => x.level > 0).reduce((g, x) => g + x.estimatedGas / x.childIds.length, 0);
    expect(branchGas(200)).toBeGreaterThan(branchGas(8));
  });
});

describe("detectGasSchedule", () => {
  afterEach(() => clearGasScheduleCache());
  const client = (chainId: number | undefined, estimate: () => Promise<bigint>) =>
    ({ chain: chainId === undefined ? undefined : { id: chainId }, estimateGas: estimate }) as unknown as PublicClient;

  it("reads EIP-8037 off a CREATE2 of one byte (215k there, 54k elsewhere)", async () => {
    expect((await detectGasSchedule(client(1, async () => 215_293n))).name).toBe("eip8037");
    expect((await detectGasSchedule(client(8453, async () => 54_299n))).name).toBe("legacy");
  });

  it("asks once per chain", async () => {
    let calls = 0;
    const c = client(11155111, async () => {
      calls++;
      return 215_293n;
    });
    await detectGasSchedule(c);
    await detectGasSchedule(c);
    expect(calls).toBe(1);
  });

  it("falls back to what the chain is known to run when the node cannot answer, without caching the failure", async () => {
    let fail = true;
    const c = client(11155111, async () => {
      if (fail) throw new Error("rpc down");
      return 54_299n;
    });
    expect((await detectGasSchedule(c)).name).toBe("eip8037");
    fail = false;
    expect((await detectGasSchedule(c)).name).toBe("legacy");
    expect((await detectGasSchedule(client(undefined, async () => Promise.reject(new Error("x"))))).name).toBe("legacy");
    expect(gasScheduleForChain(11155111).name).toBe("eip8037");
    expect(gasScheduleForChain(8453).name).toBe("legacy");
  });
});

describe("FastLZ decode gas follows the stream", () => {
  it("the stream model is what the run, RGBA and period pins measured; the old per-byte model was under every short distance", () => {
    // What the model replaced: 10 gas a data byte. On the 1-byte run it was 2.2x under the receipt.
    const old = (data: Uint8Array) => {
      const input = flzCompress(data);
      return contentWriteGas(input.length, { schedule: LEGACY_GAS_SCHEDULE }).execution + 10 * data.length +
        contentWriteGas(input.length, { schedule: LEGACY_GAS_SCHEDULE }).state;
    };
    expect(old(RUN)).toBeLessThan(1_002_555 - TX_BASE);
    expect(old(RGBA_BANDS)).toBeLessThan(692_191 - TX_BASE);
  });

  it("the adversarial pins are the very streams the delta audit measured", () => {
    // Input length and decode work of each, as the audit's corpus recorded them next to its receipts.
    const work = (data: Uint8Array) => {
      const input = flzCompress(data);
      return { input: input.length, ...flzDecodeWork(input) };
    };
    expect(work(dict3Sep2())).toEqual({ input: 24_289, literals: 4706, matches: 4706, steps: 4706 });
    expect(work(sparse(5, 64, 2))).toEqual({ input: 23_263, literals: 4821, matches: 4879, steps: 4879 });
    expect(work(sparse(3, 64, 2))).toEqual({ input: 16_202, literals: 34, matches: 8012, steps: 8020 });
  });

  it("without the stream, the envelope is never below a receipt of the adversarial pins", () => {
    for (const [data, legacy] of [[dict3Sep2(), 7_651_246], [sparse(5, 64, 2), 7_485_111], [sparse(3, 64, 2), 6_277_729]] as const) {
      const input = flzCompress(data);
      expect(total(contentWriteGas(input.length, { dataLength: data.length, schedule: LEGACY_GAS_SCHEDULE }))).toBeGreaterThanOrEqual(legacy - TX_BASE);
    }
  });

  // On these streams the envelope is above the stream model too. It need not be on every stream: the model carries
  // headroom for many short tokens, and on `sparse3-a64-z2` it is 1.06x the receipt where the envelope is 1.02x.
  it("without the stream, the envelope is never below the stream model of the run, RGBA and period pins", () => {
    for (const data of [RUN, RGBA_BANDS, PERIOD_100]) {
      const input = flzCompress(data);
      const known = contentWriteGas(input.length, { dataLength: data.length, input });
      const envelope = contentWriteGas(input.length, { dataLength: data.length });
      expect(envelope.execution).toBeGreaterThanOrEqual(known.execution);
    }
  });
});

/**
 * Every FastLZ `ChunkStore.write` receipt the two delta audits measured (2026-10-30, anvil Cancun, legacy pricing): 162
 * of the first round's corpora and 128 of the second's (consecutive short matches, CSV, hex, DNA, SVG paths, noisy
 * bitmaps, FastCDC chunks of real files, fuzzed mixtures). Each keeps its stream's decode work, which is all the
 * stream model prices.
 */
interface FlzReceipt {
  round: 1 | 2;
  label: string;
  data: number;
  input: number;
  literals: number;
  matches: number;
  steps: number;
  gasUsed: number;
}
const FLZ_RECEIPTS: FlzReceipt[] = JSON.parse(readFileSync(resolve(__dirname, "fixtures/flz-write-receipts.json"), "utf8")).receipts;

describe("FastLZ write gas against every receipt of both delta audits", () => {
  it("is fitted at 140 a literal run, 270 a back-reference, 58 a copy step and 6 a data byte (envelope 65 / 65)", () => {
    expect({
      literal: GAS_ESTIMATES.flzDecodePerLiteral,
      match: GAS_ESTIMATES.flzDecodePerMatch,
      step: GAS_ESTIMATES.flzDecodePerCopyStep,
      dataByte: GAS_ESTIMATES.flzDecodePerDataByte,
      envelopeData: GAS_ESTIMATES.flzDecodeEnvelopePerDataByte,
      envelopeInput: GAS_ESTIMATES.flzDecodeEnvelopePerInputByte,
    }).toEqual({ literal: 140, match: 270, step: 58, dataByte: 6, envelopeData: 65, envelopeInput: 65 });
  });

  it("covers 290 receipts, 162 of round 1 and 128 of round 2", () => {
    expect(FLZ_RECEIPTS).toHaveLength(290);
    expect(FLZ_RECEIPTS.filter((r) => r.round === 1)).toHaveLength(162);
  });

  it("the stream model is never below a receipt and at most 15% + 60k above one", () => {
    const off: string[] = [];
    for (const r of FLZ_RECEIPTS) {
      const measured = r.gasUsed - TX_BASE;
      const model = total(contentWriteGas(r.input, { schedule: LEGACY_GAS_SCHEDULE })) + flzDecodeGasOfWork(r, r.data);
      if (model < measured || model > measured * 1.15 + 60_000) off.push(`${r.label} (round ${r.round}): model ${model}, receipt ${measured}`);
    }
    expect(off).toEqual([]);
  });

  it("is what contentWriteGas prices from the stream itself", () => {
    for (const data of [RUN, RGBA_BANDS, PERIOD_100, dict3Sep2(), sparse(3, 64, 2)]) {
      const input = flzCompress(data);
      const fromStream = contentWriteGas(input.length, { dataLength: data.length, input, schedule: LEGACY_GAS_SCHEDULE });
      const withoutDecode = contentWriteGas(input.length, { schedule: LEGACY_GAS_SCHEDULE });
      expect(total(fromStream)).toBe(total(withoutDecode) + flzDecodeGasOfWork(flzDecodeWork(input), data.length));
    }
  });

  it("without the stream, the envelope is never below a receipt either", () => {
    const below = FLZ_RECEIPTS.filter(
      (r) => total(contentWriteGas(r.input, { dataLength: r.data, schedule: LEGACY_GAS_SCHEDULE })) < r.gasUsed - TX_BASE,
    );
    expect(below.map((r) => r.label)).toEqual([]);
  });

  it("prices token-dense chunks (DNA, CSV, hex) lower than 60 / 320 / 60 did: those are nearly all back-references", () => {
    const priced = (k: { literal: number; match: number; step: number }, r: FlzReceipt) =>
      total(contentWriteGas(r.input, { schedule: LEGACY_GAS_SCHEDULE })) + k.literal * r.literals + k.match * r.matches + k.step * r.steps + 6 * r.data;
    const dense = FLZ_RECEIPTS.filter((r) => /^(dna|csv-ints|csv-floats|hexdump)$/.test(r.label));
    expect(dense.length).toBeGreaterThanOrEqual(4);
    for (const r of dense) {
      expect(priced({ literal: 140, match: 270, step: 58 }, r)).toBeLessThan(priced({ literal: 60, match: 320, step: 60 }, r));
      expect(priced({ literal: 140, match: 270, step: 58 }, r)).toBeGreaterThanOrEqual(r.gasUsed - TX_BASE);
    }
  });
});
