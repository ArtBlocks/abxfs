/**
 * Delta audit round 2 (ported from the auditor's recovery PoC, updated to the command now riding on the error): the
 * command `upload` prints after a mint timeout, pasted into a shell, reproduces the root, even when the config's
 * defaults changed in between and the folder and an approved file are named like `host.tld/…`.
 *
 * Part A captures the command in-process (the mint timeout mocked) under config A (defaultCodec gzip, fastLz false).
 * Part B runs the BUILT CLI on anvil: the original upload under config A, and the printed command (through `sh`, as a
 * user would paste it) under config B (defaults flipped), both `--dry-run`. Skipped without anvil or a built CLI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TransactionTimeoutError } from "@artblocks/abxfs-sdk";

const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }));
vi.mock("../../src/client.js", () => ({
  createClient: () => h.client,
  createOrgClient: async () => h.client,
}));
vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readOrgsAdministeredAcrossGenerations: async () => ({
    orgs: [{ org: "0x00000000000000000000000000000000000000a1", name: "Mine", roles: ["admin"], open: false, createdBlock: 1n }],
    failed: [],
    failedGenerations: [],
  }),
}));

import { startAnvilWithAbxfs, type AnvilHarness } from "../../../sdk/test/helpers/anvil.js";
import { mockClient } from "../helpers/mock-client.js";
import { uploadCommand } from "../../src/commands/upload.js";
import { PendingWriteError, RECOVERY_POLL } from "../../src/recover.js";
import { formatCliError } from "../../src/redact.js";

const CLI_DIST = resolve(__dirname, "../../dist/index.js");
const TX = ("0x" + "12".repeat(32)) as `0x${string}`;
const anvilInstalled = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!anvilInstalled || !existsSync(CLI_DIST))("the recovery command, end to end", () => {
  let anvil: AnvilHarness;
  beforeAll(async () => {
    anvil = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", "60000000"] });
  });
  afterAll(async () => anvil?.stop());

  /** `<base>/mysite.com/build`: a page, a CSV, an empty-ish dotfile, and a secret-looking file approved by name. */
  function site(): string {
    const base = mkdtempSync(join(tmpdir(), "abxfs-rec-e2e-"));
    const dir = join(base, "mysite.com", "build");
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, "config.example.org"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>hi</p>".repeat(3000));
    writeFileSync(join(dir, "assets", "data.csv"), Array.from({ length: 4000 }, (_, i) => `${i},${(i * 7919) % 1000}\n`).join(""));
    writeFileSync(join(dir, ".nojekyll"), "");
    writeFileSync(join(dir, "config.example.org", "x.env"), "A=1\nB=2\nC=3\n");
    return base;
  }

  function config(file: string, defaults: { defaultCodec: string; fastLz: boolean }): void {
    writeFileSync(
      file,
      JSON.stringify({ chains: { local: { chainId: 31337, rpcUrl: anvil.rpcUrl, addresses: anvil.addresses, ...defaults } }, defaultChain: "local" }),
    );
  }

  it("the printed command reproduces the root under a config whose defaults changed", async () => {
    const base = site();
    const cfgA = join(mkdtempSync(join(tmpdir(), "abxfs-cfgA-")), "a.json");
    const cfgB = join(mkdtempSync(join(tmpdir(), "abxfs-cfgB-")), "b.json");
    config(cfgA, { defaultCodec: "gzip", fastLz: false });
    config(cfgB, { defaultCodec: "none", fastLz: true });
    const userArgs = ["mysite.com/build", "--include-hidden", "--allow-public", "config.example.org/x.env"];

    // Part A: the command, as the error carries it and the CLI prints it.
    const saved = { env: { ...process.env }, cwd: process.cwd(), attempts: RECOVERY_POLL.attempts };
    let printed: string;
    try {
      process.env["ABXFS_CONFIG"] = cfgA;
      process.chdir(base);
      RECOVERY_POLL.attempts = 1;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const oc = mockClient({
        mayMint: async () => true,
        mintProject: async (o: { onSent?: (x: `0x${string}`) => void }) => (o.onSent?.(TX), Promise.reject(new TransactionTimeoutError(TX, "mint"))),
        recoverMint: async () => ({ state: "pending" }),
      });
      h.client = mockClient({
        planUpload: async () => ({ rootCid: "0x" + "cd".repeat(32), files: [], rootKind: "directory" }),
        upload: async () => ({ rootCid: "0x" + "cd".repeat(32), rootKind: "directory", txHashes: [] }),
        resolveOrg: async () => oc,
        forOrg: () => oc,
      });
      const e = (await uploadCommand()
        .parseAsync([...userArgs, "--name", "site", "--yes"], { from: "user" })
        .catch((x: Error) => x)) as PendingWriteError;
      expect(e).toBeInstanceOf(PendingWriteError);
      printed = formatCliError(e).at(-1)!.trim();
    } finally {
      vi.restoreAllMocks();
      process.chdir(saved.cwd);
      process.env = saved.env;
      RECOVERY_POLL.attempts = saved.attempts;
    }
    expect(printed).toMatch(/^abxfs upload mysite\.com\/build /);
    expect(printed).toContain("--allow-public config.example.org/x.env");
    const cmd = printed.replace("<id>", "1");

    // Part B: the real CLI. A config's defaults decide the root, so writing them out in the command matters.
    const run = (cfg: string, shellCmd: string) =>
      execFileSync("sh", ["-c", shellCmd], {
        env: { PATH: process.env["PATH"] ?? "", ABXFS_CONFIG: cfg, HOME: base },
        cwd: base,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const root = (out: string) => /root = (0x[0-9a-f]{64})/.exec(out)?.[1];
    const node = `${q(process.execPath)} ${q(CLI_DIST)}`;
    const original = root(run(cfgA, `${node} upload ${userArgs.map(q).join(" ")} --dry-run`));
    const replay = root(run(cfgB, `${cmd.replace(/^abxfs /, `${node} `)} --dry-run`));
    const plainB = root(run(cfgB, `${node} upload ${userArgs.map(q).join(" ")} --dry-run`));
    expect(original).toMatch(/^0x[0-9a-f]{64}$/);
    expect(replay).toBe(original);
    expect(plainB).not.toBe(original);
  }, 300_000);
});
