/**
 * The org fork test closes every state-changing function on ABX's `SeriesCode` collection against
 * every actor. That claim is only as complete as the list it iterates, so the list is generated from
 * ABX's own ABI (`scripts/abx-battery.mjs`) rather than kept by hand.
 *
 * This fails when ABX adds, removes or changes a mutator and the checked-in
 * `contracts-projects/test/fork/Battery.sol` was not regenerated — which is the moment a human should
 * read the diff and decide whether the new function is closed after renounce.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("ABX mutator battery", () => {
  it("is in step with @artblocks/abx-sdk", () => {
    const script = resolve(__dirname, "../scripts/abx-battery.mjs");
    expect(() => execFileSync("node", [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
