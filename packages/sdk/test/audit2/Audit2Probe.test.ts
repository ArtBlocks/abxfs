import { describe, it, expect } from "vitest";
import { getAddress } from "viem";
import { appendFileSync } from "node:fs";
const log = (...a: unknown[]) => appendFileSync(process.env.A2LOG ?? "/tmp/a2.log", a.map((x) => typeof x === "string" ? x : JSON.stringify(x, (_k, v) => typeof v === "bigint" ? v.toString() : v)).join(" ") + "\n");
import {
  recipientProblem, assertSafeRecipient, externalUrlProblem, isUsableViewUrl,
  sanitizeDisplayName, stripTerminalControl, contentLabel, parseContentLabel, contentOrigin, parseContentHost,
} from "../../src/index.js";

const A = "0x52908400098527886E0F7030069857D2E4169EE7"; // checksummed sample
const lowerA = A.toLowerCase();

describe("Audit2 recipient", () => {
  it("rejects spelling variants", () => {
    const bad = ["0X" + lowerA.slice(2), " " + lowerA, lowerA + "​", "​" + lowerA, lowerA + "\n", "vitalik.eth",
      lowerA.slice(2), "0x" + "0".repeat(40), "0x" + "0".repeat(36) + "dead", "0xdead" + "0".repeat(36),
      "0x000000000000000000000000000000000000dEaD", "0x" + "0".repeat(39) + "1"];
    const out: Record<string, string | null> = {};
    for (const b of bad) out[JSON.stringify(b)] = recipientProblem(b);
    log("RECIPIENT", JSON.stringify(out, null, 1));
  });
  it("bad checksum is rejected, case flipped", () => {
    const i = A.split("").findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c));
    const flipped = A.slice(0, i) + (A[i] === A[i]!.toUpperCase() ? A[i]!.toLowerCase() : A[i]!.toUpperCase()) + A.slice(i + 1);
    expect(recipientProblem(flipped)).not.toBeNull();
    expect(recipientProblem(A)).toBeNull();
    expect(recipientProblem(lowerA)).toBeNull(); // documented weakness: no checksum for lowercase
    expect(recipientProblem(A.toUpperCase().replace("0X", "0x"))).toBeNull(); // all-upper
  });
  it("other known burn / precompile / sentinel addresses", () => {
    const out: Record<string, string | null> = {};
    for (const a of ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000009",
      "0xffffffffffffffffffffffffffffffffffffffff", "0x000000000000000000000000000000000000000a",
      "0x1111111111111111111111111111111111111111", "0x0000000000000000000000000000000000000100",
      "0x4200000000000000000000000000000000000016"]) out[a] = recipientProblem(a);
    log("OTHERBURN", JSON.stringify(out, null, 1));
  });
  it("forbid list is case-insensitive and tolerates undefined", () => {
    expect(recipientProblem(lowerA, { forbid: [undefined, A] })).not.toBeNull();
  });
  it("assertSafeRecipient returns checksummed trimmed", () => {
    expect(assertSafeRecipient(" " + lowerA + " ")).toBe(getAddress(lowerA));
  });
});

describe("Audit2 url", () => {
  const cases = ["https://localhost./", "https://127.0.0.1./", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/",
    "https://127.1/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[::127.0.0.1]/", "https://[64:ff9b::7f00:1]/",
    "https://[2002:7f00:1::]/", "https://[::ffff:0:7f00:1]/", "https://[0:0:0:0:0:0:0:1]/", "https://user@example.com/",
    "https://example.com@127.0.0.1/", "https://169.254.169.254/", "https://169.254.169.254./", "https://metadata.google.internal./",
    "https://foo.local./", "https://xn--e1afmkfd.xn--p1ai/", "https://localtest.me/", "https://127.0.0.1.nip.io/",
    "https://LOCALHOST/", "https://foo.LOCALHOST/", "https://foo.localhost./", "https://localhost%2e/", "https://a%2eb/", "https://%31%32%37.0.0.1/",
    "https://100.64.0.1/", "https://192.0.2.1/", "https://198.51.100.1/", "https://[fec0::1]/", "https://[::]/", "https://[::ffff:a00:1]/",
    "https://0.0.0.0/", "https://[::ffff:0:0]/","https://example/", "https://[2001:db8::1]/", "https://[fd00::1]/", "https://1.1.1.1:8443/", "https://example.com:22/", "https://203.0.113.5/",
    "https://224.0.0.1/", "https://[::1.2.3.4]/", "https://[::7f00:1]/", "https://[::ffff:127.0.0.1.]/","https://bücher.de/", "https://exa​mple.com/",
    "https://192.168.1.1\t/", "https://１２７.0.0.1/", "https://127。0。0。1/", "https://①②⑦.0.0.1/"];
  it("prints which pass", () => {
    const passing: string[] = [];
    for (const c of cases) { if (externalUrlProblem(c) === null) passing.push(c); }
    log("URL_PASSING", JSON.stringify(passing, null, 1));
  });
});

// Reference port of ProjectLinks._view's character/length rule, over BYTES.
function solidityUsable(bytes: Uint8Array): boolean {
  const declared = bytes.length;
  if (declared > 512 || declared < 9) return false;
  // JSON/markup breakers, the RFC 3986 outlaws { } | ^, and what ends a Markdown link or a CSS url(): ( ) [ ].
  const unsafe = new Set([0x22, 0x26, 0x27, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5c, 0x5d, 0x5e, 0x60, 0x7b, 0x7c, 0x7d]);
  for (const c of bytes) { if (c < 0x21 || c > 0x7e || unsafe.has(c)) return false; }
  return new TextDecoder().decode(bytes.slice(0, 8)) === "https://";
}
describe("Audit2 isUsableViewUrl differential", () => {
  it("agrees with ported Solidity rule on 200k random strings", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pool = ["https://", "http://", "HTTPS://", " ", "\"", "'", "&", "<", ">", "\\", "`", "(", ")", "[", "]", "{", "}", "|", "^", "@", "a", "z", "/", ".", "%", "é", "​", "\u0000", "\u007f", "\u0080", "😀", "~", "!", "-", "\n"];
    let disagreements = 0; const ex: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      let s = rnd() < 0.8 ? "https://" : "";
      const n = Math.floor(rnd() * (rnd() < 0.02 ? 600 : 30));
      for (let j = 0; j < n; j++) s += pool[Math.floor(rnd() * pool.length)];
      const bytes = new TextEncoder().encode(s);
      if (solidityUsable(bytes) !== isUsableViewUrl(s)) { disagreements++; if (ex.length < 5) ex.push(JSON.stringify(s)); }
    }
    log("DIFF", disagreements, ex);
    expect(disagreements).toBe(0);
  });
  it("boundary: lengths 8,9,512,513 and lone surrogate", () => {
    expect(isUsableViewUrl("https://")).toBe(false);
    expect(isUsableViewUrl("https://a")).toBe(true);
    expect(isUsableViewUrl("https://" + "a".repeat(504))).toBe(true);
    expect(isUsableViewUrl("https://" + "a".repeat(505))).toBe(false);
    expect(isUsableViewUrl("https://a\ud800")).toBe(false);
  });
  it("usable-by-token but unsafe-for-client: usable view URLs the client would link", () => {
    for (const u of ["https://127.0.0.1/", "https://localhost./", "https://a@b/", "https://example.com/#<x>"]) {
      log("VIEW", u, isUsableViewUrl(u), externalUrlProblem(u));
    }
  });
});

describe("Audit2 sanitizers", () => {
  const nasty = ["a‮b", "a​b", "a⁦b⁩", "a\u0000b", "a\u001b[31mred", "\u001b]0;title\u0007x", "a\u0085b", "a b", "a᠎b",
    "a b", "a b", "a b", "a　b", "a️b", "\u{e0041}tag", "\u{1d173}x", "a؀b", "a۝b", "a‎b", "a⠀b", "aᅟb","a؜b", "a­b", "\u001b(0x", "\u001bP1$tfoo\u001b\\bar", "\u0090foo\u009cbar", "x‪y", "a⁥b"];
  it("prints survivors", () => {
    const rows = nasty.map((s) => ({ in: JSON.stringify(s), display: JSON.stringify(sanitizeDisplayName(s)), term: JSON.stringify(stripTerminalControl(s)) }));
    log("SAN", JSON.stringify(rows, null, 1));
  });
  it("display name is ASCII only, bounded", () => {
    const s = sanitizeDisplayName("‮" + "x".repeat(1000) + "\u0007");
    expect(s).toMatch(/^[\x20-\x7e]*$/); expect(s.length).toBeLessThanOrEqual(64);
  });
  it("no non-ASCII control survives terminal strip over all BMP", () => {
    const left: string[] = [];
    for (let c = 0; c < 0x10000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const out = stripTerminalControl("a" + String.fromCharCode(c) + "b");
      for (const ch of out) { const k = ch.charCodeAt(0); if (k < 0x20 || (k >= 0x7f && k <= 0x9f)) left.push(c.toString(16)); }
    }
    expect(left).toEqual([]);
  });
  it("bidi isolates/embeddings fully stripped from terminal output across BMP", () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const c of bidi) expect(stripTerminalControl("a" + String.fromCharCode(c) + "b")).toBe("ab");
  });
  it("terminal: astral tag chars / unterminated OSC", () => {
    log("OSC", JSON.stringify(stripTerminalControl("\u001b]8;;http://evil\u0007click\u001b]8;;\u0007")), JSON.stringify(stripTerminalControl("pre\u001b]0;never-terminated\nline2 visible?")));
    log("STRING-ARG", JSON.stringify(stripTerminalControl(new Error("x\u001b[2Jy") as unknown as string)));
  });
});

describe("Audit2 content host", () => {
  const org = "0x52908400098527886E0F7030069857D2E4169EE7";
  it("labels", () => {
    const tries: unknown[] = [];
    const t = (f: () => unknown) => { try { tries.push(f()); } catch (e) { tries.push("ERR " + (e as Error).message.slice(0, 50)); } };
    t(() => contentLabel({ chainId: 8453, org, tokenId: 1n }));
    t(() => contentLabel({ chainId: 8453, org: org + ".evil.com", tokenId: 1n }));
    t(() => contentLabel({ chainId: 8453, org, tokenId: "1.evil" as unknown as bigint }));
    t(() => contentLabel({ chainId: 8453, org, tokenId: -1 }));
    t(() => contentLabel({ chainId: 8453, org, tokenId: 10 ** 10 }));
    t(() => contentLabel({ chainId: 8453, org, tokenId: 1, version: 1.5 }));
    t(() => contentOrigin({ chainId: 8453, org, tokenId: 1 }, "evil.com/x#"));
    t(() => contentOrigin({ chainId: 8453, org, tokenId: 1 }, "evil.com", "javascript" as never));
    t(() => parseContentHost("8453-" + org.slice(2).toLowerCase() + "-1.x.example", "x.example"));
    t(() => parseContentHost("8453-" + org.slice(2).toLowerCase() + "-1.x.example.", "x.example"));
    t(() => parseContentLabel("8453-" + org.slice(2).toLowerCase() + "-1\n"));
    log("LABELS", tries);
  });
});
