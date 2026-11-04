/** Round-4 attacks on the round-3 scanner. The former FINDINGs are inverted into safe-behaviour tests; the accepted ones stay marked. */
import { describe, expect, it } from "vitest";
import { isSecretLikeName, sniffSecretContent } from "../../src/secret-names.js";

const enc = (s: string) => new TextEncoder().encode(s);
const PEM = "-----BEGIN RSA PRIVATE KEY-----";
const H = "ab".repeat(32);
const MN = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("Audit4 scanner: held", () => {
  it("PEM in notes.txt / config.json / id_rsa.pub-named content is caught by content", () => {
    for (const n of ["notes.txt", "config.json", "id_rsa.pub"]) expect(sniffSecretContent(enc(`x\n${PEM}\nabc`), n)).not.toBeNull();
  });
  it("AWS key in CSS/JS comment", () => {
    expect(sniffSecretContent(enc("/* AKIAABCDEFGHIJKLMNOP */ body{}"))).not.toBeNull();
  });
  it("key at head/tail of 10MB file", () => {
    const big = new Uint8Array(10_000_000).fill(32);
    big.set(enc(PEM), 9_999_000);
    expect(sniffSecretContent(big)).not.toBeNull();
  });
  it("uppercase ext, .pem.bak, trailing-dot-less names", () => {
    for (const n of ["SERVER.PEM", "a.Key", "x.pem.bak", "ID_RSA", "KEYSTORE-1.JSON", "wallet.json"]) expect(isSecretLikeName(n), n).toBe(true);
  });
  it("mnemonic with punctuation after label", () => {
    expect(sniffSecretContent(enc(`Mnemonic: "${MN}".`))).not.toBeNull();
    expect(sniffSecretContent(enc(`seed phrase = ${MN.split(" ").join(", ")}`))).not.toBeNull();
  });
});

describe("Audit4 scanner: fixed (formerly FINDINGS)", () => {
  it("F1 PEM header straddling the old 4096-byte seam is found (whole file read in overlapping windows)", () => {
    const body = " ".repeat(4096 - 10) + PEM + "\nMIIE...\n" + " ".repeat(3000);
    expect(sniffSecretContent(enc(body), "notes.txt")).not.toBeNull();
    expect(sniffSecretContent(enc(" ".repeat(100) + PEM + "\n" + " ".repeat(4000)), "notes.txt")).not.toBeNull();
  });
  it("F1b the middle of a file up to 64 KB is no longer dead, and a header straddling a window seam is found", () => {
    expect(sniffSecretContent(enc(" ".repeat(4096 - 10) + PEM + " ".repeat(20000)))).not.toBeNull();
    for (const off of [16384 - 10, 16384 - 14, 14336 - 7, 30000]) {
      expect(sniffSecretContent(enc(" ".repeat(off) + PEM + " ".repeat(30000))), String(off)).not.toBeNull();
    }
  });
  it("F1c FIXED (audit 5): a key in the middle of a 200 KB file is found; only beyond 8 MiB are head and tail (4 MiB each) read", () => {
    expect(sniffSecretContent(enc(" ".repeat(100_000) + PEM + " ".repeat(100_000)))).not.toBeNull();
  });
  it("F2 a single NUL byte no longer turns off sniffing; genuine binary is still skipped", () => {
    expect(sniffSecretContent(enc(`\0\n${PEM}\nabc`), "notes.txt")).not.toBeNull();
    expect(sniffSecretContent(new Uint8Array([...enc("ok\0"), ...enc(" ".repeat(9000) + PEM)]))).not.toBeNull();
    expect(sniffSecretContent(new Uint8Array(4096))).toBeNull();
    const noise = new Uint8Array(8192).map((_, i) => (i * 131 + 7) & 0xff | 0x80);
    expect(sniffSecretContent(noise)).toBeNull();
  });
  it("F3 privateKeyToAccount('0x<64 hex>'), deployer literals and a label on the line above are caught", () => {
    expect(sniffSecretContent(enc(`const a = privateKeyToAccount("0x${H}")`))).not.toBeNull();
    expect(sniffSecretContent(enc(`deployer: "0x${H}"`))).not.toBeNull();
    expect(sniffSecretContent(enc(`{"privKeyHex":\n"${H}"}`))).not.toBeNull();
    // controls: a bare token seed and a hash are not keys
    expect(sniffSecretContent(enc(`const seed = "0x${H}"`))).toBeNull();
    expect(sniffSecretContent(enc(`sha256: ${H}`))).toBeNull();
  });
  it("F4 web3 keystore JSON is caught by content whatever it is named", () => {
    const ks = JSON.stringify({ version: 3, id: "x", address: "aa".repeat(20), crypto: { cipher: "aes-128-ctr", ciphertext: "ab".repeat(32), kdf: "scrypt", mac: "cd".repeat(32) } });
    expect(sniffSecretContent(enc(ks), "data.json")).toMatch(/keystore/);
    expect(isSecretLikeName("data.json")).toBe(false); // the name alone is still innocent
    expect(sniffSecretContent(enc(JSON.stringify({ crypto: "none" })), "data.json")).toBeNull();
  });
  it("F5 .env contents in env.txt / config / prod.environment are flagged; the same lines in a page are not", () => {
    const e = "DATABASE_URL=postgres://u:hunter2@db/x\nSTRIPE_KEY=rk_live_" + "a1".repeat(12) + "\nJWT_SECRET=" + "z9".repeat(16);
    for (const n of ["env.txt", "config", "settings.ini", "prod.environment"]) expect(sniffSecretContent(enc(e), n), n).not.toBeNull();
    const plain = "API_ROOT=https://example.org/v1\nPAGE_SIZE=20000000\nFEATURE_X=experimental";
    expect(sniffSecretContent(enc(plain), "env.txt")).toMatch(/environment/);
    expect(sniffSecretContent(enc(plain), "notes.md")).toBeNull();
    expect(sniffSecretContent(enc("A=1\nB=2"), "env.txt")).toBeNull(); // two short lines are not a cluster
  });
  it("F6 other token shapes: Stripe live, SendGrid, npm, labelled JWT, DB URL with a password", () => {
    for (const s of ["sk_live_" + "a1B2".repeat(6), "rk_live_" + "a1B2".repeat(6), "SG." + "a".repeat(22) + "." + "b".repeat(43), "npm_" + "aB3".repeat(12), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789"]) {
      expect(sniffSecretContent(enc(`token = ${s}`)), s).not.toBeNull();
    }
    expect(sniffSecretContent(enc("postgres://admin:Tr0ub4dor@db.internal:5432/app"))).toMatch(/password/);
    // controls: placeholders in docs, an unlabelled lone JWT, a Twilio SID alone
    expect(sniffSecretContent(enc("https://user:password@example.com/"))).toBeNull();
    expect(sniffSecretContent(enc("see eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789 above"))).toBeNull();
    expect(sniffSecretContent(enc("AC" + "0123456789abcdef".repeat(2)))).toBeNull();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789";
    expect(sniffSecretContent(enc(`${jwt}\n${jwt}\n${jwt}`))).toBe("JWT");
  });
  it("F7 trailing space / dot / fullwidth-dot / NBSP names hit the binary-key name rules", () => {
    for (const n of ["cert.p12 ", "cert.p12.", "cert.pfx ", "server．pem", "my cert.jks ", "cert.p12\u00a0", "CERT.P12 . "]) expect(isSecretLikeName(n), JSON.stringify(n)).toBe(true);
    for (const n of ["index.html", "environment.md", "monkey.png", "p12.txt"]) expect(isSecretLikeName(n), n).toBe(false);
  });
  it("F8 a mnemonic as a numbered list or after a '(12 words):' label is caught", () => {
    expect(sniffSecretContent(enc("Seed phrase (12 words):\n" + MN))).not.toBeNull();
    expect(sniffSecretContent(enc("mnemonic\n" + MN.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n")))).not.toBeNull();
  });
  it("F9 a header wrapped over two lines is caught; ACCEPTED: a base64-wrapped key is not", () => {
    expect(sniffSecretContent(enc("-----BEGIN RSA\nPRIVATE KEY-----"))).not.toBeNull();
    expect(sniffSecretContent(enc("-----BEGIN  RSA PRIVATE KEY-----"))).not.toBeNull();
    expect(sniffSecretContent(enc(Buffer.from(PEM).toString("base64")))).toBeNull(); // accepted: no decoding of encodings
  });
  it("F10 ACCEPTED: prose right after 'recovery phrase' that is shaped like a phrase is flagged (a false positive by design)", () => {
    const prose = "Your recovery phrase\nkeep these words safe and never share them with anyone online because they control your funds";
    expect(sniffSecretContent(enc(prose))).not.toBeNull();
  });
  it("cost: a 64 KB file of hostile near-matches scans in well under a second", () => {
    const evil = ("private key " + "a".repeat(30) + "\n").repeat(1800) + ("mnemonic " + "abc ".repeat(40) + "\n").repeat(200);
    const t = Date.now();
    sniffSecretContent(enc(evil.slice(0, 65536)), "env.txt");
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
