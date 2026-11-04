/**
 * Delta audit (informational): `abxfs dev` orphaned anvil on SIGTERM. Ctrl-C reaches the whole process group, but a
 * SIGTERM (a supervisor, `kill`) reaches the CLI alone, and its default ended the CLI at once with anvil still bound
 * to its port. Now SIGTERM and SIGINT both stop anvil (and a forge script in flight) and let the command finish.
 *
 * Runs the BUILT CLI with a stub `forge` and the real anvil; skipped without either.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertPortFree, waitForAnvil } from "../../src/commands/dev.js";

const CLI_DIST = resolve(__dirname, "../../dist/index.js");
const anvilInstalled = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** A checkout whose `forge` is a shell script: `body` runs instead of the real one. */
function checkout(body: string): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-dev-sig-"));
  mkdirSync(join(dir, "packages/contracts-core"), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "forge"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "forge"), 0o755);
  return { dir, bin };
}

/** Start the built `abxfs dev`; resolves once `ready` matches its output. */
function startDev(dir: string, bin: string, port: number, ready: RegExp): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(process.execPath, [CLI_DIST, "dev", "--i-trust-this-dir", "--port", String(port)], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  return new Promise((res, rej) => {
    const timer = setTimeout(() => (child.kill("SIGKILL"), rej(new Error(`not ready in time:\n${output}`))), 40_000);
    const on = (d: Buffer) => {
      output += d;
      if (ready.test(output)) {
        clearTimeout(timer);
        res({ child, output: () => output });
      }
    };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.once("exit", () => (clearTimeout(timer), rej(new Error(`exited early:\n${output}`))));
  });
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res(child.exitCode);
    const timer = setTimeout(() => (child.kill("SIGKILL"), res(-1)), 20_000);
    child.once("exit", (c) => (clearTimeout(timer), res(c)));
  });

/** A forge that "deploys" the content layer: prints the five addresses the CLI parses. */
const DEPLOYING_FORGE = [
  "echo '== Logs =='",
  ...["ChunkStore", "Sstore2Backend", "FastLzSstore2Backend", "FileStore", "DirectoryStore"].map(
    (n, i) => `echo '  ${n} 0x${(i + 1).toString(16).padStart(40, "0")}'`,
  ),
  "exit 0",
].join("\n");

describe.skipIf(!anvilInstalled || !existsSync(CLI_DIST) || process.platform === "win32")("`abxfs dev` and signals", () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    it(`${sig} while it waits stops anvil and ends the command`, async () => {
      const { dir, bin } = checkout(DEPLOYING_FORGE);
      const port = await freePort();
      const { child, output } = await startDev(dir, bin, port, /press Ctrl-C to stop anvil/);
      expect(existsSync(join(dir, ".abxfs/dev-chain.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, ".abxfs/dev-chain.json"), "utf8")).chains.local.addresses.chunkStore).toMatch(/^0x0+1$/);
      child.kill(sig);
      const code = await exited(child);
      expect(code, output()).toBe(0);
      expect(output()).toContain(`${sig}: anvil stopped`);
      await new Promise((r) => setTimeout(r, 300));
      await expect(assertPortFree(port)).resolves.toBeUndefined(); // anvil is gone
    }, 60_000);
  }

  it("SIGTERM while forge runs stops forge and anvil, and fails the command", async () => {
    const { dir, bin } = checkout("echo 'stub forge: deploying slowly' >&2\nsleep 30\nexit 0");
    const port = await freePort();
    const { child, output } = await startDev(dir, bin, port, /deploying slowly/);
    child.kill("SIGTERM");
    const code = await exited(child);
    expect(code, output()).toBe(1);
    expect(output()).toMatch(/forge script was stopped \(SIGTERM\); anvil was stopped/);
    await new Promise((r) => setTimeout(r, 300));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  }, 60_000);
});

describe("waiting for anvil: what a node that answers badly reads as", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });
  async function node(answer: (res: import("node:http").ServerResponse) => void): Promise<string> {
    const s = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => answer(res));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const running = { exitCode: null, signalCode: null };

  it("an HTTP error is retried until the deadline, then named", async () => {
    const url = await node((res) => ((res.statusCode = 503), res.end("no backend")));
    await expect(waitForAnvil(url, running, 31337, 600)).rejects.toThrow(/timed out after 0\.6s waiting for anvil .*web3_clientVersion: HTTP 503/);
  });

  it("a JSON-RPC error is retried until the deadline, then named", async () => {
    const url = await node((res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }));
    });
    await expect(waitForAnvil(url, running, 31337, 600)).rejects.toThrow(/web3_clientVersion: method not found/);
  });

  it("a JSON-RPC error without a message still names the method", async () => {
    const url = await node((res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }));
    });
    await expect(waitForAnvil(url, running, 31337, 600)).rejects.toThrow(/web3_clientVersion: error\)/);
  });
});
