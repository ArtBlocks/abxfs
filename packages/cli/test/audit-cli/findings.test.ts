/**
 * The CLI audit's findings, run against the BUILT CLI in a child process with a timeout, as a user would run it.
 * Ported from the auditor's regression tests (each failed before its fix). Skipped when `dist/` is missing; CI
 * builds every package before the CLI tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_CONFIG_BYTES } from "../../src/config.js";
import { redact } from "../../src/redact.js";

const CLI_DIST = resolve(__dirname, "../../dist/index.js");
const VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { version: string }).version;
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const tmp = () => mkdtempSync(join(tmpdir(), "abxfs-find-"));
const env = (extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"]!, HOME: "/nonexistent", ...extra });
const run = (args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}) =>
  spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: opts.cwd ?? tmp(),
    env: opts.env ?? env(),
    encoding: "utf8",
    timeout: opts.timeout ?? 20_000,
  });

describe.skipIf(!existsSync(CLI_DIST))("built CLI", () => {
  describe("F1: nothing from an untrusted ./.abxfs.json reaches the terminal raw", () => {
    it("escape sequences in chain names, address keys, defaultChain and JSON errors are neutralised", () => {
      const dir = tmp();
      writeFileSync(
        join(dir, ".abxfs.json"),
        JSON.stringify({
          defaultChain: "\u001b[2Jevil",
          chains: {
            "\u001b]52;c;ZXZpbA==\u0007x": { chainId: 84532 },
            "base-sepolia": { addresses: { "\u001b]0;pwn\u0007k": "0x1" }, "\u001b]0;key\u0007": 1 },
          },
        }),
      );
      const r = run(["org", "info", addr(1)], { cwd: dir });
      expect(r.error).toBeUndefined();
      expect(r.stderr).not.toContain("\u001b]");
      expect(r.stderr).not.toContain("\u001b[2J");
      expect(r.stderr).not.toContain("\u0007");
    });

    it("a JSON syntax error quoting hostile text is neutralised too", () => {
      const dir = tmp();
      writeFileSync(join(dir, ".abxfs.json"), "{\u001b]52;c;ZXZpbA==\u0007");
      const r = run(["org", "info", addr(1)], { cwd: dir });
      expect(r.stderr).toMatch(/ignoring .*\.abxfs\.json/);
      expect(r.stderr).not.toContain("\u001b]");
      // A path in the current directory is config-derived text too.
      const evilDir = join(tmp(), "a\u001b]0;x\u0007b");
      mkdirSync(evilDir);
      writeFileSync(join(evilDir, ".abxfs.json"), "not json");
      const r2 = run(["org", "info", addr(1)], { cwd: evilDir });
      expect(r2.stderr).toMatch(/ignoring/);
      expect(r2.stderr).not.toContain("\u001b]");
    });
  });

  describe("F2: an untrusted ./.abxfs.json that is not a small regular file is skipped, never read", () => {
    it("a FIFO named .abxfs.json does not hang the CLI", () => {
      const dir = tmp();
      const made = spawnSync("mkfifo", [join(dir, ".abxfs.json")]);
      if (made.status !== 0) return; // no mkfifo here (Windows): nothing to test
      const r = run(["org", "info", addr(1)], { cwd: dir, timeout: 10_000 });
      expect(r.error).toBeUndefined(); // spawnSync reports ETIMEDOUT here when the child had to be killed
      expect(r.stderr).toMatch(/ignoring .*\.abxfs\.json.*a FIFO/);
    });

    it("a symlink to /dev/zero is skipped, not followed", () => {
      const dir = tmp();
      symlinkSync("/dev/zero", join(dir, ".abxfs.json"));
      const r = run(["org", "info", addr(1)], { cwd: dir, timeout: 10_000 });
      expect(r.error).toBeUndefined();
      expect(r.stderr).toMatch(/ignoring .*\.abxfs\.json.*a symlink/);
    });

    it("a file over 256 KiB is skipped before it is read", () => {
      const dir = tmp();
      writeFileSync(join(dir, ".abxfs.json"), `{"chains":{},"pad":"${"x".repeat(MAX_CONFIG_BYTES)}"}`);
      const r = run(["org", "info", addr(1)], { cwd: dir, timeout: 10_000 });
      expect(r.stderr).toMatch(/ignoring .*\.abxfs\.json.*larger than 256 KiB/);
    });

    it("the same cap applies to a trusted ABXFS_CONFIG, as an error", () => {
      const dir = tmp();
      const p = join(dir, "cfg.json");
      writeFileSync(p, `{"chains":{},"pad":"${"x".repeat(MAX_CONFIG_BYTES)}"}`);
      const r = run(["org", "info", addr(1)], { env: env({ ABXFS_CONFIG: p }) });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Refusing to load .*cfg\.json.*larger than 256 KiB/);
    });
  });

  describe("F4: `pin --version` is not swallowed by the program-level --version", () => {
    it("reaches the pin command (which says it is now --project-version) instead of printing the CLI version", () => {
      const r = run(["pin", "--project-id", "1", "--version", "2", "--chain", "base-sepolia"]);
      expect(r.stdout.trim()).not.toBe(VERSION);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--project-version/);
    });

    it("`abxfs --version` still prints the version, the package's own", () => {
      const r = run(["--version"]);
      expect(r.stdout.trim()).toBe(VERSION);
    });
  });

  describe("F12: --max-bundle-gas must be a positive integer", () => {
    it.each(["abc", "12,000,000", "0", "-1", "", "1e6", "1.5", "0x10"])("refuses %j before planning", (v) => {
      const dir = tmp();
      mkdirSync(join(dir, "site"));
      writeFileSync(join(dir, "site", "a.txt"), "x");
      writeFileSync(
        join(dir, "cfg.json"),
        JSON.stringify({
          defaultChain: "l",
          chains: { l: { chainId: 31337, rpcUrl: "http://127.0.0.1:9", addresses: { chunkStore: addr(1), fileStore: addr(2), directoryStore: addr(3), sstore2Backend: addr(4), fastLzBackend: addr(5) } } },
        }),
      );
      const r = run(["upload", join(dir, "site"), "--dry-run", `--max-bundle-gas=${v}`], {
        env: env({ ABXFS_CONFIG: join(dir, "cfg.json"), ABXFS_PRIVATE_KEY: "0x" + "11".repeat(32) }),
        timeout: 30_000,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/max-bundle-gas/);
    });

    it("refuses a config defaultBundleGasBudget that is not one", () => {
      const dir = tmp();
      writeFileSync(join(dir, "cfg.json"), JSON.stringify({ chains: { "base-sepolia": { defaultBundleGasBudget: 1.5 } } }));
      const r = run(["org", "info", addr(1)], { env: env({ ABXFS_CONFIG: join(dir, "cfg.json") }) });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/defaultBundleGasBudget must be a positive whole number/);
    });
  });
});

describe("F8: redact() is linear", () => {
  it("100 KB of dotted labels takes well under a second", () => {
    const t = performance.now();
    redact("a.".repeat(50_000));
    expect(performance.now() - t).toBeLessThan(250);
  });

  it("5 MB of adversarial text is scrubbed in bounded time", () => {
    for (const input of ["a.".repeat(2_500_000), "a".repeat(5_000_000), "a-".repeat(2_500_000), "x ".repeat(2_400_000) + "https://rpc.example/v2/KEY"]) {
      const t = performance.now();
      const out = redact(input);
      expect(performance.now() - t, input.slice(0, 8)).toBeLessThan(2_000);
      expect(out).not.toContain("KEY");
    }
  });

  it("still redacts what it redacted before", () => {
    expect(redact("failed at https://rpc.example/v2/SECRET123 ok")).toBe("failed at https://rpc.example/<redacted> ok");
    expect(redact("x ftp://u:p@h.example:2121/x?y")).toBe("x ftp://h.example:2121/<redacted>");
    expect(redact("see rpc.example.com/v2/KEY")).toBe("see rpc.example.com/<redacted>");
    expect(redact("(https://a.example/k)")).toBe("(https://a.example/<redacted>)");
    // Delta audit L1: a scheme after a run of [0-9+.-] that does not start with a letter. freeze-1 redacted these; the
    // first linear regex (a match had to START with a letter) printed the key in every one.
    for (const text of [
      "url=-https://rpc.example/v2/SECRET123",
      "see ...https://rpc.example/v2/SECRET123",
      "code 1https://rpc.example/v2/SECRET123",
      "--rpc-url=-https://rpc.example/v2/SECRET123",
    ]) {
      expect(redact(text), text).not.toContain("SECRET123");
    }
    expect(redact("url=-https://rpc.example/v2/SECRET123")).toBe("url=-https://rpc.example/<redacted>");
    expect(redact("see ...https://rpc.example/v2/SECRET123")).toBe("see ...https://rpc.example/<redacted>");
    // ...and the regex that catches them is still linear: a 5 MB run that may continue a scheme, and has no `://`.
    const t = performance.now();
    const input = "1.".repeat(2.5e6);
    expect(redact(input)).toBe(input);
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});
