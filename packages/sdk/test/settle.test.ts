/**
 * `settle()` exists because a transaction receipt does not mean the next read can see the write.
 *
 * Its contract is small and every clause is load-bearing, because it sits between a confirmed write
 * and a dependent one. In particular it must never throw: it is called on paths where the caller's
 * own operation produces a far better error message than anything invented here, and turning a
 * transient lag into an exception would replace "createFile reverted ChunkMissing" with something
 * less actionable.
 */
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { settle } from "../src/settle.js";

describe("settle", () => {
  it("returns immediately when the condition already holds", async () => {
    const check = vi.fn(async () => true);
    const started = Date.now();

    expect(await settle(check, { attempts: 5, delayMs: 50 })).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    // No sleep on the happy path — this runs on every upload, and the common case is already settled.
    expect(Date.now() - started).toBeLessThan(40);
  });

  it("polls until the condition becomes true", async () => {
    let calls = 0;
    const check = async () => ++calls >= 3;

    expect(await settle(check, { attempts: 8, delayMs: 1 })).toBe(true);
    expect(calls).toBe(3);
  });

  /**
   * Expiry is reported, not thrown. The callers treat a false here as "go ahead anyway" precisely
   * so the real operation can fail with its own, more specific error.
   */
  it("gives up after the attempt budget and reports false", async () => {
    const check = vi.fn(async () => false);

    expect(await settle(check, { attempts: 4, delayMs: 1 })).toBe(false);
    expect(check).toHaveBeenCalledTimes(4);
  });

  /**
   * A read can revert against a replica that has not seen the state yet — `ownerOf` on a token it
   * does not know about is the exact case. That is the condition being waited out, so it must not
   * escape as an error.
   */
  it("treats a throwing check as 'not yet' rather than propagating", async () => {
    let calls = 0;
    const check = async () => {
      if (++calls < 3) throw new Error("execution reverted: nonexistent token");
      return true;
    };

    await expect(settle(check, { attempts: 6, delayMs: 1 })).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("never throws even when the check always throws", async () => {
    const check = async () => {
      throw new Error("always down");
    };
    await expect(settle(check, { attempts: 2, delayMs: 1 })).resolves.toBe(false);
  });

  /** No trailing sleep after the final attempt — that would add latency buying nothing. */
  it("does not sleep after its last attempt", async () => {
    const started = Date.now();
    await settle(async () => false, { attempts: 3, delayMs: 60 });
    const elapsed = Date.now() - started;

    // Two gaps between three attempts, not three.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(200);
  });
});

/**
 * Both publish executors must run the same content pipeline.
 *
 * `executeDraftPublish` (updates) and `executeNewProjectPublish` (first publish) were separate
 * copies of the same three stages. The read-after-write confirmations were added to the first and
 * not the second, so publishing a NEW project still reverted `ChunkMissing` from the browser while
 * updating an existing one worked — the fix had been applied to one of two identical pipelines.
 *
 * Structural rather than behavioural, because the behaviour needs a chain and this does not: the
 * point is that neither executor carries its own stage loop any more.
 */
describe("the publish executors share one pipeline", () => {
  const src = readFileSync(resolve(__dirname, "../src/draft.ts"), "utf8");

  function bodyOf(fn: string): string {
    const start = src.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  for (const fn of ["executeDraftPublish", "executeNewProjectPublish"]) {
    it(`${fn} delegates to runContentStages`, () => {
      expect(bodyOf(fn)).toMatch(/runContentStages\(/);
    });

    /**
     * The specific regression: a hand-rolled stage loop is how one executor drifted from the other.
     * Neither may call the packer directly for content stages any more.
     */
    it(`${fn} has no stage loop of its own`, () => {
      const body = bodyOf(fn);
      expect(body).not.toMatch(/plan\.chunksToWrite\.length > 0/);
      expect(body).not.toMatch(/plan\.filesToCreate\.length > 0/);
      expect(body).not.toMatch(/plan\.dirsToCreate\.length > 0/);
      expect(body).not.toMatch(/sendPacked\(/);
    });
  }

  /** The planner must use the real packer, not a parallel model of it. */
  it("plans bundles with the same packer the executor uses", () => {
    // The planner packs through `packStages` (content-write.ts), the very function the executor runs.
    expect(src).toMatch(/packStages\(/);
    // The flat per-call constants that made the plan fiction are gone.
    expect(src).not.toMatch(/perChunkWriteGas \?\? 60_000n/);
    expect(src).not.toMatch(/function pushBundles/);
  });
});
