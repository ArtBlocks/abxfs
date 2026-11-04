/**
 * Delta audit L3 (ported from the auditor's PoC): the command `upload` prints after a mint (or an org creation) whose
 * receipt timed out must give the SAME root. It used to drop --codec, --no-fastlz, --include-hidden, every
 * --allow-public, --kind and --max-bundle-gas, so following it re-uploaded the folder under other choices and
 * published a different root into the minted project, permanently. It now carries every choice that decides the root,
 * resolved (a config default is written out), and prints the root it must publish.
 *
 * Delta audit round 2 (L2): the command was part of the error message, and every message goes through `redact()`,
 * which cuts a schemeless `host.tld/path` to `host.tld/<redacted>` (an RPC key usually lives in such a path). A folder
 * named `mysite.com/build`, or `--allow-public config.example.org/x.env`, printed as `<redacted>`: the printed command
 * no longer reproduced the upload. The command now rides on the error (`recoveryCommand`, as `explorerUrl` does) and
 * `formatCliError` prints it on a line of its own through `safe()` only.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionTimeoutError } from "@abxfs/sdk";

const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }));
vi.mock("../../src/client.js", () => ({
  createClient: () => h.client,
  createOrgClient: async () => h.client,
}));
vi.mock("@abxfs/sdk", async (orig) => ({
  ...(await orig<typeof import("@abxfs/sdk")>()),
  // The implicit org choice reads the factories' administered lists alone.
  readOrgsAdministeredAcrossGenerations: async () => ({
    orgs: h.client["administers"] ? [{ org: ORG, name: "Mine", roles: ["admin"], open: false, createdBlock: 1n }] : [],
    failed: [],
    failedGenerations: [],
  }),
}));

import { mockClient } from "../helpers/mock-client.js";
import { uploadCommand } from "../../src/commands/upload.js";
import { PendingWriteError, RECOVERY_POLL } from "../../src/recover.js";
import { formatCliError } from "../../src/redact.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const TX = ("0x" + "12".repeat(32)) as `0x${string}`;
const ROOT = "0x" + "cd".repeat(32);
const saved = { ...process.env };

beforeEach(() => {
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_ORG"];
  RECOVERY_POLL.attempts = 1;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

function setup(opts: { administers: boolean }) {
  const oc = mockClient({
    mayMint: async () => true,
    mintProject: async (o: { onSent?: (x: `0x${string}`) => void }) => (o.onSent?.(TX), Promise.reject(new TransactionTimeoutError(TX, "mint"))),
    recoverMint: async () => ({ state: "pending" }),
  });
  h.client = mockClient({
    administers: opts.administers,
    planUpload: async () => ({ rootCid: ROOT, files: [], rootKind: "directory" }),
    upload: async () => ({ rootCid: ROOT, rootKind: "directory", txHashes: [] }),
    createOrg: async (a: { onSent?: (x: `0x${string}`) => void }) => (a.onSent?.(TX), Promise.reject(new TransactionTimeoutError(TX, "createOrg"))),
    recoverCreateOrg: async () => ({ state: "pending" }),
    resolveOrg: async () => oc,
    forOrg: () => oc,
  });
}

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-recovery-"));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  writeFileSync(join(dir, ".nojekyll"), "");
  writeFileSync(join(dir, ".env.local"), "A=1\nB=2\nC=3\n");

  writeFileSync(join(dir, "my deploy.pem"), "not really a key");
  return dir;
}

const ROOT_FLAGS = [
  "--codec", "gzip", "--no-fastlz", "--include-hidden",
  "--allow-public", ".env.local", "--allow-public", "my deploy.pem",
  "--kind", "directory", "--max-bundle-gas", "9000000",
];

/**
 * The command the error carries, after checking that it is exactly what `formatCliError` prints on its own line, and
 * the root the message says it must publish, appended as the assertions below expect it.
 */
async function recoveryLine(args: string[]): Promise<string> {
  const e = (await uploadCommand()
    .parseAsync(args, { from: "user" })
    .catch((x: Error) => x)) as Error;
  expect(e).toBeInstanceOf(PendingWriteError);
  expect(e.message).toMatch(/Do NOT run the same command again/);
  const command = (e as PendingWriteError).recoveryCommand!;
  expect(command).toMatch(/^abxfs upload /);
  expect(formatCliError(e).at(-1)).toBe(`  ${command}`);
  const root = /It must publish root (0x[0-9a-f]{64})/.exec(e.message)?.[1];
  return `${command} (it must publish root ${root})`;
}

describe("the command printed after a mint timeout", () => {
  it("keeps every flag that decides the root, and names the root", async () => {
    setup({ administers: true });
    const dir = site();
    const printed = await recoveryLine([dir, "--name", "site", ...ROOT_FLAGS, "--yes", "--chain", "base-sepolia"]);
    expect(printed).toContain(`--org ${ORG} --project-id <id>`);
    expect(printed).toContain("--kind directory");
    expect(printed).toContain("--codec gzip");
    expect(printed).toContain("--no-fastlz");
    expect(printed).toContain("--include-hidden");
    expect(printed).toContain("--allow-public .env.local");
    expect(printed).toContain("--allow-public 'my deploy.pem'"); // shell-quoted
    expect(printed).toContain("--max-bundle-gas 9000000");
    expect(printed).toContain(`it must publish root ${ROOT}`);
    expect(printed).not.toMatch(/--yes/); // the user confirms the recovery
  });

  it("writes a config default out: a codec or FastLZ choice from the chain's config cannot change in between", async () => {
    setup({ administers: true });
    const cfg = join(mkdtempSync(join(tmpdir(), "abxfs-recovery-cfg-")), "config.json");
    writeFileSync(cfg, JSON.stringify({ chains: { "base-sepolia": { defaultCodec: "gzip", fastLz: false } } }));
    process.env["ABXFS_CONFIG"] = cfg;
    const dir = mkdtempSync(join(tmpdir(), "abxfs-recovery-"));
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    const printed = await recoveryLine([dir, "--name", "site", "--yes", "--chain", "base-sepolia"]);
    expect(printed).toContain("--kind directory --codec gzip --no-fastlz");
  });

  it("the default choices are written out too (`--codec none`, FastLZ on)", async () => {
    setup({ administers: true });
    const dir = mkdtempSync(join(tmpdir(), "abxfs-recovery-"));
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    const printed = await recoveryLine([dir, "--name", "site", "--yes", "--chain", "base-sepolia"]);
    expect(printed).toContain("--kind directory --codec none --fastlz --name site");
    expect(printed).not.toContain("--no-fastlz"); // and FastLZ is written out, so a config edited in between cannot turn it off
  });

  it("after a timed-out org creation, the same flags and the root, into the new org's first project", async () => {
    setup({ administers: false });
    const dir = site();
    const printed = await recoveryLine([dir, "--name", "site", ...ROOT_FLAGS, "--yes", "--chain", "base-sepolia"]);
    expect(printed).toContain("--org <the new org> --project-id 0");
    expect(printed).toContain("--codec gzip --no-fastlz --include-hidden --allow-public .env.local --allow-public 'my deploy.pem' --max-bundle-gas 9000000");
    expect(printed).toContain(`it must publish root ${ROOT}`);
  });
});

describe("a path or a glob shaped like host.tld/… survives (round 2, L2)", () => {
  /** `<tmp>/mysite.com/build`, holding a secret-looking `config.example.org/x.env` the upload must approve by name. */
  function hostShapedSite(): { base: string; dir: string } {
    const base = mkdtempSync(join(tmpdir(), "abxfs-recovery-host-"));
    const dir = join(base, "mysite.com", "build");
    mkdirSync(join(dir, "config.example.org"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, "config.example.org", "x.env"), "A=1\nB=2\nC=3\n");
    return { base, dir };
  }

  it("the printed command keeps `mysite.com/build` and `--allow-public config.example.org/x.env` whole", async () => {
    const { base, dir } = hostShapedSite();
    const cwd = process.cwd();
    process.chdir(base);
    try {
      for (const administers of [true, false]) {
        setup({ administers });
        const e = (await uploadCommand()
          .parseAsync(["mysite.com/build", "--name", "site", "--allow-public", "config.example.org/x.env", "--yes", "--chain", "base-sepolia"], {
            from: "user",
          })
          .catch((x: Error) => x)) as PendingWriteError;
        expect(e).toBeInstanceOf(PendingWriteError);
        const lines = formatCliError(e);
        const printed = lines.at(-1)!;
        expect(printed).toMatch(/^ {2}abxfs upload mysite\.com\/build --chain base-sepolia --org /);
        expect(printed).toContain("--allow-public config.example.org/x.env");
        expect(printed).not.toContain("<redacted>");
        // The message itself is still scrubbed as before: only the command line is printed as built.
        expect(lines[0]).not.toContain("abxfs upload");
      }
    } finally {
      process.chdir(cwd);
    }
    expect(dir).toContain("mysite.com");
  });

  it("before, the same command run through redact() lost both (what the separate line prevents)", () => {
    const command = "abxfs upload mysite.com/build --org 0xa1 --project-id <id> --allow-public config.example.org/x.env";
    expect(formatCliError(new Error(command))[0]).toBe(
      "abxfs upload mysite.com/<redacted> --org 0xa1 --project-id <id> --allow-public config.example.org/<redacted>",
    );
    expect(formatCliError(new PendingWriteError("pending.", command))).toEqual(["pending.", `  ${command}`]);
  });
});
