/**
 * Upload scan safety (audit M8): never follow symlinks, skip hidden files by default, and never ship
 * secret-looking files without an explicit confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSecretLikePath, scanDirectory, scanDirectoryReport } from "../src/fsscan.js";
import { checkSingleFile, scanForUpload } from "../src/scan-guard.js";

let dir: string;
let tree: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-scan-"));
  tree = join(dir, "site");
  mkdirSync(tree);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("symlinks", () => {
  it("are never followed (a link to a directory or file outside the tree is skipped and reported)", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "id_rsa"), "FAKE-SECRET-KEY");
    writeFileSync(join(tree, "index.html"), "<h1>hi</h1>");
    symlinkSync(outside, join(tree, "assets"));
    symlinkSync(join(outside, "id_rsa"), join(tree, "logo.png"));

    const r = scanDirectoryReport(tree);
    expect(r.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(r.skippedSymlinks.sort()).toEqual(["assets", "logo.png"]);
  });

  it("a symlink cycle is simply skipped, not an ELOOP", () => {
    writeFileSync(join(tree, "a.txt"), "a");
    symlinkSync(tree, join(tree, "self"));
    expect(scanDirectory(tree).map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("a single-file upload of a symlink is refused", async () => {
    writeFileSync(join(dir, "real.txt"), "x");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    await expect(checkSingleFile(join(dir, "link.txt"))).rejects.toThrow(/symlink/);
  });
});

describe("hidden files", () => {
  beforeEach(() => {
    writeFileSync(join(tree, "index.html"), "x");
    writeFileSync(join(tree, ".env"), "TOKEN=dummy");
    mkdirSync(join(tree, ".well-known"));
    writeFileSync(join(tree, ".well-known", "security.txt"), "contact");
    mkdirSync(join(tree, ".cache"));
    writeFileSync(join(tree, ".cache", "x"), "x");
  });

  it("are skipped by default, except .well-known, and listed", () => {
    const r = scanDirectoryReport(tree);
    expect(r.files.map((f) => f.path)).toEqual([".well-known/security.txt", "index.html"]);
    expect(r.skippedHidden.sort()).toEqual([".cache", ".env"]);
    expect(r.secretLike).toEqual([]);
  });

  it("--include-hidden includes them and flags the secret-like ones", () => {
    const r = scanDirectoryReport(tree, { includeHidden: true });
    expect(r.files.map((f) => f.path)).toContain(".env");
    expect(r.secretLike).toEqual([".env"]);
  });

  it("the default upload scan prints a summary of what it skipped", async () => {
    const log = vi.mocked(console.log);
    await scanForUpload(tree);
    expect(log.mock.calls.flat().join(" ")).toMatch(/skipped 2 hidden/);
  });
});

describe("secret-like names", () => {
  it.each([".env", ".env.local", "k.pem", "id_rsa", "id_rsa.pub", "id_ed25519", "server.key", ".npmrc", ".netrc", "credentials.json", ".aws/config", ".ssh/known_hosts", ".git/config", "sub/dir/.env"])(
    "%s is secret-like",
    (p) => expect(isSecretLikePath(p)).toBe(true),
  );
  it.each(["index.html", "keyboard.js", "environment.md", "a/b/style.css"])("%s is not", (p) => expect(isSecretLikePath(p)).toBe(false));

  it("a secret-like file is NEVER uploaded without confirmation (no TTY: refuses, nothing returned)", async () => {
    writeFileSync(join(tree, "index.html"), "x");
    writeFileSync(join(tree, "server.key"), "PRIVATE");
    await expect(scanForUpload(tree)).rejects.toThrow(/--allow-public/);
  });

  it("--allow-public <glob> approves exactly the files it names, still warning", async () => {
    writeFileSync(join(tree, "index.html"), "x");
    writeFileSync(join(tree, "server.key"), "PRIVATE");
    const files = await scanForUpload(tree, { allowPublic: ["server.key"] });
    expect(files.map((f) => f.path)).toEqual(["index.html", "server.key"]);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toMatch(/PUBLIC and PERMANENT/);
  });

  it("--include-hidden does not bypass the confirmation for .env / .git", async () => {
    writeFileSync(join(tree, "index.html"), "x");
    writeFileSync(join(tree, ".env"), "T=1");
    await expect(scanForUpload(tree, { includeHidden: true })).rejects.toThrow(/--allow-public/);
  });

  it("a single-file upload named like a secret needs the same confirmation", async () => {
    writeFileSync(join(dir, "id_rsa"), "x");
    await expect(checkSingleFile(join(dir, "id_rsa"))).rejects.toThrow(/--allow-public/);
    await expect(checkSingleFile(join(dir, "id_rsa"), { allowPublic: ["id_rsa"] })).resolves.toBeUndefined();
  });
});

describe("empty directories", () => {
  /**
   * ABX FS stores empty directories, and `ipfs add -r` keeps them, so a folder holding one must upload as that same
   * tree: dropping it would give a root (and an IPFS root) the folder does not have.
   */
  it("are reported, nested ones as the leaf only, and a directory left empty by skipped entries counts", () => {
    writeFileSync(join(tree, "index.html"), "<h1>hi</h1>");
    mkdirSync(join(tree, "empty"));
    mkdirSync(join(tree, "a", "b"), { recursive: true });
    mkdirSync(join(tree, "only-hidden"));
    writeFileSync(join(tree, "only-hidden", ".env"), "X=1");
    mkdirSync(join(tree, "full"));
    writeFileSync(join(tree, "full", "x.txt"), "x");

    const r = scanDirectoryReport(tree);
    expect(r.emptyDirectories).toEqual(["a/b", "empty", "only-hidden"]);
    expect(r.files.map((f) => f.path)).toEqual(["full/x.txt", "index.html"]);
  });

  it("a hidden empty directory is skipped like any hidden entry, unless --include-hidden", () => {
    writeFileSync(join(tree, "index.html"), "<h1>hi</h1>");
    mkdirSync(join(tree, ".cache"));
    expect(scanDirectoryReport(tree).emptyDirectories).toEqual([]);
    expect(scanDirectoryReport(tree, { includeHidden: true }).emptyDirectories).toEqual([".cache"]);
  });
});
