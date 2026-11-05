/**
 * The project-host format is the one place "which project is this request?" is decided, so it must have
 * exactly one spelling per project: any second spelling is a way around a blocklist.
 */
import { describe, expect, it } from "vitest";

import {
  contentLabel,
  contentOrigin,
  parseContentHost,
  parseContentLabel,
  rootContentLabel,
} from "../src/content-host.js";
import type { AbxfsCid } from "../src/types.js";

const ORG = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ORG_L = ORG.toLowerCase().slice(2);
const BASE = "content.example";

describe("contentLabel", () => {
  it("is chain-org-id, lowercase, no 0x", () => {
    expect(contentLabel({ chainId: 84532, org: ORG, tokenId: 3 })).toBe(`84532-${ORG_L}-3`);
    expect(contentLabel({ chainId: 8453, org: ORG, tokenId: 0n, version: 2 })).toBe(`8453-${ORG_L}-0-v2`);
  });

  it("is a single DNS label of at most 63 characters, at the largest sizes it accepts", () => {
    const l = contentLabel({ chainId: 9_999_999_999, org: ORG, tokenId: 9_999_999_999n });
    expect(l.length).toBeLessThanOrEqual(63);
    expect(l).not.toContain(".");
    expect(parseContentLabel(l)).not.toBeNull();
  });

  it("refuses a label that would pass 63 characters rather than emit one DNS would reject", () => {
    expect(() => contentLabel({ chainId: 9_999_999_999, org: ORG, tokenId: 9_999_999_999n, version: 999_999_999 })).toThrow(/63/);
    expect(parseContentLabel(`9999999999-${ORG_L}-9999999999-v999999999`)).toBeNull();
  });

  it("refuses what it cannot represent", () => {
    expect(() => contentLabel({ chainId: 0, org: ORG, tokenId: 1 })).toThrow();
    expect(() => contentLabel({ chainId: 1, org: "0x12", tokenId: 1 })).toThrow();
    expect(() => contentLabel({ chainId: 1, org: ORG, tokenId: -1 })).toThrow();
    expect(() => contentLabel({ chainId: 1, org: ORG, tokenId: 1, version: 0 })).toThrow();
  });
});

describe("parseContentLabel is strict and canonical", () => {
  const ok = `84532-${ORG_L}-3`;

  it("round-trips", () => {
    expect(parseContentLabel(ok)).toEqual({ kind: "project", chainId: 84532, org: `0x${ORG_L}`, tokenId: 3n });
    expect(parseContentLabel(`${ok}-v7`)).toMatchObject({ version: 7 });
  });

  it("accepts no second spelling of the same project", () => {
    for (const bad of [
      `+84532-${ORG_L}-3`,
      `084532-${ORG_L}-3`,
      `0x14a34-${ORG_L}-3`,
      `84532.0-${ORG_L}-3`,
      `8.4532e4-${ORG_L}-3`,
      `84532-${ORG_L}-03`,
      `84532-${ORG_L}-3-v0`,
      `84532-${ORG_L}-3-v01`,
      `84532-0x${ORG_L}-3`,
      `84532-${ORG_L.toUpperCase()}-3`,
      `84532-${ORG_L.slice(1)}-3`,
      `${ok}-V2`,
      `${ok}-`,
      ` ${ok}`,
      "",
    ]) {
      expect(parseContentLabel(bad), bad).toBeNull();
    }
  });
});

describe("root labels", () => {
  const root = `0x${"ab".repeat(16)}${"01".repeat(16)}` as AbxfsCid;

  it("name their chain, fit one label and round-trip", () => {
    const l = rootContentLabel(84532, root);
    expect(l).toMatch(/^84532-[a-z2-7]{52}$/);
    expect(parseContentLabel(l)).toEqual({ kind: "root", chainId: 84532, rootCid: root });
    // A ten-digit chain id is the longest a label holds: exactly 63 characters.
    const longest = rootContentLabel(4_294_967_295, root);
    expect(longest).toHaveLength(63);
    expect(parseContentLabel(longest)).toEqual({ kind: "root", chainId: 4_294_967_295, rootCid: root });
    expect(() => rootContentLabel(10_000_000_000, root)).toThrow(/chain id out of range/);
    expect(() => rootContentLabel(0, root)).toThrow(/chain id out of range/);
  });

  it("the same root on two chains is two labels, and the chain-less form is gone", () => {
    expect(rootContentLabel(1, root)).not.toBe(rootContentLabel(8453, root));
    const bare = rootContentLabel(1, root).slice(2);
    for (const old of [`c-${bare}`, bare, `1-c-${bare}`, `01-${bare}`, `+1-${bare}`]) expect(parseContentLabel(old), old).toBeNull();
  });

  it("refuse non-canonical base32 (non-zero padding bits would be a second spelling)", () => {
    const l = rootContentLabel(84532, root);
    // The last character carries 1 data bit and 4 padding bits. Flipping a padding bit leaves the
    // decoded bytes unchanged, so accepting it would give one root two spellings.
    const flipped = "abcdefghijklmnopqrstuvwxyz234567"["abcdefghijklmnopqrstuvwxyz234567".indexOf(l.slice(-1)) ^ 1];
    expect(parseContentLabel(l.slice(0, -1) + flipped)).toBeNull();
    expect(parseContentLabel(l.toUpperCase())).toBeNull();
    expect(parseContentLabel(l + "a")).toBeNull();
  });
});

describe("parseContentHost", () => {
  const label = `84532-${ORG_L}-3`;

  it("takes exactly one label under the content domain", () => {
    expect(parseContentHost(`${label}.${BASE}`, BASE)).toMatchObject({ kind: "project", tokenId: 3n });
    expect(parseContentHost(`${label}.localhost:3001`, "localhost:3001")).toMatchObject({ kind: "project" });
  });

  it("is case-insensitive on the wire, and only that", () => {
    expect(parseContentHost(`${label}.${BASE}`.toUpperCase(), BASE)).toMatchObject({ kind: "project" });
  });

  it("refuses the base itself, a deeper name, another domain, a lookalike suffix and a missing host", () => {
    expect(parseContentHost(BASE, BASE)).toBeNull();
    expect(parseContentHost(`x.${label}.${BASE}`, BASE)).toBeNull();
    expect(parseContentHost(`${label}.other.example`, BASE)).toBeNull();
    expect(parseContentHost(`${label}.evil${BASE}`, BASE)).toBeNull();
    expect(parseContentHost(`${label}.${BASE}:8080`, BASE)).toBeNull();
    expect(parseContentHost(undefined, BASE)).toBeNull();
    expect(parseContentHost(`www.${BASE}`, BASE)).toBeNull();
  });
});

describe("contentOrigin", () => {
  it("builds the origin for a project or a root", () => {
    expect(contentOrigin({ chainId: 84532, org: ORG, tokenId: 3 }, BASE)).toBe(`https://84532-${ORG_L}-3.${BASE}`);
    expect(contentOrigin({ chainId: 84532, org: ORG, tokenId: 3 }, "localhost:3001", "http")).toBe(
      `http://84532-${ORG_L}-3.localhost:3001`,
    );
  });
});

describe("label budget against the per-org project cap", () => {
  // OrgFactory.MAX_PROJECTS: ids are 0..999_999, so six digits at most.
  const MAX_ID = 999_999n;

  it("fits the largest id on the longest chain id the label allows", () => {
    const l = contentLabel({ chainId: 9_999_999_999, org: ORG, tokenId: MAX_ID });
    expect(l.length).toBe(10 + 1 + 40 + 1 + 6);
    expect(parseContentLabel(l)).not.toBeNull();
  });

  it("leaves room for a pinned version on every chain the site ships today", () => {
    // Base 8453, Base Sepolia 84532, Ethereum Sepolia 11155111: even the 8-digit one fits an 8-digit version.
    for (const chainId of [8453, 84532, 11155111]) {
      const digits = String(chainId).length;
      const room = 63 - (digits + 1 + 40 + 1 + 6) - 2; // minus "-v"
      expect(room, String(chainId)).toBeGreaterThanOrEqual(5);
      expect(() => contentLabel({ chainId, org: ORG, tokenId: MAX_ID, version: Number("9".repeat(Math.min(room, 9))) })).not.toThrow();
    }
  });

  it("on the longest chain id a pinned version has only 3 digits, and says so instead of emitting a bad label", () => {
    expect(() => contentLabel({ chainId: 9_999_999_999, org: ORG, tokenId: MAX_ID, version: 999 })).not.toThrow();
    expect(() => contentLabel({ chainId: 9_999_999_999, org: ORG, tokenId: MAX_ID, version: 1000 })).toThrow(/63/);
  });
});
