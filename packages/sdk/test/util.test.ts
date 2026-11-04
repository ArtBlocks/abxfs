import { describe, expect, it } from "vitest";

import {
  chunk,
  concatBytes,
  fromHex,
  inferMimeType,
  toHex,
  validateRelativePath,
} from "../src/util.js";

describe("hex helpers", () => {
  it("toHex / fromHex roundtrip", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xab, 0xff]);
    expect(toHex(bytes)).toBe("0x0001abff");
    expect(fromHex("0x0001abff")).toEqual(bytes);
    expect(fromHex("0001abff")).toEqual(bytes);
  });

  it("fromHex rejects odd-length", () => {
    expect(() => fromHex("0xabc")).toThrow(/odd-length/);
  });
});

describe("concatBytes", () => {
  it("concatenates", () => {
    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

describe("chunk", () => {
  it("chunks arrays", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("inferMimeType", () => {
  it("maps common extensions", () => {
    expect(inferMimeType("index.html")).toBe("text/html");
    expect(inferMimeType("a/b/x.js")).toBe("application/javascript");
    expect(inferMimeType("foo.unknown")).toBe("application/octet-stream");
  });
});

describe("validateRelativePath", () => {
  it.each([
    ["", /empty/],
    ["/abs", /relative/],
    ["..", /invalid path component/],
    ["a/..", /invalid path component/],
    ["./a", /invalid path component/],
    ["a//b", /invalid path component/],
  ])("rejects %s", (path, pattern) => {
    expect(() => validateRelativePath(path)).toThrow(pattern);
  });

  it.each(["a", "a/b", "a/b/c.txt", "deeply/nested/path/file.json"])(
    "accepts %s",
    (path) => {
      expect(() => validateRelativePath(path)).not.toThrow();
    },
  );
});
