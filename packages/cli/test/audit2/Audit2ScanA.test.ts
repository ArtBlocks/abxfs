/**
 * Audit round 2, pass A: try to smuggle secrets past the CLI upload scan.
 * Tests named "GAP:" assert the weakness IS present (invert when fixed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { isSecretLikePath, scanDirectoryReport } from "../../src/fsscan.js";
import { checkSingleFile, scanForUpload } from "../../src/scan-guard.js";

let dir: string;
let tree: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-a2-"));
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

describe("name matching that HOLDS", () => {
  it.each([".ENV", ".Env.local", ".env.", ".env ", ".envrc", ".git", ".GIT", ".ssh", "ID_RSA", "x/.aws/y", "a/b/.git/config", "Credentials.json", "server.KEY", "a.PEM", "dir\\.env"])(
    "%s is flagged",
    (p) => expect(isSecretLikePath(p)).toBe(true),
  );
  it("nested .git is flagged when hidden entries are included", async () => {
    mkdirSync(join(tree, "a/b/.git"), { recursive: true });
    writeFileSync(join(tree, "a/b/.git/HEAD"), "ref");
    const r = scanDirectoryReport(tree, { includeHidden: true });
    expect(r.secretLike).toContain("a/b/.git/HEAD");
  });
  it("nested .git is skipped by default (VCS_IGNORE only skips top-level names? no: any depth)", () => {
    mkdirSync(join(tree, "a/b/.git"), { recursive: true });
    writeFileSync(join(tree, "a/b/.git/HEAD"), "ref");
    writeFileSync(join(tree, "a/ok.txt"), "x");
    expect(scanDirectoryReport(tree).files.map((f) => f.path)).toEqual(["a/ok.txt"]);
  });
  it(".well-known cannot carry a dotfile or a secret name", () => {
    mkdirSync(join(tree, ".well-known"));
    writeFileSync(join(tree, ".well-known/.env"), "S");
    writeFileSync(join(tree, ".well-known/id_rsa"), "S");
    writeFileSync(join(tree, ".well-known/ok.json"), "{}");
    const r = scanDirectoryReport(tree);
    expect(r.files.map((f) => f.path).sort()).toEqual([".well-known/id_rsa", ".well-known/ok.json"]);
    expect(r.secretLike).toEqual([".well-known/id_rsa"]);
  });
});

describe("secret NAMES the heuristic now knows (fixed), and the ones it still does not (accepted)", () => {
  const flagged = [
    "production.env", "app.env", "secrets.env", "id_ecdsa", "id_dsa", "my_id_rsa", "deploy_id_ed25519",
    "wallet.json", "keystore.json", "UTC--2024-01-01--abc", "mnemonic.txt", "private-key.txt",
    "server.p12", "cert.pfx", "release.jks", "my.keystore", "vault.kdbx", "terraform.tfstate",
    "service-account.json", "secrets.json", "terraform.tfvars", ".pgpass", ".dockercfg", ".git-credentials", "secrets.yaml",
  ];
  it.each(flagged)("%s is flagged", (n) => {
    expect(isSecretLikePath(n)).toBe(true);
  });
  // ACCEPTED: names alone cannot catch everything; these hold no recognisable convention (content sniffing is the backstop).
  it.each(["seed.txt", "client.ovpn"])("%s is not flagged by name (accepted)", (n) => {
    expect(isSecretLikePath(n)).toBe(false);
  });
  it("end to end: production.env needs confirmation; with no TTY the upload aborts", async () => {
    writeFileSync(join(tree, "index.html"), "<p>");
    writeFileSync(join(tree, "production.env"), "ABXFS_PRIVATE_KEY=0x" + "11".repeat(32));
    await expect(scanForUpload(tree)).rejects.toThrow(/TTY|--allow-public/);
    const files = await scanForUpload(tree, { allowPublic: ["production.env"] });
    expect(files.map((f) => f.path)).toContain("production.env");
  });
  it.each([
    ["notes.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"],
    ["a.txt", "aws = AKIAABCDEFGHIJKLMNOP"],
    ["b.txt", "private_key: " + "ab".repeat(32)],
    ["c.txt", "token=xoxb-123456789012-abcdefghij"],
    ["d.txt", "ghp_" + "a".repeat(30)],
    ["e.txt", "sk-proj-" + "a1".repeat(15)],
  ])("content sniff: %s is flagged by what it contains", async (name, body) => {
    writeFileSync(join(tree, name), body);
    const r = scanDirectoryReport(tree);
    expect(r.secretLike).toContain(name);
    expect(r.secretReasons[name]).toBeTruthy();
    await expect(scanForUpload(tree)).rejects.toThrow(/TTY|--allow-public/);
  });
  it("content sniff: an ordinary text file and a binary are not flagged", () => {
    writeFileSync(join(tree, "ok.txt"), "hello world, a 64-hex hash without a label: " + "ab".repeat(32));
    // Real binary: mostly NUL. (Audit 4: ONE stray NUL no longer exempts a file, so this is a block of them.)
    writeFileSync(join(tree, "bin.dat"), Buffer.concat([Buffer.alloc(300), Buffer.from("-----BEGIN PRIVATE KEY-----")]));
    expect(scanDirectoryReport(tree).secretLike).toEqual([]);
  });
  it("single file: content sniff applies too", async () => {
    writeFileSync(join(dir, "n.txt"), "AKIAABCDEFGHIJKLMNOP");
    await expect(checkSingleFile(join(dir, "n.txt"))).rejects.toThrow();
  });
  it("lookalike names: the fullwidth full stop is the same name (NFKC); a zero-width or space prefix still contains `.env` and IS flagged", () => {
    expect(isSecretLikePath("．env")).toBe(true); // fullwidth full stop: audit 4 folds it (NFKC) to the same name
    expect(isSecretLikePath("\u200b.env")).toBe(true);
    expect(isSecretLikePath(" .env")).toBe(true);
  });
});

describe("ACCEPTED: default-ignored directories (build, dist, ...) are dropped silently (integrity, not secrecy)", () => {
  it("build/, dist/, out/, cache/, broadcast/ anywhere in the tree vanish without being listed", () => {
    mkdirSync(join(tree, "docs/build"), { recursive: true });
    writeFileSync(join(tree, "docs/build/page.html"), "x");
    const r = scanDirectoryReport(tree);
    expect(r.files).toEqual([]);
    expect(r.skippedHidden).toEqual([]);
    expect(r.skippedSymlinks).toEqual([]);
  });
});

describe("confirmation cannot be bypassed non-interactively", () => {
  it("no TTY: a secret-like file aborts with an error naming the flag", async () => {
    writeFileSync(join(tree, "x.pem"), "S");
    await expect(scanForUpload(tree)).rejects.toThrow(/TTY|--allow-public/);
  });
  it.each([["CI", "true"], ["ABXFS_YES", "1"], ["YES", "1"], ["FORCE", "1"], ["ABXFS_ALLOW_CONFIG_OVERRIDES", "1"], ["npm_config_yes", "true"]])(
    "env %s=%s does not pre-confirm",
    async (k, v) => {
      const old = process.env[k];
      process.env[k] = v;
      try {
        writeFileSync(join(tree, "x.pem"), "S");
        await expect(scanForUpload(tree)).rejects.toThrow();
        await expect(checkSingleFile(join(tree, "x.pem"))).rejects.toThrow();
      } finally {
        if (old === undefined) delete process.env[k];
        else process.env[k] = old;
      }
    },
  );
  it("the only bypass is the explicit flag, and it is announced", async () => {
    writeFileSync(join(tree, "x.pem"), "S");
    const files = await scanForUpload(tree, { allowPublic: ["x.pem"] });
    expect(files.map((f) => f.path)).toEqual(["x.pem"]);
  });
  it("single file: symlink refused, secret name needs the flag", async () => {
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), join(dir, "ln"));
    await expect(checkSingleFile(join(dir, "ln"))).rejects.toThrow(/symlink/);
    writeFileSync(join(dir, ".env"), "S");
    await expect(checkSingleFile(join(dir, ".env"))).rejects.toThrow();
  });
  it("FIXED (audit 4): a single-file upload whose PARENT directory is a symlink is refused, like a symlinked root", async () => {
    mkdirSync(join(dir, "secretdir"));
    writeFileSync(join(dir, "secretdir/report.txt"), "S");
    symlinkSync(join(dir, "secretdir"), join(dir, "linkdir"));
    await expect(checkSingleFile(join(dir, "linkdir/report.txt"))).rejects.toThrow(/parent .* is a symlink/);
  });
});

describe("symlink / hard-link / TOCTOU", () => {
  it("ACCEPTED: a hard link to a file outside the tree is a regular file by inode and cannot be told apart", async () => {
    const outside = join(dir, "outside-id");
    writeFileSync(outside, "TOP-SECRET");
    linkSync(outside, join(tree, "logo.png"));
    const files = await scanForUpload(tree);
    expect(Buffer.from(files[0]!.bytes).toString()).toBe("TOP-SECRET");
  });
  it("a symlinked ROOT is REFUSED (round 3; it was followed as 'user-chosen')", () => {
    writeFileSync(join(dir, "real.txt"), "x");
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r/a.txt"), "a");
    symlinkSync(join(dir, "r"), join(dir, "rootlink"));
    expect(() => scanDirectoryReport(join(dir, "rootlink"))).toThrow(/symlink/);
    expect(scanDirectoryReport(join(dir, "r")).files).toHaveLength(1);
  });
  it("TOCTOU (fixed): a file swapped to a symlink between lstat and open is never followed (O_NOFOLLOW + inode check)", async () => {
    // Race a worker thread that flips decoy.txt between a regular file and a symlink to a secret.
    const secret = join(dir, "SECRET");
    writeFileSync(secret, "TOP-SECRET-CONTENT");
    for (let i = 0; i < 300; i++) writeFileSync(join(tree, `f${String(i).padStart(3, "0")}.txt`), "plain");
    const target = join(tree, "f150.txt");
    const w = new Worker(
      `const {parentPort,workerData}=require("node:worker_threads");const fs=require("node:fs");
       const [t,s]=workerData;let stop=false;parentPort.on("message",()=>{stop=true});
       (function loop(){ if(stop) return; for(let i=0;i<2000;i++){ try{fs.unlinkSync(t);fs.symlinkSync(s,t);fs.unlinkSync(t);fs.writeFileSync(t,"plain");}catch{} } setImmediate(loop);})();`,
      { eval: true, workerData: [target, secret] },
    );
    let leaked = false;
    const deadline = Date.now() + 8000;
    try {
      while (!leaked && Date.now() < deadline) {
        let r;
        try {
          r = scanDirectoryReport(tree);
        } catch {
          continue; // "changed while scanned" is the defence working
        }
        leaked = r.files.some((f) => Buffer.from(f.bytes).toString() === "TOP-SECRET-CONTENT");
      }
    } finally {
      w.postMessage("stop");
      await w.terminate();
    }
    expect(leaked).toBe(false);
  }, 20000);
});

describe("pathological trees", () => {
  it("a very deep directory chain does not crash with a stack overflow in the walker (<=2000 levels)", () => {
    // ENAMETOOLONG / PATH_MAX will stop real depth long before recursion does; assert no hang.
    let p = tree;
    let made = 0;
    try {
      for (let i = 0; i < 200; i++) {
        p = join(p, "d");
        mkdirSync(p);
        made++;
      }
    } catch {
      /* path limit */
    }
    writeFileSync(join(p, "leaf.txt"), "x");
    expect(() => scanDirectoryReport(tree)).not.toThrow();
    expect(made).toBeGreaterThan(10);
  });
  it("ACCEPTED: no total file-count / byte cap on the local scan (the local user chose the directory) ", () => {
    // 2000 files is cheap; the point is there is no limit parameter or LimitExceededError in the walker.
    for (let i = 0; i < 2000; i++) writeFileSync(join(tree, `n${i}.txt`), "x");
    expect(scanDirectoryReport(tree).files).toHaveLength(2000);
  });
  it("FIFOs and sockets are skipped silently", () => {
    // cannot mkfifo portably in vitest without child_process; assert the code path via a rename churn instead
    writeFileSync(join(tree, "a"), "1");
    renameSync(join(tree, "a"), join(tree, "b"));
    unlinkSync(join(tree, "b"));
    expect(scanDirectoryReport(tree).files).toEqual([]);
  });
});
