/**
 * Delta audit round 3 (CLI).
 *
 *   - I6: the command a pending mint's recovery prints went through `safe()`, which turns a Unicode space such as
 *     U+202F into a plain space and strips bidi characters, so a pasted command could name a different path. Every
 *     argument is now quoted with its exact characters (`shellArg`): what `safe()` would alter is written as `$'\xHH'`
 *     escapes a shell decodes back to the same bytes, so the printed line holds no raw control or bidi character and
 *     `safe()` leaves it unchanged. Round 4: each run of escapes has quotes of its own, because ksh93 reads `\x`
 *     greedily and took a hex digit after an escape into it (`my\u202Fab` became `my\uAFAB`).
 *   - Branches the round-2 fixes added that no test reached: `upload`'s refusal when the administered list was cut
 *     at its cap, the recovery command without `--name`, and `org create`'s "(gas: at most)" fallback (`scheduled:
 *     false`) when the node cannot estimate `createOrg`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionTimeoutError, type AbxfsCid } from "@artblocks/abxfs-sdk";

import type { WritePlan } from "../../src/write-plan.js";

const h = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  calls: [] as string[],
  plans: [] as unknown[],
  administered: { orgs: [] as unknown[], failed: [] as unknown[], failedGenerations: [] as unknown[], truncated: false },
}));
vi.mock("../../src/client.js", () => ({
  createClient: () => h.client,
  createOrgClient: async () => h.client,
}));
vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readOrgsAdministeredAcrossGenerations: async () => h.administered,
}));
vi.mock("../../src/write-plan.js", async (orig) => {
  const m = await orig<typeof import("../../src/write-plan.js")>();
  return { ...m, confirmWrite: async (...a: Parameters<typeof m.confirmWrite>) => (h.plans.push(a[1]), m.confirmWrite(...a)) };
});

import { mockClient } from "../helpers/mock-client.js";
import { orgCommand } from "../../src/commands/org.js";
import { recoveryCommand, uploadCommand } from "../../src/commands/upload.js";
import { PendingWriteError, RECOVERY_POLL } from "../../src/recover.js";
import { formatCliError } from "../../src/redact.js";
import { safe, shellArg } from "../../src/text.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const TX = ("0x" + "12".repeat(32)) as `0x${string}`;
const ROOT = ("0x" + "cd".repeat(32)) as AbxfsCid;
const saved = { ...process.env };
let out: string[] = [];

beforeEach(() => {
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_ORG"];
  RECOVERY_POLL.attempts = 1;
  h.calls.length = 0;
  h.plans.length = 0;
  h.administered = { orgs: [{ org: ORG, name: "Mine", roles: ["admin"], open: false, createdBlock: 1n }], failed: [], failedGenerations: [], truncated: false };
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** A client whose mint is sent and then times out (still pending), and that records every write. */
function setup(overrides: Record<string, unknown> = {}) {
  const oc = mockClient({
    mayMint: async () => true,
    mintProject: async (o: { onSent?: (x: `0x${string}`) => void }) => (
      h.calls.push("mintProject"), o.onSent?.(TX), Promise.reject(new TransactionTimeoutError(TX, "mint"))
    ),
    recoverMint: async () => ({ state: "pending" }),
  });
  h.client = mockClient({
    planUpload: async () => ({ rootCid: ROOT, files: [], rootKind: "directory" }),
    upload: async () => (h.calls.push("upload"), { rootCid: ROOT, rootKind: "directory", txHashes: [] }),
    createOrg: async () => (h.calls.push("createOrg"), Promise.reject(new Error("unexpected createOrg"))),
    resolveOrg: async () => oc,
    forOrg: () => oc,
    ...overrides,
  });
}

/** A directory to upload, at `<tmp>/<name>`. */
function site(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "abxfs-r3-")), name);
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  return dir;
}

/**
 * The words `shell` splits `line` into, each decoded as the shell decodes it: the shell runs node with them as its
 * arguments, and node prints its argv. Not `printf '%s\0'`: ksh93u+m (Ubuntu's ksh) reads that format differently from
 * ksh93u (macOS's) and printed every other word, so the check measured printf rather than the quoting.
 */
function shellWords(shell: string, line: string): string[] {
  const node = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
  const out = execFileSync(shell, ["-c", `${node} -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' ${line}`], { encoding: "utf8" });
  return JSON.parse(out) as string[];
}

/** Every shell the machine has that this module promises to: bash always, zsh and ksh where installed. */
const SHELLS = [
  "bash",
  ...["/bin/zsh", "/usr/bin/zsh"].filter((p) => existsSync(p)).slice(0, 1),
  ...["/bin/ksh", "/usr/bin/ksh"].filter((p) => existsSync(p)).slice(0, 1),
];

/** Strings a path, a glob, a tag or a name can hold, each awkward in its own way. */
const AWKWARD = [
  "plain",
  "my site",
  "it's",
  `a"b`,
  "back\\slash",
  "$HOME and `cmd` and *.html",
  "my\u202Fsite", // narrow no-break space: safe() made it a plain space
  "my\u00A0site", // no-break space
  "invoice\u202Etxt.exe", // right-to-left override: safe() stripped it
  "zero\u200Bwidth",
  "tab\there",
  "new\nline",
  "esc\u001b[31mred",
  "c1\u009bcsi",
  "del\u007f",
  "\uFEFFbom",
  "日本語のサイト",
  "emoji 🎨 site",
  "tag\u{e0041}char",
  "my\u202Fab", // an escape followed by hex digits: ksh93 read them into the escape
  "x\u200B1.html",
  "my\u00A0Cafe",
  "",
];

describe("I6: shellArg keeps an argument's exact characters, and never prints one safe() would alter", () => {
  it("bare when it can be, single-quoted when that suffices, $'…' with \\x escapes otherwise", () => {
    expect(shellArg("mysite.com/build")).toBe("mysite.com/build");
    expect(shellArg("my site")).toBe("'my site'");
    expect(shellArg("it's")).toBe(`'it'\\''s'`);
    expect(shellArg("日本語")).toBe("'日本語'");
    expect(shellArg("")).toBe("''");
    expect(shellArg("my\u202Fsite")).toBe("'my'$'\\xe2\\x80\\xaf''site'");
    expect(shellArg("invoice\u202Etxt.exe")).toBe("'invoice'$'\\xe2\\x80\\xae''txt.exe'");
    expect(shellArg("it's\u200B\\")).toBe("'it'\\''s'$'\\xe2\\x80\\x8b''\\'");
    expect(shellArg("tab\there")).toBe("'tab'$'\\x09''here'");
    // Each run of escapes in quotes of its own: nothing follows an escape inside them.
    expect(shellArg("my\u202Fab")).toBe("'my'$'\\xe2\\x80\\xaf''ab'");
    expect(shellArg("\u202E\u202E")).toBe("$'\\xe2\\x80\\xae\\xe2\\x80\\xae'");
  });

  it("the result holds no character safe() would change: printed through it, it is unchanged", () => {
    for (const s of AWKWARD) {
      const q = shellArg(s);
      expect(safe(q), JSON.stringify(s)).toBe(q);
      // Nothing that drives or reorders a terminal, raw.
      expect(q, JSON.stringify(s)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    }
  });

  // CI installs them (sdk-ci): a run there that silently skipped ksh would not test what b1b593e fixed.
  it.runIf(process.env["ABXFS_REQUIRE_SHELLS"] === "1")("every shell it promises is installed", () => {
    expect(SHELLS).toHaveLength(3);
  });

  for (const shell of SHELLS) {
    it(`${shell} decodes each back to its exact characters`, () => {
      for (const s of AWKWARD) expect(shellWords(shell, shellArg(s)), JSON.stringify(s)).toEqual([s]);
    });
  }
});

describe("I6: the printed recovery command names the same path when pasted", () => {
  const names = ["my\u202Fsite", "invoice\u202Etxt", "tab\there", "it's \u00A0 here"];
  /** A test title shows each character outside printable ASCII as its code point, never raw. */
  const visible = (s: string) => s.replace(/[^\x20-\x7e]/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`);
  for (const name of names) {
    it(`a folder named "${visible(name)}"`, async () => {
      setup();
      const dir = site(name);
      const e = (await uploadCommand()
        .parseAsync([dir, "--name", "My Site", "--tag", "v1", "--yes", "--chain", "base-sepolia"], { from: "user" })
        .catch((x: Error) => x)) as PendingWriteError;
      expect(e).toBeInstanceOf(PendingWriteError);
      const command = e.recoveryCommand!;
      // What formatCliError prints is exactly the command: safe() changes nothing in it.
      expect(formatCliError(e).at(-1)).toBe(`  ${command}`);
      for (const shell of SHELLS) {
        const argv = shellWords(shell, command.replace("<id>", "7"));
        expect(argv.slice(0, 3)).toEqual(["abxfs", "upload", dir]);
        expect(argv.slice(argv.indexOf("--name"), argv.indexOf("--name") + 2)).toEqual(["--name", "My Site"]);
        expect(argv).toContain("--project-id");
      }
      expect(h.calls).toEqual(["upload", "mintProject"]);
    });
  }
});

describe("recoveryCommand without --name (reached only from a test: a mint needs --name)", () => {
  const opts = { allowPublic: [] as string[] };
  const choices = { codec: "0x" + "00".repeat(32), fastLz: true, kind: "directory", maxBundleGas: undefined, root: ROOT } as Parameters<
    typeof recoveryCommand
  >[2];

  it("has no --name, and the same flags otherwise", () => {
    const r = recoveryCommand("site", opts, choices);
    expect(r.command(ORG, "<id>")).toBe(`abxfs upload site --org ${ORG} --project-id <id> --kind directory --codec none --fastlz`);
    expect(r.root).toBe(ROOT);
  });

  it("with one, the name is the last argument, quoted", () => {
    const r = recoveryCommand("site", { ...opts, name: "My Site", tag: "v1", chain: "base", includeHidden: true }, { ...choices, fastLz: false, maxBundleGas: 9_000_000 });
    expect(r.command(ORG, "3")).toBe(
      `abxfs upload site --chain base --org ${ORG} --project-id 3 --kind directory --codec none --no-fastlz --include-hidden --max-bundle-gas 9000000 --tag v1 --name 'My Site'`,
    );
  });
});

describe("upload refuses when the list of orgs it administers was cut at its cap", () => {
  it("names the cap, asks for --org, and creates, mints and uploads nothing", async () => {
    setup();
    h.administered = { ...h.administered, truncated: true };
    const dir = site("capped");
    await expect(uploadCommand().parseAsync([dir, "--name", "site", "--yes", "--chain", "base-sepolia"], { from: "user" })).rejects.toThrow(
      "you administer more orgs than one read returns (2,000 per factory), so the newest is not known; pass --org. Nothing was uploaded.",
    );
    expect(h.calls).toEqual([]);
    expect(h.plans).toEqual([]);
    expect(out.join("\n")).not.toMatch(/using the newest org you administer/);
  });

  it("with --org the cap does not matter", async () => {
    setup();
    h.administered = { ...h.administered, truncated: true };
    const dir = site("capped-org");
    const e = await uploadCommand()
      .parseAsync([dir, "--name", "site", "--org", ORG, "--yes", "--chain", "base-sepolia"], { from: "user" })
      .catch((x: Error) => x);
    expect(e).toBeInstanceOf(PendingWriteError); // it went on to upload and mint (the mock's mint then times out)
    expect(h.calls).toEqual(["upload", "mintProject"]);
  });
});

describe("org create when the node cannot estimate createOrg", () => {
  const create = () => orgCommand().parseAsync(["create", "Studio", "--chain", "base-sepolia", "--yes"], { from: "user" });
  const created = { org: ORG, firstTokenId: 0n, txHash: TX };

  it("shows the per-transaction cap as '(gas: at most)', not as the chain's schedule", async () => {
    h.client = mockClient({
      publicClient: { getBalance: async () => 10n ** 18n, estimateContractGas: async () => Promise.reject(new Error("execution reverted")) },
      createOrg: async () => (h.calls.push("createOrg"), created),
    });
    await create();
    const plan = h.plans[0] as WritePlan;
    expect(plan.steps).toEqual([{ what: "create the org and mint its first project to you (gas: at most)", txs: 1, gas: 2 ** 24, scheduled: false }]);
    expect(out.join("\n")).toMatch(/1 × create the org and mint its first project to you \(gas: at most\)\s+~16,777,216 gas/);
    expect(h.calls).toEqual(["createOrg"]);
  });

  it("and the node's own estimate when it gives one", async () => {
    h.client = mockClient({ createOrg: async () => (h.calls.push("createOrg"), created) });
    await create();
    const plan = h.plans[0] as WritePlan;
    expect(plan.steps).toEqual([{ what: "create the org and mint its first project to you", txs: 1, gas: 3_000_000, scheduled: true }]);
    expect(out.join("\n")).not.toMatch(/gas: at most/);
  });
});
