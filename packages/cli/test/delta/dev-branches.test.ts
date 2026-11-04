/**
 * Delta audit round 2: `abxfs dev` branches the coverage found untested. A `forge` that cannot be started, one that
 * fails, the companion deploy (`--companion`), and an anvil that exits on its own while the command waits.
 *
 * Runs the BUILT CLI with a stub `forge` and the real anvil, as `dev-signals.test.ts` does; skipped without either.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assertPortFree } from "../../src/commands/dev.js";

const CLI_DIST = resolve(__dirname, "../../dist/index.js");
const anvilPath = spawnSync("sh", ["-c", "command -v anvil"], { encoding: "utf8" }).stdout.trim();
const pkill = spawnSync("sh", ["-c", "command -v pkill"], { encoding: "utf8" }).stdout.trim();

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A checkout whose `bin` holds a stub `forge` (a shell script running `body`, or none at all) and anvil. With
 * `onlyBin`, PATH is that directory and the system's shell tools alone, so a missing `forge` cannot be found elsewhere.
 */
function checkout(body: string | undefined, opts: { companion?: boolean } = {}): { dir: string; bin: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-dev-branch-"));
  mkdirSync(join(dir, "packages/contracts-core"), { recursive: true });
  if (opts.companion) mkdirSync(join(dir, "packages/contracts-companion"), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(anvilPath, join(bin, "anvil"));
  if (body !== undefined) {
    writeFileSync(join(bin, "forge"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "forge"), 0o755);
  }
  return { dir, bin, path: `${bin}:/usr/bin:/bin` };
}

/** Start the built `abxfs dev`; resolves once `ready` matches its output (or it exits, when `ready` is undefined). */
function startDev(
  co: { dir: string; path: string },
  port: number,
  extra: string[] = [],
): { child: ChildProcess; output: () => string; waitFor: (re: RegExp) => Promise<void>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [CLI_DIST, "dev", "--i-trust-this-dir", "--port", String(port), ...extra], {
    cwd: co.dir,
    env: { PATH: co.path, HOME: co.dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const waiters: Array<{ re: RegExp; res: () => void }> = [];
  const on = (d: Buffer) => {
    output += d;
    for (const w of waiters.splice(0)) (w.re.test(output) ? w.res() : waiters.push(w));
  };
  child.stdout!.on("data", on);
  child.stderr!.on("data", on);
  const exited = new Promise<number | null>((res) => {
    const timer = setTimeout(() => (child.kill("SIGKILL"), res(-1)), 50_000);
    child.once("exit", (c) => (clearTimeout(timer), res(c)));
  });
  const waitFor = (re: RegExp) =>
    re.test(output)
      ? Promise.resolve()
      : new Promise<void>((res, rej) => {
          waiters.push({ re, res });
          void exited.then(() => (re.test(output) ? res() : rej(new Error(`exited before ${re}:\n${output}`))));
        });
  return { child, output: () => output, waitFor, exited };
}

const addressLines = (names: string[], from: number) =>
  ["echo '== Logs =='", ...names.map((n, i) => `echo '  ${n} 0x${(from + i).toString(16).padStart(40, "0")}'`)].join("\n");
const CONTENT = ["ChunkStore", "Sstore2Backend", "FastLzSstore2Backend", "FileStore", "DirectoryStore"];

describe.skipIf(!anvilPath || !existsSync(CLI_DIST) || process.platform === "win32")("`abxfs dev`: forge and anvil failures", () => {
  it("a forge that is not installed fails the command, naming it, and stops anvil", async () => {
    const co = checkout(undefined);
    const port = await freePort();
    const dev = startDev(co, port);
    const code = await dev.exited;
    expect(code, dev.output()).toBe(1);
    expect(dev.output()).toMatch(/could not run forge: spawn forge ENOENT/);
    await new Promise((r) => setTimeout(r, 300));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  }, 60_000);

  it("a forge script that fails fails the command with its exit code, and stops anvil", async () => {
    const co = checkout("echo 'stub forge: compile error' >&2\nexit 3");
    const port = await freePort();
    const dev = startDev(co, port);
    const code = await dev.exited;
    expect(code, dev.output()).toBe(1);
    expect(dev.output()).toMatch(/forge script failed \(exit 3\); anvil was stopped/);
    await new Promise((r) => setTimeout(r, 300));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  }, 60_000);

  it("--companion deploys the IPFS CID resolver from contracts-companion and records its address", async () => {
    // The same stub answers both deploys, by the directory forge runs in.
    const co = checkout(
      [
        'case "$PWD" in',
        `  *contracts-companion) ${addressLines(["IpfsCidResolver"], 0x99).replace(/\n/g, "; ")} ;;`,
        `  *) ${addressLines(CONTENT, 1).replace(/\n/g, "; ")} ;;`,
        "esac",
        "exit 0",
      ].join("\n"),
      { companion: true },
    );
    const port = await freePort();
    const dev = startDev(co, port, ["--companion"]);
    await dev.waitFor(/press Ctrl-C to stop anvil/);
    const manifest = JSON.parse(readFileSync(join(co.dir, ".abxfs/dev-chain.json"), "utf8")) as {
      chains: { local: { addresses: Record<string, string> } };
    };
    expect(manifest.chains.local.addresses["ipfsCidResolver"]).toBe(`0x${(0x99).toString(16).padStart(40, "0")}`);
    expect(manifest.chains.local.addresses["chunkStore"]).toMatch(/^0x0+1$/);
    dev.child.kill("SIGTERM");
    expect(await dev.exited, dev.output()).toBe(0);
  }, 60_000);

  it.skipIf(!pkill)("an anvil that exits on its own ends the wait, and the command with it", async () => {
    const co = checkout(`${addressLines(CONTENT, 1)}\nexit 0`);
    const port = await freePort();
    const dev = startDev(co, port);
    await dev.waitFor(/press Ctrl-C to stop anvil/);
    // Kill anvil itself, not the CLI: the command was waiting on it.
    spawnSync("pkill", ["-TERM", "-f", `anvil --host 127.0.0.1 --port ${port} `]);
    const code = await dev.exited;
    expect(code, dev.output()).toBe(0);
    expect(dev.output()).not.toMatch(/: anvil stopped/); // no signal reached the CLI
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  }, 60_000);
});
