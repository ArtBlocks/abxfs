/**
 * DELTA AUDIT: differential fuzz of BatchIdScanner against JSON.parse, with random chunk splits (the auditor's PoC,
 * kept as a regression). A divergence where the scanner returns ids (kind "ids") that differ from JSON.parse's ids is a
 * bypass of strictBatchFetch. It also stands behind the removal of two branches the scanner could never take (a depth
 * below zero, and an element id already unreadable when its capture ends): valid JSON in any split is never refused.
 */
import { describe, expect, it } from "vitest";
import { BatchIdScanner } from "../../src/upstream.js";

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

const nastyStrings = ['"', "\\", '\\"', "[", "]", "{", "}", ",", ":", '"id":', "id", "\u0000", " ", "é", "😀", "\\u0022", "a\"b", "\n"];
function randString(): string {
  let s = "";
  const n = Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) s += rnd() < 0.5 ? pick(nastyStrings) : String.fromCharCode(32 + Math.floor(rnd() * 90));
  return s;
}
function randValue(depth: number): unknown {
  const r = rnd();
  if (depth > 3 || r < 0.3) return pick([1, 2, 0, -1, 1.5, null, true, false, randString(), "0x" + "ab".repeat(Math.floor(rnd() * 5))]);
  if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => randValue(depth + 1));
  const o: Record<string, unknown> = {};
  const n = Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) o[rnd() < 0.3 ? "id" : randString()] = randValue(depth + 1);
  return o;
}
/** Serialise with random whitespace and random key escaping (id for id), possibly duplicate keys. */
function ser(v: unknown, top = false): string {
  const ws = () => pick(["", "", " ", "\n", "\t ", "\r\n"]);
  if (Array.isArray(v)) return "[" + ws() + v.map((x) => ws() + ser(x) + ws()).join(",") + ws() + "]";
  if (v && typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => {
      let key = JSON.stringify(k);
      if (k === "id" && rnd() < 0.3) key = pick(['"\\u0069d"', '"i\\u0064"', '"\\u0069\\u0064"']);
      return ws() + key + ws() + ":" + ws() + ser(x) + ws();
    });
    if (top && rnd() < 0.1) parts.push(`"id":${pick(["1", "2", '"1"', "null"])}`); // duplicate id key
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(v);
}
function scan(text: string): ReturnType<BatchIdScanner["finish"]> {
  const bytes = new TextEncoder().encode(text);
  const s = new BatchIdScanner();
  let i = 0;
  while (i < bytes.length) {
    const n = 1 + Math.floor(rnd() * 7);
    s.push(bytes.subarray(i, i + n));
    i += n;
  }
  return s.finish();
}

describe("scanner vs JSON.parse", () => {
  it("never reports ids that JSON.parse disagrees with", () => {
    let agreed = 0, refused = 0, unreadable = 0;
    for (let t = 0; t < 30000; t++) {
      const n = 1 + Math.floor(rnd() * 4);
      const arr = Array.from({ length: n }, () => {
        const o = (rnd() < 0.85 ? { jsonrpc: "2.0", id: pick([1, 2, 3, "1", null, 0]), result: randValue(0) } : randValue(0)) as unknown;
        return o;
      });
      const text = (rnd() < 0.1 ? "﻿" : "") + "[" + arr.map((x) => ser(x, true)).join(",") + "]";
      // inject top-level duplicate ids sometimes by hand
      const parsed = JSON.parse(text.replace(/^﻿/, "")) as unknown[];
      const verdict = scan(text);
      if (verdict.kind === "ids") {
        const expected = parsed.map((e) => (e && typeof e === "object" && !Array.isArray(e) ? (Object.prototype.hasOwnProperty.call(e, "id") ? (e as { id: unknown }).id : "MISSING") : "MISSING"));
        const got = verdict.ids.map((x) => (typeof x === "symbol" ? (x.description === "missing id" ? "MISSING" : "UNREADABLE") : x));
        // UNREADABLE is a refusal; anything else must match exactly.
        for (let k = 0; k < expected.length; k++) {
          if (got[k] === "UNREADABLE") { unreadable++; continue; }
          if (typeof got[k] === "object" && got[k] !== null) continue; // object/array ids never equal a request id
          expect(got[k], text).toEqual(expected[k]);
        }
        expect(got.length, text).toBe(expected.length);
        agreed++;
      } else refused++;
    }
    expect(agreed).toBeGreaterThan(1000); expect(refused).toBe(0); expect(unreadable).toBeGreaterThan(10);
  });
});
