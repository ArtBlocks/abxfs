import { describe, expect, it } from "vitest";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { planUploadOffline } from "../../src/plan.js";
import {
  PlanTooLargeError,
  assertDirectoryFits,
  assertFileFits,
  estimateDirectoryEntries,
  estimateFileCreate,
  resolveSingleCallCeiling,
} from "../../src/gas.js";
import { BRANCH_MAX_CHILDREN, CHUNK_LEAF_MAX_HASHES, NODE_MAX_LEVEL, branchLevelsNeeded } from "../../src/node-gas.js";

const BACKENDS = { raw: "0x00000000000000000000000000000000000000b1" } as const;
const enc = new TextEncoder();
const mk = (n: number, dir = "a", nameLen = 0) =>
  Array.from({ length: n }, (_, i) => ({
    path: `${dir}/${nameLen ? (String(i).padStart(4, "0") + "x".repeat(nameLen)).slice(0, nameLen) : `f${i}.txt`}`,
    bytes: enc.encode(`pf ${i} ${n}`),
    mimeType: "text/plain",
  }));

// Size is not a limit, only the level cap is (3 levels of branches). The pure plan the web staging
// panel uses must therefore accept everything v1 refused, and refuse only what could never be written.
describe("planUploadOffline refuses only what could never be written (the pure path the web staging panel uses)", () => {
  it("1000 files in one folder plan fine (v1 refused anything over ~265)", async () => {
    await autoRegisterNodeCodecs();
    const plan = await planUploadOffline(mk(1000, "assets"), { backends: BACKENDS });
    const assets = plan.directories.find((d) => d.path === "assets")!;
    expect(assets.entries.length).toBe(1000);
    expect(assets.tree.rootLevel).toBe(1); // several leaves under one branch
    expect(assets.tree.nodes.filter((n) => n.level === 0).length).toBeGreaterThan(1);
  });
  it("255-byte names plan too: content-defined leaves, never over the blob limit", async () => {
    const plan = await planUploadOffline(mk(100, "x", 255), { backends: BACKENDS });
    const dir = plan.directories.find((d) => d.path === "x")!;
    for (const n of dir.tree.nodes) expect(n.blob.length).toBeLessThanOrEqual(24_575);
    const leaves = dir.tree.nodes.filter((n) => n.level === 0);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    expect(leaves.reduce((n, l) => n + l.count, 0)).toBe(100);
    expect(Math.max(...leaves.map((n) => n.count))).toBeLessThanOrEqual(84);
  });
  it("a 20 MB file plans as chunk nodes (v1 refused it)", async () => {
    const big = new Uint8Array(20 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big[i] = (i * 2654435761) >>> 24; // incompressible-ish
    const plan = await planUploadOffline([{ path: "big.bin", bytes: big, mimeType: "application/octet-stream" }], { backends: { ...BACKENDS, maxInputSize: 1024 } });
    const file = plan.files[0]!;
    expect(file.chunkIds.length).toBeGreaterThan(15_000);
    // ~20k chunks in ~130 content-defined leaves: branches of ~34 children, so two branch levels.
    expect(file.tree.rootLevel).toBe(2);
  }, 120_000);
  it("the level cap is the one thing refused, before anything is written", () => {
    const ceiling = resolveSingleCallCeiling();
    const beyond = CHUNK_LEAF_MAX_HASHES * BRANCH_MAX_CHILDREN ** NODE_MAX_LEVEL + 1; // one chunk past 3 levels
    expect(branchLevelsNeeded(BRANCH_MAX_CHILDREN ** NODE_MAX_LEVEL)).toBe(3);
    expect(branchLevelsNeeded(BRANCH_MAX_CHILDREN ** NODE_MAX_LEVEL + 1)).toBe(4);
    expect(() => assertFileFits("huge.bin", CHUNK_LEAF_MAX_HASHES * BRANCH_MAX_CHILDREN ** NODE_MAX_LEVEL, 0, ceiling)).not.toThrow();
    const err = (() => { try { assertFileFits("huge.bin", beyond, 0, ceiling); } catch (e) { return e as PlanTooLargeError; } })()!;
    expect(err).toBeInstanceOf(PlanTooLargeError);
    expect(err.reason).toBe("levels");
    expect(err.kind).toBe("file");
    expect(err.path).toBe("huge.bin");
    expect(err.levelsNeeded).toBe(4);
    expect(err.levelCap).toBe(3);
    expect(err.message).toMatch(/Nothing was written/);
  });
  it("a tiny single-call ceiling refuses a node that could not fit, naming the folder", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, isDirectory: false }));
    const err = (() => { try { assertDirectoryFits("p", entries, 100_000); } catch (e) { return e as PlanTooLargeError; } })()!;
    expect(err).toBeInstanceOf(PlanTooLargeError);
    expect(err.reason).toBe("node-gas");
    expect(err.path).toBe("p");
  });
  it("the ceiling is below the node's 2^24 simulation cap and the estimates are monotone in name length", () => {
    expect(resolveSingleCallCeiling()).toBeLessThan(16_777_216);
    const e = (n: number) => estimateDirectoryEntries([{ name: "x".repeat(n), isDirectory: false }]);
    // Linear in name bytes (no cliff at 32 as in v1), and strictly growing.
    expect(e(31)).toBeLessThan(e(32));
    expect(e(100)).toBeLessThan(e(255));
    expect(estimateFileCreate(1)).toBeGreaterThan(0);
  });
});
