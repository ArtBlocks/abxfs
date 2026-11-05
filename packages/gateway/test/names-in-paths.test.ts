/**
 * Entry names are bytes on chain, not necessarily UTF-8. A path segment is percent-decoded to BYTES and carried in the
 * SDK's lossless text form (`decodeEntryName`), and a listing links a name by its bytes, so a name that is not UTF-8
 * resolves through a standard `%FF` URL and through the link the gateway itself emits. The safety rules are applied
 * to the bytes: no `/`, `\`, control byte, `.` or `..` can reach a store however it is spelled.
 */
import { describe, expect, it } from "vitest";

import { decodeEntryName } from "@artblocks/abxfs-sdk/names";

import { encodePathSegment, isUnsafeNameBytes, parseSubpath, segmentBytes } from "../src/addressing.js";
import { GatewayError } from "../src/errors.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

describe("path segments are bytes", () => {
  it("decodes UTF-8, a leading BOM and bytes that are not UTF-8 without loss", () => {
    expect(parseSubpath(["%C3%A9t%C3%A9.html"])).toBe("été.html");
    expect(parseSubpath(["caf%E9.html"])).toBe("caf\\xe9.html");
    expect(parseSubpath(["%EF%BB%BFindex.html"])).toBe("﻿index.html");
    expect(parseSubpath(["a", "%FF", "b c"])).toBe("a/\\xff/b c");
  });

  it("refuses every unsafe name however it is spelled", () => {
    for (const seg of ["%2e%2E", "..", ".", "%2E", "a%2fb", "a%5Cb", "%5Cxe9", "a%00b", "a%7fb", "a%1Fb"]) {
      expect(() => parseSubpath([seg]), seg).toThrow(GatewayError);
    }
    expect(isUnsafeNameBytes(new Uint8Array())).toBe(true);
    expect(isUnsafeNameBytes(utf8("..."))).toBe(false);
  });

  it("answers a malformed escape with a 400", () => {
    for (const seg of ["%", "%A", "%G1", "a%zz"]) {
      try {
        segmentBytes(seg);
        throw new Error(`accepted ${seg}`);
      } catch (err) {
        expect((err as GatewayError).status, seg).toBe(400);
      }
    }
  });

  it("links a UTF-8 name exactly as encodeURIComponent does", () => {
    const next = rng(7);
    const alphabet = ["a", "Z", "0", "-", "_", ".", "!", "~", "*", "'", "(", ")", " ", "/", "?", "#", "%", "&", "é", "€", "😀", " "];
    for (let n = 0; n < 2000; n++) {
      let s = "";
      for (let i = next() % 12; i >= 0; i--) s += alphabet[next() % alphabet.length];
      expect(encodePathSegment(utf8(s))).toBe(encodeURIComponent(s));
    }
  });

  it("round-trips any safe name through the link the gateway emits", () => {
    const next = rng(11);
    for (let n = 0; n < 2000; n++) {
      const bytes = Uint8Array.from({ length: 1 + (next() % 20) }, () => next());
      if (isUnsafeNameBytes(bytes)) continue;
      expect(parseSubpath([encodePathSegment(bytes)])).toBe(decodeEntryName(bytes));
    }
  });
});
