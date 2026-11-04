/**
 * Pure unit tests for project name + tag name validators. These mirror the
 * Solidity `_validateName` / `_validateTag` rules in `ProjectStore.sol`. If
 * any case here disagrees with the on-chain validator, the user gets a green
 * client-side check followed by a confusing on-chain revert — the worst of
 * both worlds. Treat each case here as a dual-anchor: it's also asserted in
 * `packages/contracts-projects/test/ProjectHook.t.sol`.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_NAME_BYTES,
  MAX_TAG_BYTES,
  RESERVED_TAGS,
  suggestProjectName,
  validateProjectName,
  validateTagName,
} from "../src/validate.js";

describe("validateProjectName", () => {
  // `abxfs.name` is a String PostParam with no on-chain grammar — the hook bounds its size and
  // nothing else. ProjectStore's `^[a-z0-9][a-z0-9_-]*$` is gone with the contract, so these
  // assertions deliberately invert several of the old ones.

  it("accepts slugs, and also the display names ProjectStore used to reject", () => {
    for (const name of [
      "a",
      "abc-123",
      "abc_123",
      "0",
      "My Cool Art",
      "Ambient Study #4",
      "café",
      "αβγ",
      "生成芸術",
      "🌊 tide",
      "v1.2 (final)",
      "-leading-hyphen",
    ]) {
      expect(validateProjectName(name).ok, name).toBe(true);
    }
  });

  it("accepts exactly the byte cap", () => {
    expect(validateProjectName("a".repeat(MAX_PROJECT_NAME_BYTES)).ok).toBe(true);
  });

  it("rejects empty input with 'Required'", () => {
    const r = validateProjectName("");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Required");
  });

  it("rejects whitespace-only input — it renders as an unnamed project", () => {
    expect(validateProjectName("   ").ok).toBe(false);
    expect(validateProjectName("\t").ok).toBe(false);
  });

  it("rejects past the byte cap, and reports BYTES not characters", () => {
    const r = validateProjectName("a".repeat(MAX_PROJECT_NAME_BYTES + 1));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(MAX_PROJECT_NAME_BYTES));
  });

  it("measures the cap in UTF-8 bytes, so a short multi-byte name can still be too long", () => {
    // Each of these is 4 bytes; 33 of them is 132 bytes but only 33 JS code points, so a
    // character-based check would wrongly accept it and the hook would revert BlobTooLarge.
    const emoji = "🌊".repeat(33);
    expect(emoji.length).toBeLessThan(MAX_PROJECT_NAME_BYTES);
    const r = validateProjectName(emoji);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bytes/i);
  });

  it("rejects control characters — they corrupt the documents the name is rendered into", () => {
    for (const name of ["ab\u0000cd", "ab\ncd", "ab\u001bcd", "ab\u2028cd"]) {
      const r = validateProjectName(name);
      expect(r.ok, JSON.stringify(name)).toBe(false);
      expect(r.error, JSON.stringify(name)).toMatch(/control/i);
    }
  });
});

describe("validateTagName", () => {
  it("accepts semver-style tags (dots are allowed for tags)", () => {
    for (const tag of ["v1.0.0", "1.2.3", "1.2.3-rc1", "stable", "v1", "abc.def"]) {
      expect(validateTagName(tag).ok, tag).toBe(true);
    }
  });

  it("rejects the reserved 'latest' tag", () => {
    const r = validateTagName("latest");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reserved/i);
  });

  it("does not reserve other strings beyond `latest`", () => {
    expect(RESERVED_TAGS).toEqual(["latest"]);
  });

  it("rejects empty input", () => {
    expect(validateTagName("").ok).toBe(false);
  });

  it("rejects tags exceeding the byte cap", () => {
    expect(validateTagName("a".repeat(MAX_TAG_BYTES + 1)).ok).toBe(false);
  });

  it("rejects uppercase / spaces", () => {
    for (const tag of ["V1.0.0", "Stable", "rc 1"]) {
      expect(validateTagName(tag).ok, tag).toBe(false);
    }
  });

  it("rejects leading non-alnum", () => {
    for (const tag of [".1.0.0", "-rc1", "_dev"]) {
      const r = validateTagName(tag);
      expect(r.ok, tag).toBe(false);
      expect(r.error, tag).toMatch(/start/i);
    }
  });
});

describe("suggestProjectName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(suggestProjectName("My Cool Project")).toBe("my-cool-project");
  });

  it("collapses runs of disallowed characters into a single hyphen", () => {
    expect(suggestProjectName("foo / bar / baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(suggestProjectName(" --foo-- ")).toBe("foo");
  });

  it("strips a leading underscore so the first char is alnum", () => {
    expect(suggestProjectName("_foo")).toBe("foo");
  });

  it("truncates to the byte cap", () => {
    const long = "a".repeat(MAX_PROJECT_NAME_BYTES + 10);
    expect(suggestProjectName(long).length).toBe(MAX_PROJECT_NAME_BYTES);
  });

  it("returns '' when nothing salvageable remains", () => {
    expect(suggestProjectName("!!!")).toBe("");
    expect(suggestProjectName("   ")).toBe("");
  });

  it("produces output that always passes validateProjectName (when non-empty)", () => {
    for (const input of [
      "Project Zero",
      "Hello, World!",
      "fooBarBaz",
      "über cool",
      "v1.2.3-final",
    ]) {
      const suggested = suggestProjectName(input);
      if (suggested.length > 0) {
        expect(validateProjectName(suggested).ok, `input=${input} → ${suggested}`).toBe(true);
      }
    }
  });
});
