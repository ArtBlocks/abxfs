/** Audit round 2, pass A: terminal-control stripping. */
import { describe, expect, it } from "vitest";
import { stripTerminalControl } from "../../src/display.js";

const ALPHA = ["\x1b", "[", "]", "P", "\\", "\x07", "\x9b", "\x9d", "\x90", "\x9c", "0", "3", "1", ";", "m", "A", "52", "c", "\n", "\r", "‮", "x", "_", "^", "X", "⁦"];
function rnd(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe("stripTerminalControl", () => {
  it("fuzz: output never contains ESC, any C0/C1 control, DEL or bidi overrides (200k random strings)", () => {
    const r = rnd(7);
    for (let i = 0; i < 200_000; i++) {
      let s = "";
      const n = 1 + Math.floor(r() * 14);
      for (let j = 0; j < n; j++) s += ALPHA[Math.floor(r() * ALPHA.length)];
      const out = stripTerminalControl(s);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(out), JSON.stringify(s)).toBe(false);
    }
  });
  it("reassembly attacks (inner sequence removal rebuilds an outer one) are neutralised", () => {
    for (const s of ["\x1b[3\x1b[31m1m", "\x1b\x1b[31m]52;c;AAAA\x07", "\x1b]52;c;\x1b[31mAAAA\x07", "\x1b\x1bP1$r\x1b\\q"]) {
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(stripTerminalControl(s))).toBe(false);
    }
  });
  it("remaining visible text of an OSC 52 clipboard write is dropped", () => {
    expect(stripTerminalControl("a\x1b]52;c;SGVsbG8=\x07b")).toBe("ab");
  });
  it("invisible characters beyond the base list are stripped: Unicode tag block, interlinear annotation, musical format, Arabic number signs, Braille blank", () => {
    for (const ch of ["\u{E0041}", "\u{E007F}", "\ufff9", "\ufffa", "\ufffb", "\u{1D173}", "\u{1D17A}", "\u0600", "\u2800", "\u200b"]) {
      expect(stripTerminalControl("a" + ch + "b"), ch.codePointAt(0)!.toString(16)).toBe("ab");
    }
  });
  it("non-strings never throw and are stripped like strings", () => {
    expect(stripTerminalControl(undefined)).toBe("");
    expect(stripTerminalControl({ toString() { return "\x1b[2J"; } })).toBe("");
    expect(stripTerminalControl(new Error("x\u001b[2Jy"))).toBe("Error: xy");
    expect(stripTerminalControl(123n)).toBe("123");
  });
});
