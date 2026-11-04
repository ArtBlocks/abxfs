/**
 * F9: `abxfs dev` hands anvil's well-known key to forge, so it must deploy only to the anvil it just started: the
 * port is free first, the node that answers is anvil, on the chain id asked for, and still the child; a failed forge
 * stops the command and anvil with it; waiting for the node is bounded.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertPortFree, parseChainId, parsePort, waitForAnvil } from "../../src/commands/dev.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** A JSON-RPC node that says it is `client` on `chainId`. */
async function fakeNode(client: string, chainId: number): Promise<string> {
  const s = createHttpServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const { id, method } = JSON.parse(b) as { id: number; method: string };
      const result = method === "web3_clientVersion" ? client : "0x" + chainId.toString(16);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const running = { exitCode: null, signalCode: null };

describe("F9: what `abxfs dev` deploys to", () => {
  it("refuses a port something already listens on, before anything is spawned", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    try {
      await expect(assertPortFree(port)).rejects.toThrow(new RegExp(`something already listens on 127\\.0\\.0\\.1:${port}`));
    } finally {
      await new Promise((r) => s.close(r));
    }
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it("refuses a node that is not anvil", async () => {
    const url = await fakeNode("Geth/v1.14.0-stable", 31337);
    await expect(waitForAnvil(url, running, 31337, 5_000)).rejects.toThrow(/is not anvil \(web3_clientVersion: Geth\/v1\.14\.0-stable\): refusing to deploy to it/);
  });

  it("refuses an anvil on another chain id", async () => {
    const url = await fakeNode("anvil/v1.2.3", 1);
    await expect(waitForAnvil(url, running, 31337, 5_000)).rejects.toThrow(/has chain id 1, not 31337: refusing to deploy to it/);
  });

  it("refuses when the child it started has exited, even if something answers", async () => {
    const url = await fakeNode("anvil/v1.2.3", 31337);
    await expect(waitForAnvil(url, { exitCode: 1, signalCode: null }, 31337, 5_000)).rejects.toThrow(/anvil exited \(1\) before it was ready/);
  });

  it("accepts the anvil it asked for", async () => {
    const url = await fakeNode("anvil/v1.2.3", 31337);
    await expect(waitForAnvil(url, running, 31337, 5_000)).resolves.toBeUndefined();
  });

  it("gives up in bounded time when nothing answers", async () => {
    const t = Date.now();
    await expect(waitForAnvil(`http://127.0.0.1:${await freePort()}`, running, 31337, 600)).rejects.toThrow(/timed out after 0\.6s waiting for anvil/);
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it("--port and --chain-id must be whole numbers in range", () => {
    for (const p of ["0", "65536", "80a", "-1", "1e3", ""]) expect(() => parsePort(p), p).toThrow(/--port must be a whole number from 1 to 65535/);
    expect(parsePort("8545")).toBe(8545);
    for (const c of ["0", "abc", "1.5", "-3"]) expect(() => parseChainId(c), c).toThrow(/--chain-id must be a positive whole number/);
    expect(parseChainId("31337")).toBe(31337);
  });
});

const CLI_DIST = resolve(__dirname, "../../dist/index.js");
const anvilInstalled = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!anvilInstalled || !existsSync(CLI_DIST) || process.platform === "win32")("F9: the built `abxfs dev` with a failing forge", () => {
  it("stops, with anvil killed, when forge fails", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "abxfs-dev-"));
    mkdirSync(join(checkout, "packages/contracts-core"), { recursive: true });
    const bin = join(checkout, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "forge"), "#!/bin/sh\necho 'stub forge: failing on purpose' >&2\nexit 1\n");
    chmodSync(join(bin, "forge"), 0o755);
    const port = await freePort();
    const child = spawn(process.execPath, [CLI_DIST, "dev", "--i-trust-this-dir", "--port", String(port)], {
      cwd: checkout,
      env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: checkout },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((res) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        res(-1);
      }, 45_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        res(c);
      });
    });
    expect(code, output).toBe(1);
    expect(output).toMatch(/Anvil ready/);
    expect(output).toMatch(/forge script failed \(exit 1\); anvil was stopped/);
    // anvil is gone: its port is free again.
    await new Promise((r) => setTimeout(r, 500));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  }, 60_000);

  it("refuses a busy port without starting anvil", () => {
    const checkout = mkdtempSync(join(tmpdir(), "abxfs-dev-"));
    mkdirSync(join(checkout, "packages/contracts-core"), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise<void>((done, fail) => {
      holder.stdout.once("data", (d) => {
        try {
          const port = String(d).trim();
          const r = spawnSync(process.execPath, [CLI_DIST, "dev", "--i-trust-this-dir", "--port", port], { cwd: checkout, env: { PATH: process.env["PATH"]!, HOME: checkout }, encoding: "utf8", timeout: 20_000 });
          expect(r.status).toBe(1);
          expect(r.stderr).toMatch(/something already listens on 127\.0\.0\.1:\d+/);
          expect(r.stdout).not.toMatch(/starting Anvil/);
          done();
        } catch (e) {
          fail(e);
        } finally {
          holder.kill();
        }
      });
    });
  }, 30_000);
});
