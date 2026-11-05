/**
 * CLI smoke tests. Spin up Anvil, deploy the content layer + IPFS CID resolver, write a temp config, and exercise
 * a minimal `upload → read → info → verify` flow by driving the commander program in-process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AbxfsCid } from "@abxfs/sdk";

import { spawnSync } from "node:child_process";

import {
  startAnvilWithAbxfs,
  type AnvilHarness,
} from "../../sdk/test/helpers/anvil.js";
import { autoRegisterNodeCodecs } from "../../sdk/src/compression.js";
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
if (SHOULD_SKIP) console.warn("cli smoke tests skipped: anvil not on PATH");

describe.skipIf(SHOULD_SKIP)("cli smoke", () => {
  let harness: AnvilHarness;
  let tmp: string;
  let sourceDir: string;
  // Captured from the `upload + info + read` test and reused by `verify`. The CLI no
  // longer exposes a name → project lookup (names are deliberately non-unique on chain),
  // so the tests carry the projectId returned by the create transaction explicitly.
    let smokeRootCid: string | null = null;

  beforeAll(async () => {
    harness = await startAnvilWithAbxfs({ deployCompanion: true });

    tmp = mkdtempSync(resolve(tmpdir(), "abxfs-cli-"));
    sourceDir = resolve(tmp, "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(resolve(sourceDir, "hello.txt"), "hello abxfs\n");
    writeFileSync(resolve(sourceDir, "readme.md"), "# abxfs cli smoke\n");
    mkdirSync(resolve(sourceDir, "nested"), { recursive: true });
    writeFileSync(resolve(sourceDir, "nested/a.json"), JSON.stringify({ ok: true }));
    // An empty directory is content too: it must survive the upload and show up when read back.
    mkdirSync(resolve(sourceDir, "empty"), { recursive: true });

    const configPath = resolve(tmp, ".abxfs.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          defaultChain: "local",
          chains: {
            local: {
              chainId: 31337,
              rpcUrl: harness.rpcUrl,
              addresses: harness.addresses,
            },
          },
        },
        null,
        2,
      ),
    );

    process.env["ABXFS_CONFIG"] = configPath;
    process.env["ABXFS_PRIVATE_KEY"] = ANVIL_PK;
  }, 180_000);

  afterAll(async () => {
    try {
      await harness?.stop();
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      restoreEnv();
    }
  });

  it("upload --dry-run computes a root CID without sending transactions", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      await buildProgram().parseAsync(["node", "abxfs", "upload", sourceDir, "--dry-run"]);
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toMatch(/dry-run/);
    expect(joined).toMatch(/0x[0-9a-f]{64}/);
    expect(joined).toMatch(/hello\.txt/);
    expect(joined).toMatch(/nested\/a\.json/);
    // The plan: node counts, transactions and estimated gas, per stage.
    expect(joined).toMatch(/chunk node\(s\), \d+ entry node\(s\)/);
    expect(joined).toMatch(/up to \d+ transaction\(s\), ~[\d,]+ gas estimated/);
    expect(joined).toMatch(/directories wave \d+\s+\d+ call\(s\) in \d+ tx/);
  }, 120_000);

  it("upload + read", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      // No --name: uploading content is complete on its own. The root is addressable at
      // /g/cid/<chain>/<root> whether or not a project token ever points at it.
      await buildProgram().parseAsync(["node", "abxfs", "upload", sourceDir, "--yes"]);
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toMatch(/root directory:\s+0x[0-9a-f]{64}/);
    // Per-transaction progress: stage, calls done/total in the stage, transactions done/total.
    expect(joined).toMatch(/chunks\s+\d+\/\d+\s+tx \d+\/\d+/);
    expect(joined).toMatch(/directories wave 0\s+1\/1\s+tx \d+\/\d+/);
    expect(joined).toMatch(/addressable by CID/);

    const rootMatch = joined.match(/root directory:\s+(0x[0-9a-f]{64})/);
    const rootCid = rootMatch![1]!;
    smokeRootCid = rootCid;

    // read directory listing
    const readLogs: string[] = [];
    console.log = (...args: unknown[]) => void readLogs.push(args.map(String).join(" "));
    try {
      await buildProgram().parseAsync(["node", "abxfs", "read", rootCid]);
    } finally {
      console.log = origLog;
    }
    const readJoined = readLogs.join("\n");
    expect(readJoined).toMatch(/hello\.txt/);
    expect(readJoined).toMatch(/readme\.md/);
    expect(readJoined).toMatch(/nested/);
    expect(readJoined).toMatch(/empty/);
  }, 180_000);

  it("upload <single-file> takes the file-kind path", async () => {
    // The CLI auto-detects file-vs-directory from the local FS (statSync on the path arg), so a
    // single file runs `uploadFile` rather than the directory walk. The project-level consequence —
    // that the kind is then locked across versions — is enforced by ProjectHook and tested in
    // Solidity, where it can be asserted against the veto directly.
    const filePath = resolve(tmp, "single.html");
    writeFileSync(filePath, "<!doctype html><h1>hello single-file</h1>");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      await buildProgram().parseAsync(["node", "abxfs", "upload", filePath, "--yes"]);
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toMatch(/single file/);
    expect(joined).toMatch(/file root:\s+0x[0-9a-f]{64}/);

    // The file root must land in FileStore, not DirectoryStore — that distinction is what the hook
    // later locks, and it is decided here.
    const rootCid = joined.match(/file root:\s+(0x[0-9a-f]{64})/)![1]!;
    const { createClient } = await import("../src/client.js");
    const { loadConfig, resolveChain } = await import("../src/config.js");
    const { ProjectKind } = await import("@abxfs/sdk");
    const client = createClient(resolveChain(loadConfig()));
    expect(await client.cidKind(rootCid as AbxfsCid)).toBe(ProjectKind.File);
  }, 240_000);

  it("verify checks on-chain vs local IPFS CID parity for a file and for the directory", async () => {
    expect(smokeRootCid).not.toBeNull();
    const { createClient } = await import("../src/client.js");
    const { loadConfig, resolveChain } = await import("../src/config.js");
    const client = createClient(resolveChain(loadConfig()));
    const file = await client.resolvePath(smokeRootCid as AbxfsCid, "hello.txt");
    expect(file.isDirectory).toBe(false);

    for (const cid of [file.cid, smokeRootCid!]) {
      const joined = await runVerify([cid]);
      expect(joined).toMatch(/on-chain\s+baf/);
      expect(joined).toMatch(/local\s+baf/);
      expect(joined).toMatch(/✓ match/);
    }
  }, 120_000);

  it("a file with an off-chain codec verifies locally, saying why there is no on-chain value", async () => {
    await autoRegisterNodeCodecs();
    const filePath = resolve(tmp, "gz.txt");
    writeFileSync(filePath, "squeeze me ".repeat(500));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      await buildProgram().parseAsync(["node", "abxfs", "upload", filePath, "--codec", "gzip", "--yes"]);
    } finally {
      console.log = origLog;
    }
    const rootCid = logs.join("\n").match(/file root:\s+(0x[0-9a-f]{64})/)![1]!;

    const joined = await runVerify([rootCid]);
    expect(joined).toMatch(/local\s+bafk/);
    expect(joined).toMatch(/cannot decode this content's file codec/);
    await expect(buildProgram().parseAsync(["node", "abxfs", "verify", rootCid, "--on-chain"])).rejects.toThrow(/off-chain codec/);
  }, 120_000);
});

async function runVerify(args: string[]): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    await buildProgram().parseAsync(["node", "abxfs", "verify", ...args]);
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}
