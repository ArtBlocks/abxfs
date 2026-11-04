/**
 * Semver tag helpers.
 *
 * ABX FS treats semver as an off-chain convention, not a protocol feature. The on-chain primitive is a
 * flat `tag → version` map in `ProjectHook`, which validates the tag charset (`.` is permitted
 * precisely so semver shapes fit) and nothing about ordering. Range resolution and precedence live
 * here, client-side — chain-free, so these tests need no harness.
 */
import { describe, expect, it } from "vitest";

import { isSemverTag, pickLatestSemverTag } from "../src/semver.js";

describe("semver helpers", () => {
  it("isSemverTag accepts canonical + pre-release / build metadata shapes", () => {
    const yes = ["v1.0.0", "1.0.0", "v1.2.3-rc.1", "v1.2.3-alpha.1+build.5"];
    const no = ["stable", "1.2", "v1", "release-2024"];
    for (const t of yes) expect(isSemverTag(t), t).toBe(true);
    for (const t of no) expect(isSemverTag(t), t).toBe(false);
  });

  it("pickLatestSemverTag respects semver precedence", () => {
    // 1.0.10 > 1.0.1 numerically, not lexically — the case a naive string sort gets wrong.
    const tags = ["v1.0.0", "stable", "v1.0.1", "v1.0.0-rc.1", "v1.0.10"];
    expect(pickLatestSemverTag(tags)).toBe("v1.0.10");
  });

  it("pickLatestSemverTag returns undefined when no semver-shaped tag is present", () => {
    expect(pickLatestSemverTag(["stable", "nightly"])).toBeUndefined();
  });

  it("pickLatestSemverTag honours prerelease ordering (1.2.3-rc.1 < 1.2.3)", () => {
    expect(pickLatestSemverTag(["v1.2.3-rc.1", "v1.2.3"])).toBe("v1.2.3");
    expect(pickLatestSemverTag(["v1.2.3-alpha", "v1.2.3-beta"])).toBe("v1.2.3-beta");
  });
});
