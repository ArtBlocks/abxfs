/** Round 3: nothing is sent for a bad tag/name; --allow-public is per file; single-file open is safe. */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { globToRegExp, isAllowedPublic, loadSingleFile, scanForUpload } from "../src/scan-guard.js";
import { assertAbxfsCheckout } from "../src/commands/dev.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guards-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("upload / update refuse a bad tag or name before any network or filesystem work", () => {
  // Any chain access would need ABXFS_PRIVATE_KEY and an RPC; the guard must fire before both.
  const cases: [string, string[], RegExp][] = [
    ["upload bad tag", ["upload", ".", "--name", "ok", "--tag", "Bad Tag"], /invalid tag/],
    ["upload reserved tag", ["upload", ".", "--project-id", "1", "--tag", "latest"], /reserved/],
    ["upload bad name", ["upload", ".", "--name", "x".repeat(200)], /invalid project name/],
    ["upload control char name", ["upload", ".", "--name", "a\u0007b"], /invalid project name/],
    ["upload tag without project", ["upload", ".", "--tag", "v1"], /--tag requires/],
    ["update bad tag", ["update", ".", "--project-id", "1", "--tag", "UPPER"], /invalid tag/],
  ];
  it.each(cases)("%s", async (_n, argv, re) => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("NETWORK TOUCHED")));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env["ABXFS_PRIVATE_KEY"];
    const { uploadCommand } = await import("../src/commands/upload.js");
    const { updateCommand } = await import("../src/commands/update.js");
    const program = new Command().exitOverride();
    program.addCommand(uploadCommand());
    program.addCommand(updateCommand());
    await expect(program.parseAsync(["node", "abxfs", ...argv])).rejects.toThrow(re);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("--allow-public globs", () => {
  it("matches names at any depth, or whole relative paths", () => {
    expect(isAllowedPublic("a/b/.env.production", [".env.production"])).toBe(true);
    expect(isAllowedPublic("keys/a.pem", ["keys/*.pem"])).toBe(false);
    expect(isAllowedPublic("keys/a.pem", ["keys/a.pem"])).toBe(true);
    expect(isAllowedPublic("keys/sub/a.pem", ["keys/a.pem"])).toBe(false);
    expect(isAllowedPublic("keys/sub/a.pem", ["keys/**"])).toBe(false);
    expect(isAllowedPublic(".env", [".env.production"])).toBe(false);
    expect(isAllowedPublic(".env", undefined)).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
  it("approves ONLY the named file: a second secret in the tree still stops the run", async () => {
    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t/index.html"), "x");
    writeFileSync(join(dir, "t/a.pem"), "S");
    writeFileSync(join(dir, "t/b.pem"), "S");
    await expect(scanForUpload(join(dir, "t"), { allowPublic: ["a.pem"] })).rejects.toThrow(/1 secret-looking file.*--allow-public/s);
    const files = await scanForUpload(join(dir, "t"), { allowPublic: ["a.pem", "b.pem"] });
    expect(files.map((f) => f.path)).toEqual(["a.pem", "b.pem", "index.html"]);
  });
  it("a CONTENT hit is not blanket-approved by an unrelated glob", async () => {
    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t/n.txt"), "token ghp_" + "a".repeat(30));
    await expect(scanForUpload(join(dir, "t"), { allowPublic: ["*.pem"] })).rejects.toThrow(/--allow-public/);
    await expect(scanForUpload(join(dir, "t"), { allowPublic: ["n.txt"] })).resolves.toHaveLength(1);
  });
  it("the old blanket flag is gone from the CLI", async () => {
    const { uploadCommand } = await import("../src/commands/upload.js");
    expect(uploadCommand().options.map((o) => o.long)).not.toContain("--yes-i-know-this-is-public");
    expect(uploadCommand().options.map((o) => o.long)).toContain("--allow-public");
  });
});

describe("single-file safety", () => {
  it("a symlinked file path is refused and says where it points", async () => {
    writeFileSync(join(dir, "real.txt"), "x");
    symlinkSync(join(dir, "real.txt"), join(dir, "ln.txt"));
    await expect(loadSingleFile(join(dir, "ln.txt"))).rejects.toThrow(/symlink.*real\.txt/s);
  });
  it("returns the very bytes that were sniffed", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const f = await loadSingleFile(join(dir, "a.txt"));
    expect(new TextDecoder().decode(f.bytes)).toBe("hello");
    expect(f.path).toBe("a.txt");
  });
  it("a wallet.txt holding a recovery phrase needs confirmation; a prose one does not", async () => {
    writeFileSync(join(dir, "wallet.txt"), "abandon ability able about above absent absorb abstract absurd abuse access accident");
    await expect(loadSingleFile(join(dir, "wallet.txt"))).rejects.toThrow(/--allow-public/);
    await expect(loadSingleFile(join(dir, "wallet.txt"), { allowPublic: ["wallet.txt"] })).resolves.toBeDefined();
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p/wallet.txt"), "Connect your wallet.");
    await expect(loadSingleFile(join(dir, "p/wallet.txt"))).resolves.toBeDefined();
  });
});

describe("abxfs dev", () => {
  it("needs --i-trust-this-dir AND the marker", () => {
    expect(() => assertAbxfsCheckout(false, dir)).toThrow(/--i-trust-this-dir/);
    expect(() => assertAbxfsCheckout(true, dir)).toThrow(/not an ABX FS checkout/);
    mkdirSync(join(dir, "packages/contracts-core"), { recursive: true });
    expect(() => assertAbxfsCheckout(true, dir)).not.toThrow();
  });
});
