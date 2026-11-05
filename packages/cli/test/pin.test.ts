/**
 * CLI test for `abxfs pin`. Runs an in-process HTTP server that fakes Kubo's `/api/v0/dag/import`: it parses the
 * multipart CAR, re-hashes every block, requires every link to resolve (what a node needs to pin the root), and
 * answers with the CAR's root. The uploaded tree holds an empty folder, which a file-by-file upload could not express.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AbxfsCid } from "@artblocks/abxfs-sdk";

import { startAnvilWithAbxfs, type AnvilHarness } from "../../sdk/test/helpers/anvil.js";
import { reachable, readCar } from "../../pinning/test/helpers/car-reader.js";
import { buildProgram } from "../src/index.js";

function anvilInstalled(): boolean {
  try {
    return spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
}

const SHOULD_SKIP = !anvilInstalled();
if (SHOULD_SKIP) console.warn("cli pin tests skipped: anvil not on PATH");

interface FakeKubo {
  port: number;
  /** Roots imported so far. */
  imported: string[];
  stop: () => Promise<void>;
}

async function startFakeKubo(): Promise<FakeKubo> {
  const imported: string[] = [];
  const server: Server = createServer((req, res) => {
    // `abxfs pin` checks the node is a Kubo RPC API before it reads anything from chain (audit F15).
    if (req.url?.startsWith("/api/v0/version")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Version: "0.30.0-fake" }));
      return;
    }
    if (!req.url?.startsWith("/api/v0/dag/import")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const form = await new Response(Buffer.concat(chunks), {
            headers: { "content-type": req.headers["content-type"] ?? "" },
          }).formData();
          const car = await readCar(new Uint8Array(await (form.get("file") as File).arrayBuffer()));
          const root = car.roots[0]!;
          reachable(car, root); // throws on a missing block
          imported.push(root);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ Root: { Cid: { "/": root }, PinErrorMsg: "" } }) + "\n");
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      })();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not bind fake Kubo");
  return {
    port: addr.port,
    imported,
    stop: () => new Promise<void>((res) => server.close(() => res())),
  };
}

async function run(args: string[]): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    await buildProgram().parseAsync(["node", "abxfs", ...args]);
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

describe.skipIf(SHOULD_SKIP)("cli pin", () => {
  let harness: AnvilHarness;
  let tmp: string;
  let kubo: FakeKubo;
  let rootCid: AbxfsCid;
  let expectedRoot: string;

  beforeAll(async () => {
    harness = await startAnvilWithAbxfs({ deployCompanion: true });
    kubo = await startFakeKubo();

    tmp = mkdtempSync(resolve(tmpdir(), "abxfs-cli-pin-"));
    const sourceDir = resolve(tmp, "src");
    mkdirSync(resolve(sourceDir, "empty"), { recursive: true });
    writeFileSync(resolve(sourceDir, "hello.txt"), "hello abxfs pin\n");

    const configPath = resolve(tmp, ".abxfs.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultChain: "local",
        chains: { local: { chainId: 31337, rpcUrl: harness.rpcUrl, addresses: harness.addresses } },
      }),
    );
    process.env["ABXFS_CONFIG"] = configPath;
    process.env["ABXFS_PRIVATE_KEY"] = ANVIL_PK;

    // Upload content. No project token needed — pinning addresses a root CID.
    const out = await run(["upload", sourceDir, "--yes"]);
    const rootMatch = out.match(/root directory:\s+(0x[0-9a-f]{64})/);
    if (!rootMatch) throw new Error(`no root CID in upload output:\n${out}`);
    rootCid = rootMatch[1]! as AbxfsCid;

    const { createClient } = await import("../src/client.js");
    const { loadConfig, resolveChain } = await import("../src/config.js");
    expectedRoot = await createClient(resolveChain(loadConfig())).verifyLocalIpfsCid(rootCid);
  }, 180_000);

  afterAll(async () => {
    try {
      await harness?.stop();
      await kubo?.stop();
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      restoreEnv();
    }
  });

  it("pin --cid <root> --provider local imports the CAR into Kubo and checks the on-chain CID", async () => {
    const out = await run([
      "pin",
      "--cid",
      rootCid,
      "--provider",
      "local",
      "--endpoint",
      `http://127.0.0.1:${kubo.port}`,
    ]);
    expect(out).toMatch(/provider\s+local/);
    expect(out).toContain(expectedRoot);
    expect(kubo.imported).toContain(expectedRoot);
    expect(out).toMatch(/on-chain CID matches pinned root/);
  }, 180_000);

  it("pin --car <path> writes the CAR and uploads nothing", async () => {
    const before = kubo.imported.length;
    const carPath = resolve(tmp, "site.car");
    const out = await run(["pin", "--cid", rootCid, "--car", carPath]);
    expect(out).toContain(expectedRoot);
    expect(out).toMatch(/on-chain CID matches pinned root/);
    const car = await readCar(new Uint8Array(readFileSync(carPath)));
    expect(car.roots).toEqual([expectedRoot]);
    expect(reachable(car, expectedRoot)).toEqual(new Set(car.order));
    // The empty folder's standard block is in the archive.
    expect(car.blocks.has("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354")).toBe(true);
    expect(kubo.imported.length).toBe(before);
  }, 180_000);

  it("pin --car refuses to overwrite an existing file", async () => {
    const carPath = resolve(tmp, "taken.car");
    writeFileSync(carPath, "keep me");
    await expect(run(["pin", "--cid", rootCid, "--car", carPath])).rejects.toThrow(/EEXIST/);
    expect(readFileSync(carPath, "utf8")).toBe("keep me");
    expect(existsSync(carPath)).toBe(true);
  }, 180_000);

  it("refuses an unknown provider", async () => {
    await expect(run(["pin", "--cid", rootCid, "--provider", "web3storage"])).rejects.toThrow(/unknown provider/);
  }, 180_000);

  it("pin --cid <bytes32> requires hex format", async () => {
    await expect(
      run(["pin", "--cid", "not-hex", "--provider", "local", "--endpoint", `http://127.0.0.1:${kubo.port}`]),
    ).rejects.toThrow(/not a valid ABX FS CID/);
  });
});
