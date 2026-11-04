/**
 * Delta audit (informational): a JavaScript string can hold a lone UTF-16 surrogate, and `TextEncoder` writes U+FFFD in
 * its place, so `"\uD800"` and `"\uFFFD"` were two spellings of the same name bytes. Text that is not well formed is now
 * no name's spelling: `encodeEntryName` refuses it, a read with it names no entry, and an upload path holding it is
 * refused by name. Also the branches of the UTF-8 sequence reader the corpus had not reached (3- and 4-byte leads and
 * their bounds), and the lenient read encoding of a non-canonical spelling.
 */
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, toFunctionSelector, type Hex, type PublicClient } from "viem";

import {
  EntryNameSpellingError,
  assertLiteralPath,
  decodeEntryName,
  encodeEntryName,
  entryNameBytes,
  entryNameBytesLenient,
  isUtf8Name,
  isWellFormedText,
} from "../../src/names.js";
import { lookupEntry, resolvePath } from "../../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("text that is not well formed is no name's spelling", () => {
  it("a lone surrogate and U+FFFD no longer reach the same bytes", () => {
    expect(isWellFormedText("\uFFFD")).toBe(true);
    expect(isWellFormedText("\u{1F600}")).toBe(true); // a pair is one code point
    for (const lone of ["\uD800", "\uDFFF", "a\uD83Db", "\uDE00x", "x\uD83D"]) {
      expect(isWellFormedText(lone)).toBe(false);
      expect(() => encodeEntryName(lone)).toThrow(EntryNameSpellingError);
      expect(() => encodeEntryName(lone)).toThrow(/lone UTF-16 surrogate/);
      expect(() => entryNameBytes({ name: lone })).toThrow(EntryNameSpellingError);
      expect(() => assertLiteralPath(`dir/${lone}`)).toThrow(/lone UTF-16 surrogate/);
    }
    expect(hex(encodeEntryName("\uFFFD"))).toBe("efbfbd");
    expect(hex(encodeEntryName("\u{1F600}"))).toBe("f09f9880");
    // A lone surrogate next to an escape is refused before the escape is read.
    expect(() => encodeEntryName("\\xff\uD800")).toThrow(/lone UTF-16 surrogate/);
  });

  it("for a read, a lone surrogate is sent as a backslash, which names no entry", () => {
    expect(hex(entryNameBytesLenient("\uD800"))).toBe("5c");
    expect(hex(entryNameBytesLenient("a\uDC00b"))).toBe("615c62");
    expect(hex(entryNameBytesLenient("\uFFFD"))).toBe("efbfbd");
  });

  it("a lookup or path with a lone surrogate goes out as those bytes, never as viem's U+FFFD text", async () => {
    const sent: Hex[] = [];
    let viaText = 0;
    const client = {
      async readContract() {
        viaText++;
        return ["0x" + "11".repeat(32), false];
      },
      async call({ data }: { data: Hex }) {
        sent.push(data);
        // `PathNotFound()` / not found: the contract decides.
        throw Object.assign(new Error("execution reverted"), { data: "0x" });
      },
    } as unknown as PublicClient;
    const addrs = { chunkStore: "0x1", fileStore: "0x2", directoryStore: "0x00000000000000000000000000000000000000d1" } as unknown as ContractAddresses;
    const dir = ("0x32" + "00".repeat(31)) as AbxfsCid;
    await expect(lookupEntry(client, addrs, dir, "\uD800")).rejects.toThrow();
    await expect(resolvePath(client, addrs, dir, "a/\uD800")).rejects.toThrow();
    expect(viaText).toBe(0);
    // The real selectors, with the name ABI-encoded as bytes in the string's place.
    const argOf = (data: Hex) => decodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], `0x${data.slice(10)}`)[1];
    expect(sent[0]!.slice(0, 10)).toBe(toFunctionSelector("lookup(bytes32,string)"));
    expect(argOf(sent[0]!)).toBe("0x5c");
    expect(sent[1]!.slice(0, 10)).toBe(toFunctionSelector("resolvePath(bytes32,string)"));
    expect(argOf(sent[1]!)).toBe("0x612f5c");
  });
});

describe("the UTF-8 sequence reader, lead by lead (Unicode table 3-7)", () => {
  // [bytes, text form]: each well-formed sequence decodes; each ill-formed one escapes its lead and resynchronises.
  const cases: Array<[number[], string]> = [
    [[0xc2, 0x80], "\u0080"],
    [[0xc2, 0x41], "\\xc2A"],
    [[0xe0, 0xa0, 0x80], "\u0800"],
    [[0xe0, 0x80, 0x80], "\\xe0\\x80\\x80"], // overlong
    [[0xe1, 0x80, 0x80], "\u1000"],
    [[0xec, 0xbf], "\\xec\\xbf"], // truncated
    [[0xee, 0x80, 0x80], "\uE000"],
    [[0xef, 0xbb, 0xbf, 0x41], "\uFEFFA"], // a leading BOM is kept
    [[0xed, 0x9f, 0xbf], "\uD7FF"],
    [[0xed, 0xa0, 0x80], "\\xed\\xa0\\x80"], // an encoded surrogate
    [[0xf0, 0x90, 0x80, 0x80], "\u{10000}"],
    [[0xf0, 0x80, 0x80, 0x80], "\\xf0\\x80\\x80\\x80"], // overlong
    [[0xf1, 0x80, 0x80, 0x80], "\u{40000}"],
    [[0xf3, 0x80, 0x80], "\\xf3\\x80\\x80"], // truncated
    [[0xf4, 0x8f, 0xbf, 0xbf], "\u{10FFFF}"],
    [[0xf4, 0x90, 0x80, 0x80], "\\xf4\\x90\\x80\\x80"], // past U+10FFFF
    [[0xf5, 0x41], "\\xf5A"],
    [[0x41, 0xff, 0xe2, 0x82, 0xac], "A\\xff\u20AC"],
  ];
  for (const [bytes, text] of cases) {
    it(`${hex(Uint8Array.from(bytes))} <-> ${JSON.stringify(text)}`, () => {
      const b = Uint8Array.from(bytes);
      expect(decodeEntryName(b)).toBe(text);
      expect(hex(encodeEntryName(text))).toBe(hex(b));
      expect(isUtf8Name(b)).toBe(!text.includes("\\"));
    });
  }

  it("a non-canonical spelling is refused for writes, and read as its plain UTF-8", () => {
    // `\xc3\xa9` is the escape of bytes that ARE UTF-8 (é): not how `decodeEntryName` writes them.
    expect(() => encodeEntryName("\\xc3\\xa9")).toThrow(EntryNameSpellingError);
    expect(() => encodeEntryName("\\x5c")).toThrow(EntryNameSpellingError);
    expect(() => encodeEntryName("\\xZZ")).toThrow(EntryNameSpellingError);
    expect(new TextDecoder().decode(entryNameBytesLenient("\\xc3\\xa9"))).toBe("\\xc3\\xa9");
    expect(new TextDecoder().decode(entryNameBytesLenient("a\\b"))).toBe("a\\b");
  });
});
