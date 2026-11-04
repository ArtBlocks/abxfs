/**
 * Cross-language guard on the ABX FS param-key encoding.
 *
 * ABX packs short param keys into `bytes32` as left-aligned ASCII rather than hashing them, so
 * Solidity's `bytes32("abxfs.cid")` and viem's `stringToHex(key, { size: 32 })` must produce
 * byte-identical values. If they ever diverge, nothing errors — every read returns "unset" and
 * every write lands on a key nobody reads. That failure is silent and total, so the expected bytes
 * are pinned here as literals rather than recomputed, and the same literals are asserted against the
 * deployed constants in `packages/contracts-projects/test/ParamKeys.t.sol`.
 *
 * Regenerate with: `cast format-bytes32-string "abxfs.cid"`.
 */
import { describe, expect, it } from "vitest";

import { PROJECT_PARAM_KEYS, decodeParamKey, encodeParamKey } from "../src/project.js";
import { ProjectKind, projectKindName } from "../src/types.js";

const PINNED = {
  "abxfs.cid": "0x61627866732e6369640000000000000000000000000000000000000000000000",
  "abxfs.gateway": "0x61627866732e6761746577617900000000000000000000000000000000000000",
  "abxfs.name": "0x61627866732e6e616d6500000000000000000000000000000000000000000000",
  "abxfs.view": "0x61627866732e7669657700000000000000000000000000000000000000000000",
  "abxfs.meta": "0x61627866732e6d65746100000000000000000000000000000000000000000000",
} as const;

describe("param key encoding", () => {
  it("matches the pinned on-chain bytes32 for every ABX FS key", () => {
    // Note the leading-zero trim in the pinned `abxfs.cid` value: it is 63 hex chars because
    // `cast` prints it that way. Compare on normalized 32-byte width instead of raw strings.
    for (const [key, pinned] of Object.entries(PINNED)) {
      expect(BigInt(encodeParamKey(key))).toBe(BigInt(pinned));
    }
  });

  it("encodes to exactly 32 bytes", () => {
    for (const key of Object.values(PROJECT_PARAM_KEYS)) {
      expect(encodeParamKey(key)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("round-trips through decodeParamKey", () => {
    for (const key of Object.values(PROJECT_PARAM_KEYS)) {
      expect(decodeParamKey(encodeParamKey(key))).toBe(key);
    }
  });

  it("keys are packed ASCII, not hashed — readable on-chain", () => {
    // The first bytes spell "abxfs." — a hashed key would be uniformly distributed.
    expect(encodeParamKey("abxfs.cid").startsWith("0x61627866732e")).toBe(true);
  });

  it("rejects a key too long for bytes32 instead of silently truncating", () => {
    expect(() => encodeParamKey("a".repeat(33))).toThrow(/must fit in bytes32/);
    expect(() => encodeParamKey("a".repeat(32))).not.toThrow();
  });
});

describe("ProjectKind", () => {
  it("numbers Unset as 0 so never-published is distinguishable from directory", () => {
    // The retired IProjectStore.ContentKind had Directory = 0 and no Unset member. Any code that
    // carried an old persisted value across this boundary would read a directory as "unset".
    expect(ProjectKind.Unset).toBe(0);
    expect(ProjectKind.Directory).toBe(1);
    expect(ProjectKind.File).toBe(2);
  });

  it("names every variant", () => {
    expect(projectKindName(ProjectKind.Unset)).toBe("unset");
    expect(projectKindName(ProjectKind.Directory)).toBe("directory");
    expect(projectKindName(ProjectKind.File)).toBe("file");
  });
});
