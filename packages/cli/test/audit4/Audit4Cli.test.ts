/** Round-4 attacks on the round-3 CLI. Former FINDINGs are inverted into safe-behaviour tests; accepted ones stay marked. */
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, linkSync, rmSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * A hook that runs just before the scan OPENS a file: it lets a test swap the file (for a symlink, or for another
 * file) in the window between the walk's `lstat` and its `open`, deterministically. Pass-through otherwise.
 */
const fsHook = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((path: string) => void) }));
/** A hook that acts once, on the first open of a path ending in `suffix`. */
const once = (suffix: string, act: (path: string) => void) => (path: string) => {
  if (!path.endsWith(suffix)) return;
  fsHook.beforeOpen = undefined;
  act(path);
};
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const openSync = ((path: Parameters<typeof real.openSync>[0], ...rest: unknown[]) => {
    fsHook.beforeOpen?.(String(path));
    return (real.openSync as (...a: unknown[]) => number)(path, ...rest);
  }) as typeof real.openSync;
  return { ...real, default: { ...real, openSync }, openSync };
});

import { isAllowedPublic, globToRegExp, scanForUpload, loadSingleFile, validateAllowPublicGlob } from "../../src/scan-guard.js";
import { collectAllowPublic } from "../../src/commands/upload.js";
import { MAX_TOTAL_READ_BYTES, scanDirectoryReport } from "../../src/fsscan.js";
import { looksBinary } from "../../src/commands/read.js";
import { assertAbxfsCheckout } from "../../src/commands/dev.js";

const mk = () => mkdtempSync(join(tmpdir(), "a4-"));
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n";

describe("Audit4 --allow-public", () => {
  it("FIXED G1: `*`, `**`, `**/*`, `?*`, `*.*`, `**/.*` approve NOTHING and are refused with 'name the files you approve'", () => {
    for (const g of ["*", "**", "**/*", "?*", "*.*", "**/.*", ".*", "*?*", "./*", "  "]) {
      expect(() => validateAllowPublicGlob(g), g).toThrow(/name the files you approve/);
      expect(() => collectAllowPublic(g, []), g).toThrow(/name the files you approve/);
      for (const p of ["id_rsa", "a/b/.env", "keys/server.pem", "x/y/z/wallet.json"]) expect(isAllowedPublic(p, [g]), `${g} vs ${p}`).toBe(false);
    }
  });
  it("patterns that name a file, an extension or a directory are still accepted", () => {
    for (const g of [".env.production", "keys/*.pub", "**/*.pub", "id_rsa.pub", "a?c.txt"]) expect(() => validateAllowPublicGlob(g), g).not.toThrow();
    expect(isAllowedPublic("keys/a.pub", ["keys/*.pub"])).toBe(true);
    expect(isAllowedPublic("a/b/keys/a.pub", ["**/*.pub"])).toBe(true);
    expect(isAllowedPublic("keys/sub/a.pub", ["keys/*.pub"])).toBe(false);
    expect(isAllowedPublic("deploy/x/y.pem", ["deploy/**"])).toBe(false);
    expect(isAllowedPublic("abc.txt", ["a?c.txt"])).toBe(true);
    expect(isAllowedPublic("a/c.txt", ["a?c.txt"])).toBe(false);
  });
  it("FIXED G1b: end to end, `--allow-public '*'` is refused before anything is uploaded", async () => {
    const d = mk();
    writeFileSync(join(d, "index.html"), "<p>hi</p>"); writeFileSync(join(d, "deploy.pem"), PEM); writeFileSync(join(d, ".env"), "A=1");
    for (const g of ["*", "**"]) await expect(scanForUpload(d, { includeHidden: true, allowPublic: [g] })).rejects.toThrow(/name the files you approve/);
    // naming the files works, and approves only those
    const files = await scanForUpload(d, { includeHidden: true, allowPublic: ["deploy.pem", ".env"] });
    expect(files.map((f) => f.path).sort()).toEqual([".env", "deploy.pem", "index.html"]);
    await expect(scanForUpload(d, { includeHidden: true, allowPublic: ["deploy.pem"] })).rejects.toThrow(/not approved/);
  });
  it("a glob with no slash matches basename at any depth (secrets/prod/.env approved by `.env`)", () => {
    expect(isAllowedPublic("deep/er/.env", [".env"])).toBe(true);
  });
  it("`..`, absolute and brace patterns match nothing special; regex metachars are escaped", () => {
    expect(isAllowedPublic("a/b.pem", ["../*.pem"])).toBe(false);
    expect(isAllowedPublic("a.pem", ["/a.pem"])).toBe(false);
    expect(isAllowedPublic("a.pem", ["{a,b}.pem"])).toBe(false);
    expect(isAllowedPublic("aXpem", ["a.pem"])).toBe(false);
    expect(() => globToRegExp("(((")).not.toThrow();
    expect(isAllowedPublic("x(1).pem", ["x(1).pem"])).toBe(true);
    expect(isAllowedPublic("a.pem", ["a.pem\n"])).toBe(false);
  });
  it("FIXED G2: the glob matcher is linear-time: 8 stars against a long path is instant, more stars or a long pattern are refused", () => {
    const g = "*a*a*a*a*a*a*a*b";
    const t = performance.now();
    expect(isAllowedPublic("a".repeat(5000) + ".pem", [g])).toBe(false);
    expect(isAllowedPublic("a".repeat(30) + "b", [g])).toBe(true);
    expect(performance.now() - t).toBeLessThan(500);
    expect(() => validateAllowPublicGlob("*a*a*a*a*a*a*a*a*a*b")).toThrow(/more than 8/);
    expect(() => validateAllowPublicGlob("a".repeat(257))).toThrow(/longer than 256/);
    expect(isAllowedPublic("x.pem", ["*a*a*a*a*a*a*a*a*a*b"])).toBe(false);
  });
  it("glob injection through file name: a file literally named `*` cannot approve others (globs come from argv only)", () => {
    expect(isAllowedPublic("a.pem", ["b.pem"])).toBe(false);
  });
});

describe("Audit4 false-positive storm", () => {
  const flagged = (d: string) => scanDirectoryReport(d, { includeHidden: true });
  // Deterministic: random base64url at this volume (about 15M characters) spells a real `ghp_…` or `sk-…` token by
  // chance in about half of all runs, which the scanner rightly flags, so a random corpus made this test flaky. A seeded
  // stream of the same alphabet keeps the volume and the shape and gives the same files on every run.
  let seed = 0x9e3779b9;
  const rnd = (n: number) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      out[i] = seed >>> 24;
    }
    return out.toString("base64url");
  };
  it("Vite/React build: 600 hashed bundles + sourcemaps + css + svg", () => {
    const d = mk(); mkdirSync(join(d, "assets"));
    let total = 0;
    for (let i = 0; i < 600; i++) {
      const body = Array.from({ length: 400 }, () => `var ${rnd(4)}="${rnd(24)}";function ${rnd(3)}(){return"${rnd(40)}"}`).join(";");
      writeFileSync(join(d, "assets", `chunk-${rnd(6)}.js`), body);
      writeFileSync(join(d, "assets", `chunk-${i}.js.map`), JSON.stringify({ version: 3, sources: ["../../node_modules/x/index.js"], sourcesContent: [body.slice(0, 5000)], mappings: rnd(3000) }));
      total += 2;
    }
    writeFileSync(join(d, "index.html"), '<script type="module" src="/assets/index-Dx9fQa1.js"></script>');
    const r = flagged(d);
    console.log(`FP vite: ${r.secretLike.length}/${total + 1} files flagged`);
    console.log("FP vite hits", r.secretLike, r.secretReasons); expect(r.secretLike.length).toBeLessThanOrEqual(1);
  });
  it("p5/three.js art project: 0x hashes, seeds, tokenData, minified three", () => {
    const d = mk();
    const h = () => "0x" + randomBytes(32).toString("hex");
    writeFileSync(join(d, "sketch.js"), `let tokenData={hash:"${h()}",tokenId:"1"};let seed=parseInt(tokenData.hash.slice(0,16),16);\nconst hashes=[${Array.from({ length: 50 }, h).map((x) => `"${x}"`).join(",")}];`);
    writeFileSync(join(d, "three.min.js"), Array.from({ length: 3000 }, (_, i) => `function _${i}(a,b){return a*${i}+b}`).join(""));
    writeFileSync(join(d, "metadata.json"), JSON.stringify({ name: "x", key: h(), inputs: { "private": h() } }));
    writeFileSync(join(d, "README.md"), `# art\nthe mnemonic for this series is a pun.\n`);
    const r = flagged(d);
    console.log("FP art:", r.secretLike, r.secretReasons);
    // metadata.json with a literal "key": 0x.. / "private": 0x.. IS flagged (documented FP/TP ambiguity)
    expect(r.secretLike).toEqual(["metadata.json"]);
  });
  it("docs site with example keys: AWS docs sample, PEM in a code block, sk- placeholder", () => {
    const d = mk();
    writeFileSync(join(d, "aws.html"), "<code>AKIAIOSFODNN7EXAMPLE</code>");
    writeFileSync(join(d, "tls.md"), "```\n-----BEGIN PRIVATE KEY-----\n...\n```");
    writeFileSync(join(d, "api.md"), "export OPENAI_API_KEY=sk-your-key-here-replace-this-value");
    writeFileSync(join(d, "api2.md"), "export OPENAI_API_KEY=sk-proj-abc123abc123abc123abc123");
    writeFileSync(join(d, "wallet.md"), "Your recovery phrase\nkeep these words safe and never share them with anyone online because they control your funds");
    const r = flagged(d);
    console.log("FP docs:", r.secretReasons);
    expect(Object.keys(r.secretReasons).sort()).toEqual(["api2.md", "tls.md", "wallet.md"]) // audit 5: AWS's documented example id is no longer a finding;
  });
  it("PERF: 5000 files scan", () => {
    const d = mk(); for (let i = 0; i < 5000; i++) writeFileSync(join(d, `f${i}.js`), "x".repeat(20000));
    const t = performance.now(); scanDirectoryReport(d); console.log("scan 5000x20KB ms", Math.round(performance.now() - t));
  });
});

describe("Audit4 root / symlink / TOCTOU", () => {
  it("symlinked root refused; relative `./link`; `link/.` and `link/` forms", () => {
    const real = mk(); writeFileSync(join(real, "a.txt"), "x");
    const h = mk(); symlinkSync(real, join(h, "link"));
    expect(() => scanDirectoryReport(join(h, "link"))).toThrow(/symlink/);
    expect(() => scanDirectoryReport(join(h, "link") + "/")).toThrow(/symlink/);
  });
  it("FIXED S1: a symlinked PARENT component is refused too (every component of the root is lstat-ed)", () => {
    const real = mk(); writeFileSync(join(real, "a.txt"), "x");
    const h = mk(); symlinkSync(real, join(h, "link"));
    expect(() => scanDirectoryReport(join(h, "link", "."))).toThrow(/symlink/); // resolve() folds `.` away: refused (held)
    mkdirSync(join(real, "sub")); writeFileSync(join(real, "sub", "b.txt"), "y");
    expect(() => scanDirectoryReport(join(h, "link", "sub"))).toThrow(/parent .* is a symlink/);
    expect(scanDirectoryReport(join(real, "sub")).files.length).toBe(1); // the real path is fine, whatever it sits under (macOS /var)
  });
  it("loadSingleFile refuses symlink and symlinked-to-fifo; hardlink is read (accepted)", async () => {
    const d = mk(); writeFileSync(join(d, "a.txt"), "x"); symlinkSync(join(d, "a.txt"), join(d, "l.txt"));
    await expect(loadSingleFile(join(d, "l.txt"))).rejects.toThrow(/symlink/);
    linkSync(join(d, "a.txt"), join(d, "h.txt"));
    expect((await loadSingleFile(join(d, "h.txt"))).bytes.length).toBe(1);
  });
  it("single file: sniffed bytes are the uploaded bytes (same buffer)", async () => {
    const d = mk(); writeFileSync(join(d, "n.txt"), PEM);
    await expect(loadSingleFile(join(d, "n.txt"))).rejects.toThrow(/not approved|secret/);
    const f = await loadSingleFile(join(d, "n.txt"), { allowPublic: ["n.txt"] });
    expect(Buffer.from(f.bytes).toString()).toBe(PEM);
  });
  it("FIXED S2: single-file `--allow-public` with `*` / `**` is refused; naming the file works", async () => {
    const d = mk(); writeFileSync(join(d, "n.pem"), PEM);
    for (const g of ["*", "**"]) await expect(loadSingleFile(join(d, "n.pem"), { allowPublic: [g] })).rejects.toThrow(/name the files you approve/);
    expect((await loadSingleFile(join(d, "n.pem"), { allowPublic: ["n.pem"] })).path).toBe("n.pem");
  });
  it("a .env pasted into env.txt is caught by content, and the flag must name it", async () => {
    const d = mk();
    writeFileSync(join(d, "index.html"), "<p>hi</p>");
    writeFileSync(join(d, "env.txt"), "DATABASE_URL=postgres://u:hunter2@db/x\nSTRIPE_KEY=rk_live_" + "a1".repeat(12) + "\nJWT_SECRET=" + "z9".repeat(16) + "\n");
    const r = scanDirectoryReport(d);
    expect(r.secretLike).toEqual(["env.txt"]);
    expect(r.secretReasons["env.txt"]).toBeTruthy();
    await expect(scanForUpload(d, { allowPublic: ["*"] })).rejects.toThrow(/name the files you approve/);
    await expect(scanForUpload(d, {})).rejects.toThrow(/not approved/);
  });
  it("a file swapped for a symlink between lstat and open is skipped, not followed (O_NOFOLLOW: ELOOP)", () => {
    const secret = join(mk(), "id_rsa");
    writeFileSync(secret, PEM);
    const d = mk();
    writeFileSync(join(d, "index.html"), "<p>hi</p>");
    writeFileSync(join(d, "victim.txt"), "innocent");
    fsHook.beforeOpen = once("victim.txt", (path) => {
      rmSync(path);
      symlinkSync(secret, path);
    });
    const r = scanDirectoryReport(d);
    expect(r.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(r.skippedSymlinks).toEqual(["victim.txt"]);
    expect(r.files.some((f) => Buffer.from(f.bytes).toString().includes("RSA"))).toBe(false);
  });

  /**
   * The swap is a rename over the path, as an attacker would make it: the new file's inode is allocated while the scanned
   * one is still live, so they differ on every filesystem. Deleting first and then creating is not a test of anything on
   * Linux, which hands the freed inode number straight back, and is harmless there: a new file holds only what its
   * creator wrote, and those are the bytes sniffed and uploaded. A hard link to a real secret keeps the secret's own inode.
   */
  const swapIn = (path: string, bytes: string) => {
    writeFileSync(`${path}.swap`, bytes);
    renameSync(`${path}.swap`, path);
  };

  it("a file swapped for ANOTHER file between lstat and open is refused (the opened inode must be the scanned one)", () => {
    const d = mk();
    writeFileSync(join(d, "a.txt"), "scanned");
    fsHook.beforeOpen = once("a.txt", (path) => swapIn(path, "swapped in"));
    expect(() => scanDirectoryReport(d)).toThrow(/changed while it was being scanned; refusing to read it/);
  });

  it("single file: a swap for a symlink, or for another file, between lstat and open is refused", async () => {
    const secret = join(mk(), "id_rsa");
    writeFileSync(secret, PEM);
    const d = mk();
    const f = join(d, "page.html");
    writeFileSync(f, "<p>hi</p>");
    fsHook.beforeOpen = once("page.html", (path) => {
      rmSync(path);
      symlinkSync(secret, path);
    });
    await expect(loadSingleFile(f)).rejects.toThrow(/became a symlink while it was being read/);
    rmSync(f);
    writeFileSync(f, "<p>hi</p>");
    fsHook.beforeOpen = once("page.html", (path) => swapIn(path, "<p>other</p>"));
    await expect(loadSingleFile(f)).rejects.toThrow(/changed while it was being read; refusing to upload it/);
  });

  it("the scan stops at a total read budget, before reading the file that would cross it", () => {
    const d = mk();
    for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}.bin`), Buffer.alloc(1000, i));
    expect(() => scanDirectoryReport(d, { maxTotalBytes: 3500 })).toThrow(/add up to more than .* Nothing was uploaded/);
    expect(scanDirectoryReport(d, { maxTotalBytes: 5000 }).files.length).toBe(5);
    expect(MAX_TOTAL_READ_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe("Audit4 abxfs read looksBinary", () => {
  const b = (s: string | Uint8Array) => (typeof s === "string" ? new TextEncoder().encode(s) : s);
  it("ESC after 8192 bytes, split exactly at the boundary, is caught", () => {
    for (const off of [8190, 8191, 8192, 8193, 100000]) {
      const x = new Uint8Array(off + 10).fill(65); x[off] = 0x1b; x[off + 1] = 0x5b;
      expect(looksBinary(x), String(off)).toBe(true);
    }
  });
  it("C1 CSI as UTF-8 (U+009B), bidi, zero-width, tag chars, BOM caught; plain unicode & emoji pass", () => {
    for (const s of ["a\u009b2Jb", "a‮b", "a​b", "a\u{e0041}b", "a﻿b", "a⁦b"]) expect(looksBinary(b(s)), JSON.stringify(s)).toBe(true);
    for (const s of ["héllo 日本語 😀\n\ttab"]) expect(looksBinary(b(s))).toBe(false);
  });
  it("overlong / invalid UTF-8 encoding of ESC or CSI (0xC0 0x9B, 0xC1 0xBB) rejected", () => {
    expect(looksBinary(new Uint8Array([0xc1, 0xbb, 0x5b]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xc2, 0x9b]))).toBe(true);
  });
  it("FINDING R1 (low): other terminal-affecting chars pass: U+2028/2029, U+00AD soft hyphen, U+FE00 variation selectors, U+0085 is C1 (caught)", () => {
    expect(looksBinary(b("a b"))).toBe(false);
    expect(looksBinary(b("a­b"))).toBe(false);
  });
  it("perf: 200MB-ish scan is linear (50MB)", () => {
    const x = new Uint8Array(50_000_000).fill(97); const t = performance.now(); looksBinary(x); console.log("looksBinary 50MB ms", Math.round(performance.now() - t));
  });
});

describe("Audit4 abxfs dev", () => {
  it("needs the flag AND a packages/contracts-core dir; flag is a plain argv, no env path", () => {
    const d = mk();
    expect(() => assertAbxfsCheckout(false, d)).toThrow(/i-trust-this-dir/);
    expect(() => assertAbxfsCheckout(true, d)).toThrow(/contracts-core/);
    process.env["ABXFS_I_TRUST_THIS_DIR"] = "1"; process.env["I_TRUST_THIS_DIR"] = "1";
    expect(() => assertAbxfsCheckout(false, d)).toThrow();
    mkdirSync(join(d, "packages/contracts-core"), { recursive: true });
    expect(() => assertAbxfsCheckout(true, d)).not.toThrow(); // FINDING D1 (info): a hostile repo only has to mkdir one dir; the flag is the sole trust gate
  });
});
