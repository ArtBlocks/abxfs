/**
 * DELTA AUDIT: the `bin` flags the fix round added (`--root-max-age` on the gateway, `--max-entries-per-root` and the
 * checked `--poll-seconds` on the mirror), through the real executables. They run from `dist`, as installed: build
 * first (`pnpm --filter @artblocks/abxfs-gateway build`; CI builds every package before these tests). The parsers themselves
 * are tested directly as well, so a missing `dist` skips only the wiring.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseMaxFileBytes, parseRootMaxAge } from "../../src/config.js";

const BIN = resolve(__dirname, "../../dist/bin");
const built = existsSync(resolve(BIN, "gateway.js")) && existsSync(resolve(BIN, "mirror.js"));
const run = (bin: string, args: string[]) => spawnSync(process.execPath, [resolve(BIN, bin), ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ABXFS_RPC_URL: "" } });

describe("flag parsers", () => {
  it("--root-max-age: a whole number of seconds, 0 included, canonical spelling only", () => {
    expect(parseRootMaxAge("0")).toBe(0);
    expect(parseRootMaxAge("60")).toBe(60);
    expect(parseRootMaxAge("31536000")).toBe(31_536_000);
    for (const bad of ["", "-1", "1.5", "060", "1e3", "abc", " 60", "12345678901"]) {
      expect(() => parseRootMaxAge(bad), bad).toThrow(/--root-max-age expects a whole number of seconds/);
    }
  });

  it("--max-file-bytes: a positive whole number", () => {
    expect(parseMaxFileBytes("67108864")).toBe(67_108_864);
    for (const bad of ["0", "-1", "1.5", "1e9", "abc", "01"]) expect(() => parseMaxFileBytes(bad), bad).toThrow(/--max-file-bytes expects a positive integer/);
  });
});

describe.skipIf(!built)("the executables", () => {
  it("abxfs-gateway --help documents --root-max-age", () => {
    const r = run("gateway.js", ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--root-max-age <seconds>/);
  });

  it("abxfs-gateway refuses a --root-max-age that is not a whole number, before serving anything", () => {
    const r = run("gateway.js", ["--content-domain", "c.example", "--root-max-age", "abc", "--port", "0"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--root-max-age expects a whole number of seconds \(got "abc"\)/);
  });

  /// The registry has no addresses until a deployment is verified, and the gateway refuses to serve a chain without
  /// them ("not deployed"). Either way a valid flag gets PAST flag checking: to the listening line once a chain is
  /// deployed, to the chain check before then.
  it("abxfs-gateway accepts a valid --root-max-age", async () => {
    const child = spawn(process.execPath, [resolve(BIN, "gateway.js"), "--content-domain", "c.example", "--root-max-age", "60", "--port", "0", "--host", "127.0.0.1"], {
      env: { ...process.env, ABXFS_RPC_URL: "" },
    });
    try {
      const line = await new Promise<string>((done, fail) => {
        let out = "";
        const onData = (b: Buffer) => {
          out += String(b);
          if (/listening on/.test(out)) done(out);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", (code) => (/not deployed/.test(out) ? done(out) : fail(new Error(`exited ${code}: ${out}`))));
        setTimeout(() => fail(new Error(`no listening line: ${out}`)), 20_000);
      });
      expect(line).toMatch(/listening on http:\/\/127\.0\.0\.1:|not deployed/);
      expect(line).not.toMatch(/--root-max-age/);
    } finally {
      child.kill();
    }
  });

  it("abxfs-mirror --help documents --max-entries-per-root and --poll-seconds", () => {
    const r = run("mirror.js", ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--max-entries-per-root 100000/);
    expect(r.stdout).toMatch(/--poll-seconds is how long to wait/);
  });

  it("abxfs-mirror refuses a --poll-seconds that is not a positive number, before reading anything (exit 2)", () => {
    for (const bad of ["abc", "0", "-5"]) {
      const r = run("mirror.js", ["--chain", "base-sepolia", `--poll-seconds=${bad}`]);
      expect(r.status, bad).toBe(2);
      expect(r.stderr).toMatch(/NOT STARTED: --poll-seconds must be a positive number of seconds/);
    }
  });
});
