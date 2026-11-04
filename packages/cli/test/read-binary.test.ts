import { describe, expect, it } from "vitest";
import { looksBinary } from "../src/commands/read.js";

describe("abxfs read: binary to a terminal", () => {
  it("text is not binary; NUL, ESC, control and invalid UTF-8 are", () => {
    expect(looksBinary(new TextEncoder().encode("hello\nwörld\t!"))).toBe(false);
    expect(looksBinary(Uint8Array.from([0x68, 0x00]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("\u001b[2J"))).toBe(true);
    expect(looksBinary(Uint8Array.from([0xff, 0xfe, 0x41]))).toBe(true);
    expect(looksBinary(Uint8Array.from([0x07]))).toBe(true);
  });
});
