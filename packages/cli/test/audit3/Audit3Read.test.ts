import { describe, expect, it } from "vitest";
import { looksBinary } from "../../src/commands/read.js";
import { stripTerminalControl } from "@artblocks/abxfs-sdk";

const enc = (s: string) => new TextEncoder().encode(s);

describe("abxfs read TTY guard", () => {
  it("an escape sequence after the first 8192 bytes is found (the whole buffer is inspected)", () => {
    expect(looksBinary(enc("a".repeat(8192) + "\u001b]52;c;ZXZpbA==\u0007\u001b[2J"))).toBe(true);
    expect(looksBinary(enc("a".repeat(500_000) + "\u001b[2J"))).toBe(true);
  });
  it("C1 controls (U+009B CSI, U+009D OSC) and bidi / invisible characters are unsafe", () => {
    for (const bad of ["hello \u009b2J", "x\u009d0;title\u0007", "a\u202eb", "a\u2066b", "a\u200bb", "a\ufeffb", "a\u{e0100}b"]) {
      expect(looksBinary(enc(bad)), JSON.stringify(bad)).toBe(true);
    }
  });
  it("ordinary text, accents, CJK, emoji, tabs and newlines still print", () => {
    expect(looksBinary(enc("hello\nwörld\t! 漢字 🎉\r\n"))).toBe(false);
    expect(looksBinary(enc("a".repeat(100_000)))).toBe(false);
  });
});
describe("stripTerminalControl", () => {
  it("leaves no control residue", () => {
    const hostile = ["\u001b[31mred\u001b[0m", "\u001b]0;title\u0007x", "a\u001b\u200b[2Jb", "\u009b2Jx", "\u001bPq\u001b\\x", "x\u202ey", "a\u{e0100}b", "a b c"];
    for (const h of hostile) expect(/[\u0000-\u001f\u007f-\u009f]/.test(stripTerminalControl(h)), JSON.stringify(h)).toBe(false);
  });
});
