/**
 * The CLI commands against a stand-in client (the org layer cannot run on anvil), for the audit's behaviour changes
 * and the branches it found untested:
 *
 *   F5  implicit org selection follows only orgs the account ADMINISTERS;
 *   F6  every paid write previews its plan and confirms (TTY) or needs --yes (no TTY); --dry-run needs neither;
 *   F10 `read` asks the chain what a CID is, refuses `-o` on a directory, and `tag list` surfaces real errors;
 *   F11 a mint whose receipt times out is recovered from chain state, never sent twice;
 *   F13 the org is named in every pre-action and success line;
 *   F14 an empty account is refused before anything is signed;
 *   F19 `org open` warns about the cap;
 *   F21 numeric arguments are exact and errors name the flag;
 *   and pin / upload / update / tag / view / info / diff coverage.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodecNotSupportedOnChainError, ProjectKind, TransactionTimeoutError } from "@artblocks/abxfs-sdk";
import type { Hex } from "viem";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  client: {} as Record<string, unknown>,
  orgClient: {} as Record<string, unknown>,
  dirEntries: [] as Array<{ name: string; cid: string; isDirectory: boolean }>,
  pin: { pinned: undefined as string | undefined, preflight: [] as string[] },
  /**
   * The orgs the account is connected to, with roles, and those that failed. The implicit org choice reads the
   * administered ones (`readOrgsAdministeredAcrossGenerations`); the held ones only feed the note that they are unused.
   */
  myOrgs: { orgs: [] as Array<{ org: string; roles: string[]; [k: string]: unknown }>, failed: [] as string[] },
}));

vi.mock("../../src/client.js", () => ({
  createClient: () => h.client,
  createOrgClient: async () => h.orgClient,
}));
// `read` lists a directory through the SDK's readDirectory (which takes an entry cap).
vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readDirectory: async (_pc: unknown, _a: unknown, _cid: unknown, opts: { maxEntries?: number }) => {
    h.calls.push(`readDirectory:max=${opts.maxEntries}`);
    if (opts.maxEntries !== undefined && h.dirEntries.length > opts.maxEntries) throw new Error(`directory has ${h.dirEntries.length} entries, over ${opts.maxEntries}`);
    return { entries: h.dirEntries };
  },
  readOrgsAdministeredAcrossGenerations: async () => (
    h.calls.push("readMyOrgs"),
    { orgs: h.myOrgs.orgs.filter((o) => o.roles.includes("admin")), failed: h.myOrgs.failed, failedGenerations: [] }
  ),
  readOrgsHeld: async () => h.myOrgs.orgs.filter((o) => o.roles.includes("holder") && !o.roles.includes("admin")).map((o) => o.org),
}));
vi.mock("@artblocks/abxfs-pinning", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-pinning")>()),
  pinRoot: async ({ root, provider }: { root: string; provider: { name: string } }) => {
    h.calls.push(`pinRoot:${provider.name}:${root}`);
    return { pinnedCid: h.pin.pinned ?? PINNED, expectedCid: PINNED, verified: true, kind: "directory", files: [], blockCount: 3, carBytes: 100 };
  },
  localPinningProvider: () => ({ name: "local", preflight: async () => void h.pin.preflight.push("local"), pinCar: async () => ({}), unpin: async () => {}, isPinned: async () => true }),
}));

import { ACCOUNT, CONTENT_ADDRESSES, mockClient } from "../helpers/mock-client.js";
import { RECOVERY_POLL } from "../../src/recover.js";
import { formatCliError } from "../../src/redact.js";
import { OPEN_ORG_WARNING } from "../../src/commands/org.js";
import { orgCommand } from "../../src/commands/org.js";
import { uploadCommand } from "../../src/commands/upload.js";
import { updateCommand } from "../../src/commands/update.js";
import { tagCommand } from "../../src/commands/tag.js";
import { viewCommand } from "../../src/commands/view.js";
import { readCommand } from "../../src/commands/read.js";
import { infoCommand } from "../../src/commands/info.js";
import { diffCommand } from "../../src/commands/diff.js";
import { pinCommand } from "../../src/commands/pin.js";
import * as prompt from "../../src/prompt.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const OTHER_ORG = "0x00000000000000000000000000000000000000a7";
const ROOT = ("0x" + "cd".repeat(32)) as Hex;
const PINNED = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const TX = "0x" + "12".repeat(32);
const rec = (name: string, ret: unknown = TX) => async (...a: unknown[]) => (h.calls.push(`${name}${a.length ? ":" + a.map(String).join(",") : ""}`), ret);

let out: string[];
let err: string[];
const saved = { ...process.env };
beforeEach(() => {
  h.calls.length = 0;
  h.dirEntries = [];
  h.pin = { pinned: undefined, preflight: [] };
  out = [];
  err = [];
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_ORG"];
  delete process.env["PINATA_JWT"];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.map(String).join(" ")));
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  RECOVERY_POLL.attempts = 2;
  RECOVERY_POLL.delayMs = 1;
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const site = () => {
  const d = mkdtempSync(join(tmpdir(), "abxfs-cmd-"));
  writeFileSync(join(d, "index.html"), "<p>hi</p>");
  return d;
};
const printed = () => out.join("\n");
const sent = () => h.calls.filter((c) => /^(createOrg|mintProject|publishAndTag|setProjectName|setTag|removeTag|setViewUrl|setOpen|upload|uploadFile|update|transferAdmin|acceptAdmin)\b/.test(c));

/** An org client for the upload / project commands. */
function orgClient(extra: Record<string, unknown> = {}) {
  return mockClient({
    assertCanPublish: rec("assertCanPublish", undefined),
    mayMint: async () => true,
    mintProject: async (o?: { onSent?: (h: Hex) => void }) => (h.calls.push("mintProject"), o?.onSent?.(TX as Hex), { tokenId: 7n, txHash: TX }),
    recoverMint: rec("recoverMint", { state: "mined", org: ORG, tokenId: 7n }),
    publishAndTag: async (...a: unknown[]) => (h.calls.push(`publishAndTag:${String(a[0])}`), { publishTxHash: TX, versionNumber: 3n }),
    setProjectName: rec("setProjectName", TX),
    readTokenLinks: async (id: bigint) => ({ animationUrl: `https://gw.example/g/p/84532/${ORG}/${id}/latest/`, externalUrl: `https://gw.example/projects/84532/${ORG}/${id}` }),
    readProject: async () => ({ tokenId: 5n, collection: ORG, name: "proj", owner: ACCOUNT, kind: ProjectKind.Directory, cid: ROOT, versionCount: 2, preferredGateway: null, viewUrl: null }),
    update: async () => (h.calls.push("update"), { newRootCid: ROOT, txHash: TX, versionNumber: 3n }),
    setTag: rec("setTag"),
    removeTag: rec("removeTag"),
    setViewUrl: rec("setViewUrl"),
    setOpen: rec("setOpen"),
    readTag: async (_id: bigint, tag: string) => ({ tag, version: 2, cid: ROOT }),
    listTags: async () => ["stable"],
    projectVersions: async () => [{ version: 2, cid: ROOT, publishedAt: 1_700_000_000, publisher: ACCOUNT }],
    diff: async () => ({ entries: [{ path: "index.html", kind: "changed" }], changed: [{}], unchanged: [], emptyDirectoriesAdded: [], emptyDirectoriesRemoved: [], rootChanged: true, newRootCid: ROOT, oldRootCid: ROOT }),
    verifyOnChainIpfsCid: async () => PINNED,
    ...extra,
  });
}

/** The top-level client `upload` builds. */
function uploadClient(myOrgs: Array<{ org: string; roles: string[]; [k: string]: unknown }>, oc = orgClient(), extra: Record<string, unknown> = {}, failed: string[] = []) {
  h.myOrgs = { orgs: myOrgs, failed };
  return mockClient({
    registry: { ...CONTENT_ADDRESSES, projectEnumeration: "0x00000000000000000000000000000000000000e1" },
    createOrg: async (a: { name: string; onSent?: (h: Hex) => void }) => (h.calls.push(`createOrg:${a.name}`), a.onSent?.(TX as Hex), { org: "0x00000000000000000000000000000000000000b1", firstTokenId: 0n, txHash: TX }),
    recoverCreateOrg: rec("recoverCreateOrg", { state: "mined", org: "0x00000000000000000000000000000000000000b1", tokenId: 0n }),
    planUpload: async () => ({ rootCid: ROOT, files: [{ cid: ROOT, path: "index.html" }], rootKind: "directory" }),
    uploadFile: async (_f: unknown, o: { dryRun?: boolean }) => (o.dryRun ? undefined : h.calls.push("uploadFile"), { rootCid: ROOT, rootKind: "file", txHashes: [] }),
    upload: async () => (h.calls.push("upload"), { rootCid: ROOT, rootKind: "directory", txHashes: [TX] }),
    resolveOrg: async (o: string) => (h.calls.push(`resolveOrg:${o}`), oc),
    forOrg: () => oc,
    ...extra,
  });
}

const run = (cmd: { parseAsync: (a: string[], o: { from: "user" }) => Promise<unknown> }, args: string[]) =>
  cmd.parseAsync([...args, "--chain", "base-sepolia"], { from: "user" });

describe("F5: which org a minting upload goes into", () => {
  it("an account that only HOLDS projects in other orgs gets a personal org created, and is told why", async () => {
    h.client = uploadClient([{ org: OTHER_ORG, name: "Free Mints (official)", roles: ["holder"], open: true }]);
    await run(uploadCommand(), [site(), "--name", "my-art", "--yes"]);
    expect(h.calls).toContain(`createOrg:${ACCOUNT.slice(0, 6)}..${ACCOUNT.slice(-4)}`);
    expect(h.calls).not.toContain(`resolveOrg:${OTHER_ORG}`);
    expect(h.calls).not.toContain("mintProject"); // the new org's first project is the one published
    expect(printed()).toMatch(/you administer no org on this chain, so a personal org .* will be created.*You hold projects in 1 org\(s\) run by others; those are never used without --org/);
    expect(printed()).toMatch(/org:\s+a new personal org/);
  });

  it("the newest org the account administers is used, and named before anything is sent", async () => {
    h.client = uploadClient([
      { org: OTHER_ORG, name: "Theirs", roles: ["holder"], open: true },
      { org: ORG, name: "Mine", roles: ["admin", "holder"], open: false },
    ]);
    await run(uploadCommand(), [site(), "--name", "my-art", "--yes"]);
    expect(h.calls).toContain(`resolveOrg:${ORG}`);
    expect(h.calls).not.toContain(`resolveOrg:${OTHER_ORG}`);
    expect(printed()).toMatch(/using the newest org you administer, "Mine" 0x0+a1/);
    expect(printed()).toMatch(/org:\s+"Test Org" 0x0+a1/);
    expect(sent()).toEqual(["upload", "mintProject", "publishAndTag:7", `setProjectName:7,my-art`]);
    expect(printed()).toMatch(/version published to project #7 in org "Test Org" 0x0+a1 as v3/);
  });

  it("after publishing it prints each transaction's full hash, and where the project is, read from its token", async () => {
    h.client = uploadClient(
      [{ org: ORG, name: "Mine", roles: ["admin"], open: false }],
      orgClient({ publishAndTag: async () => ({ publishTxHash: TX, tagTxHash: TX, versionNumber: 3n }) }),
    );
    await run(uploadCommand(), [site(), "--name", "my-art", "--tag", "stable", "--yes"]);
    const p = printed();
    expect(p).toContain(`as v3 ${TX}`);
    expect(p).toMatch(new RegExp(`tag "stable" → v3 on project #7 .* ${TX}`));
    expect(p).toMatch(new RegExp(`name set: "my-art" on project #7 .* ${TX}`));
    expect(p).toMatch(/live at: https:\/\/gw\.example\/g\/p\/84532\/0x0+a1\/7\/latest\/ \(the token's animation_url\)/);
    expect(p).toMatch(/page: +https:\/\/gw\.example\/projects\/84532\/0x0+a1\/7 \(the token's external_url\)/);
  });

  it("a link that cannot be read is a note: the publish before it stands", async () => {
    h.client = uploadClient(
      [{ org: ORG, name: "Mine", roles: ["admin"], open: false }],
      orgClient({ readTokenLinks: async () => Promise.reject(new Error("HTTP request failed. URL: https://rpc.example/v2/SECRETKEY")) }),
    );
    await run(uploadCommand(), [site(), "--name", "my-art", "--yes"]);
    const p = printed();
    expect(p).toMatch(/version published to project #7/);
    expect(p).toMatch(/could not read the project's links: HTTP request failed/);
    expect(p).not.toContain("SECRETKEY");
  });

  it("an explicit org the account may not mint into is refused before anything is uploaded", async () => {
    h.client = uploadClient([], orgClient({ mayMint: async () => false }));
    await expect(run(uploadCommand(), [site(), "--name", "x", "--org", ORG, "--yes"])).rejects.toThrow(/may not mint into org .*Nothing was uploaded/);
    expect(sent()).toEqual([]);
  });
});

describe("F6: paid writes preview, then confirm or need --yes", () => {
  it("upload prints the chain, the org, the transactions, the gas, the max cost and what is permanent, then refuses without a TTY", async () => {
    h.client = uploadClient([{ org: ORG, name: "Mine", roles: ["admin"], open: false }]);
    await expect(run(uploadCommand(), [site(), "--name", "x"])).rejects.toThrow(/refusing to send up to \d+ transactions without a confirmation.*--yes/);
    const p = printed();
    expect(p).toMatch(/chain:\s+Base Sepolia \(chain 84532\)/);
    expect(p).toMatch(/org:\s+"Test Org" 0x0+a1/);
    expect(p).toMatch(/sends:\s+up to \d+ transactions, ~[\d,]+ gas estimated/);
    expect(p).toMatch(/max cost:\s+[\d.]+ ETH .*50 gwei fee ceiling/);
    expect(p).toMatch(/permanent:\s+the content: 1 file\(s\).*PUBLIC/);
    expect(sent()).toEqual([]);
  });

  it("--dry-run needs no --yes and sends nothing", async () => {
    h.client = uploadClient([]);
    await run(uploadCommand(), [site(), "--name", "x", "--dry-run"]);
    expect(printed()).toMatch(/dry-run: root =/);
    expect(sent()).toEqual([]);
  });

  it("a dry run with --name counts the project transactions the real run adds, not the content alone", async () => {
    h.client = uploadClient([]);
    await run(uploadCommand(), [site(), "--name", "x", "--tag", "stable", "--dry-run"]);
    const p = printed();
    expect(p).toMatch(/dry-run: then, to publish it as a project:/);
    expect(p).toMatch(/1 × create your personal org and mint its first project/);
    expect(p).toMatch(/or mint a new project token into your newest org\s+~[\d,]+ gas/);
    expect(p).toMatch(/1 × publish the root as the project's next version/);
    expect(p).toMatch(/1 × point tag "stable" at it/);
    expect(p).toMatch(/1 × set the project's name to "x"/);
    const content = Number(/up to (\d+) transaction\(s\), ~/.exec(p)![1]);
    expect(p).toMatch(new RegExp(`in all, up to ${content + 4} transaction\\(s\\)`));
    expect(sent()).toEqual([]);
  });

  it("a dry run into an existing project adds only the publish (and tag)", async () => {
    h.client = uploadClient([]);
    await run(uploadCommand(), [site(), "--project-id", "5", "--org", ORG, "--tag", "stable", "--dry-run"]);
    const p = printed();
    expect(p).not.toMatch(/create your personal org|mint a new project/);
    const content = Number(/up to (\d+) transaction\(s\), ~/.exec(p)![1]);
    expect(p).toMatch(new RegExp(`in all, up to ${content + 2} transaction\\(s\\)`));
  });

  it("a single-file dry run plans the file and sends nothing", async () => {
    h.client = uploadClient([]);
    const f = join(site(), "index.html");
    await run(uploadCommand(), [f, "--dry-run"]);
    expect(printed()).toMatch(/uploading single file index\.html/);
    expect(printed()).toMatch(/dry-run: root = 0x(cd){32} \(file\)/);
    expect(sent()).toEqual([]);
  });

  it("on a TTY, answering anything but yes sends nothing", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const ask = vi.spyOn(prompt, "confirmTyped").mockResolvedValue(false);
    h.orgClient = orgClient();
    for (const args of [["open", ORG], ["close", ORG], ["mint", ORG, "--to", "0x1111111111111111111111111111111111111111"]]) {
      await run(orgCommand(), args);
    }
    h.client = uploadClient([{ org: ORG, name: "Mine", roles: ["admin"], open: false }]);
    await run(uploadCommand(), [site(), "--name", "x"]);
    await run(tagCommand(), ["set", "5", "stable", "2", "--org", ORG]);
    await run(viewCommand(), ["https://example.com/", "--project-id", "5", "--org", ORG]);
    expect(ask).toHaveBeenCalledTimes(6);
    expect(sent()).toEqual([]);
    expect(printed().match(/aborted: nothing was sent/g)?.length).toBe(6);
  });

  it("an account with no ETH is refused before it is asked or anything is sent", async () => {
    h.orgClient = orgClient({ publicClient: { getBalance: async () => 0n } });
    await expect(run(orgCommand(), ["close", ORG, "--yes"])).rejects.toThrow(/account 0x0+a11ce has no ETH on Base Sepolia \(chain 84532\).*Nothing was sent/);
    expect(sent()).toEqual([]);
  });

  it.each([
    ["tag set", () => tagCommand(), ["set", "5", "stable", "2", "--org", ORG], "setTag:5,stable,2"],
    ["tag remove", () => tagCommand(), ["remove", "5", "stable", "--org", ORG], "removeTag:5,stable"],
    ["view", () => viewCommand(), ["https://example.com/", "--project-id", "5", "--org", ORG], "setViewUrl:5,https://example.com/"],
    ["view --clear", () => viewCommand(), ["--clear", "--project-id", "5", "--org", ORG], "setViewUrl:5,"],
    ["org open", () => orgCommand(), ["open", ORG], "setOpen:true"],
    ["org close", () => orgCommand(), ["close", ORG], "setOpen:false"],
    ["org mint --to", () => orgCommand(), ["mint", ORG, "--to", "0x1111111111111111111111111111111111111111"], "mintProject"],
  ])("%s: refused without a TTY or --yes; sent with --yes, naming the org", async (_n, make, args, call) => {
    h.orgClient = orgClient();
    await expect(run(make(), args)).rejects.toThrow(/--yes/);
    expect(sent()).toEqual([]);
    await run(make(), [...args, "--yes"]);
    expect(sent()).toEqual([call]);
    expect(printed()).toMatch(/org:\s+"Test Org" 0x0+a1/);
    expect(printed()).toMatch(/✓.*(in org|\(org) "Test Org" 0x0+a1/);
  });

  it("F19: org open warns that anyone can fill the org to its 1,000,000 cap, which never rises", async () => {
    h.orgClient = orgClient();
    await run(orgCommand(), ["open", ORG, "--yes"]);
    expect(printed()).toContain(OPEN_ORG_WARNING);
    expect(OPEN_ORG_WARNING).toMatch(/1,000,000-project cap by anyone, and the cap never rises/);
  });

  it("org mint --to says it gives the project away, in the plan", async () => {
    h.orgClient = orgClient();
    await run(orgCommand(), ["mint", ORG, "--to", "0x1111111111111111111111111111111111111111", "--yes"]);
    expect(printed()).toMatch(/permanent:\s+a new project token GIVEN to 0x1111111111111111111111111111111111111111/);
  });
});

describe("F11: a mint whose receipt timed out", () => {
  const timeout = () => new TransactionTimeoutError(TX as Hex, "mint", `https://sepolia.basescan.org/tx/${TX}`);

  it("is recovered from chain state and the upload carries on into the project it made", async () => {
    const oc = orgClient({
      mintProject: async (o: { onSent?: (h: Hex) => void }) => (h.calls.push("mintProject"), o.onSent?.(TX as Hex), Promise.reject(timeout())),
    });
    h.client = uploadClient([{ org: ORG, name: "Mine", roles: ["admin"], open: false }], oc);
    await run(uploadCommand(), [site(), "--name", "x", "--yes"]);
    expect(h.calls).toContain(`recoverMint:${TX},[object Object]`);
    expect(h.calls.filter((c) => c === "mintProject").length).toBe(1);
    expect(sent()).toContain("publishAndTag:7");
    expect(printed()).toMatch(/the mint confirmed late: project #7/);
  });

  it("still pending: stops with the explorer link and a command that publishes into it, never one that mints again", async () => {
    const oc = orgClient({
      mintProject: async (o: { onSent?: (h: Hex) => void }) => (o.onSent?.(TX as Hex), Promise.reject(timeout())),
      recoverMint: rec("recoverMint", { state: "pending" }),
    });
    h.client = uploadClient([{ org: ORG, name: "Mine", roles: ["admin"], open: false }], oc);
    const dir = site();
    const e = (await run(uploadCommand(), [dir, "--name", "x", "--tag", "v1", "--yes"]).catch((x: Error) => x)) as Error & { recoveryCommand?: string };
    expect(e.message).toMatch(/it is still pending.*Do NOT run the same command again/);
    expect(e.message).toContain(`the command below publishes the upload into it (put that id in place of <id>). It must publish root ${ROOT};`);
    // The command rides on the error and is printed on its own line, as built.
    expect(e.recoveryCommand).toBe(
      `abxfs upload ${dir} --chain base-sepolia --org ${ORG} --project-id <id> --kind directory --codec none --fastlz --tag v1 --name x`,
    );
    expect(formatCliError(e).at(-1)).toBe(`  ${e.recoveryCommand}`);
    expect(e.recoveryCommand).not.toMatch(/upload [^ ]+ --name/); // the printed command never mints
    expect(printed()).toContain(`explorer: https://sepolia.basescan.org/tx/${TX}`);
    expect(sent()).not.toContain("publishAndTag:7");
  });

  it("reverted: says nothing was minted and a re-run is safe", async () => {
    h.orgClient = orgClient({
      mintProject: async (o: { onSent?: (h: Hex) => void }) => (o.onSent?.(TX as Hex), Promise.reject(timeout())),
      recoverMint: rec("recoverMint", { state: "reverted" }),
    });
    await expect(run(orgCommand(), ["mint", ORG, "--yes"])).rejects.toThrow(/reverted on chain: nothing was minted, so running the same command again is safe/);
  });

  it("org create recovers the org it made", async () => {
    h.client = uploadClient([], orgClient(), {
      createOrg: async (a: { onSent?: (h: Hex) => void }) => (a.onSent?.(TX as Hex), Promise.reject(new TransactionTimeoutError(TX as Hex, "createOrg"))),
    });
    await run(orgCommand(), ["create", "Studio", "--yes"]);
    expect(h.calls).toContain(`recoverCreateOrg:${TX}`);
    expect(printed()).toMatch(/org: "Studio" 0x0+b1/);
  });
});

describe("F10: read", () => {
  const CID = "0x" + "aa".repeat(32);
  const readClient = (kind: number, extra: Record<string, unknown> = {}) =>
    mockClient({
      cidKind: async () => kind,
      readFile: async () => ({ bytes: new TextEncoder().encode("hello\n") }),
      resolvePath: async () => ({ cid: CID, isDirectory: false }),
      ...extra,
    });

  it("a failed integrity check on a FILE is reported as itself, not as a missing directory", async () => {
    h.client = readClient(ProjectKind.File, {
      readFile: async () => {
        throw new Error("output-hash verification failed for file 0xaa…: the RPC may be fabricating bytes");
      },
    });
    await expect(run(readCommand(), [CID])).rejects.toThrow(/output-hash/);
    expect(h.calls.some((c) => c.startsWith("readDirectory"))).toBe(false);
  });

  it("a CID that is neither is said to be so", async () => {
    h.client = readClient(ProjectKind.Unset);
    await expect(run(readCommand(), [CID])).rejects.toThrow(/neither a file nor a directory/);
  });

  it("-o on a directory is refused clearly, and nothing is written", async () => {
    h.client = readClient(ProjectKind.Directory);
    const outFile = join(mkdtempSync(join(tmpdir(), "abxfs-read-")), "site");
    await expect(run(readCommand(), [CID, "-o", outFile])).rejects.toThrow(/is a directory: -o\/--out writes one file's bytes/);
    expect(existsSync(outFile)).toBe(false);
    // and through --path to a directory
    h.client = readClient(ProjectKind.Directory, { resolvePath: async () => ({ cid: CID, isDirectory: true }) });
    await expect(run(readCommand(), [CID, "--path", "sub", "--output", outFile])).rejects.toThrow(/is a directory/);
  });

  it("--path to a file with --out writes it", async () => {
    h.client = readClient(ProjectKind.Directory);
    const outFile = join(mkdtempSync(join(tmpdir(), "abxfs-read-")), "nested", "index.html");
    await run(readCommand(), [CID, "--path", "index.html", "--out", outFile]);
    expect(readFileSync(outFile, "utf8")).toBe("hello\n");
  });

  it("lists a directory up to --max-entries (default 10,000), refusing a bigger one", async () => {
    h.client = readClient(ProjectKind.Directory);
    h.dirEntries = [{ name: "a", cid: CID, isDirectory: false }, { name: "b", cid: CID, isDirectory: true }];
    await run(readCommand(), [CID]);
    expect(h.calls).toContain("readDirectory:max=10000");
    expect(printed()).toMatch(/dir 0x(aa){32}/);
    await expect(run(readCommand(), [CID, "--max-entries", "1"])).rejects.toThrow(/over 1/);
    await expect(run(readCommand(), [CID, "--max-entries", "0"])).rejects.toThrow(/--max-entries must be a positive whole number/);
  });

  it("refuses binary or control bytes on a terminal, but not with --force", async () => {
    h.client = readClient(ProjectKind.File, { readFile: async () => ({ bytes: new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]) }) });
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(run(readCommand(), [CID])).rejects.toThrow(/refusing to write binary data/);
      await run(readCommand(), [CID, "--force"]);
      expect(write).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    }
  });
});

describe("F10: tag list", () => {
  it("surfaces a failed head read instead of reporting 'nothing published'", async () => {
    h.orgClient = orgClient({
      readTag: async () => {
        throw new Error("HTTP request failed: 503");
      },
    });
    await expect(run(tagCommand(), ["list", "5", "--org", ORG])).rejects.toThrow(/503/);
  });

  it("says nothing is published from the project itself, and lists tags", async () => {
    h.orgClient = orgClient({ readProject: async () => ({ versionCount: 0, cid: null }), listTags: async () => [] });
    await run(tagCommand(), ["list", "5", "--org", ORG]);
    expect(printed()).toMatch(/#5 \(nothing published yet\)/);
    h.orgClient = orgClient();
    await run(tagCommand(), ["list", "5", "--org", ORG]);
    expect(printed()).toMatch(/head: v2/);
    expect(printed()).toMatch(/stable → v2/);
    await run(tagCommand(), ["get", "5", "stable", "--org", ORG]);
    expect(printed()).toMatch(/tag "stable" → v2/);
  });
});

describe("F21: exact numbers, and errors that name the flag", () => {
  it.each([
    [() => tagCommand(), ["set", "5", "stable", "1.5", "--org", ORG], /<versionNumber> must be a positive whole number/],
    [() => tagCommand(), ["set", "5", "stable", "2abc", "--org", ORG], /<versionNumber>/],
    [() => tagCommand(), ["set", "5x", "stable", "2", "--org", ORG], /<projectId> must be a project id/],
    [() => tagCommand(), ["remove", "abc", "stable", "--org", ORG], /<projectId>/],
    [() => viewCommand(), ["--clear", "--project-id", "0x10", "--org", ORG], /--project-id must be a project id/],
    // the refusal names every one of the fifteen characters the on-chain renderer refuses
    [() => viewCommand(), ["https://example.com/?a&b", "--project-id", "5", "--org", ORG], /with none of " ' & \( \) < > \[ \\ \] \^ ` \{ \| \}/],
    [() => infoCommand(), ["--project-id", "", "--org", ORG], /--project-id/],
    [() => infoCommand(), ["--project-id", "3", "--org", ORG, "--max-versions", "abc"], /--max-versions must be a positive whole number/],
    [() => infoCommand(), ["--project-id", "3", "--org", ORG, "--max-versions", "-3"], /--max-versions/],
    [() => infoCommand(), ["--project-id", "3", "--org", ORG, "--max-versions", "0"], /--max-versions/],
    [() => diffCommand(), [".", "--project-id", "1e3", "--org", ORG], /--project-id/],
    [() => pinCommand(), ["--project-id", "1", "--project-version", "0", "--org", ORG], /--project-version must be a positive whole number/],
    [() => pinCommand(), ["--project-version", "2"], /--project-version needs --project-id/],
    [() => updateCommand(), [".", "--project-id", "1", "--org", ORG, "--max-bundle-gas", "12,000,000"], /--max-bundle-gas must be a positive whole number/],
  ])("%#", async (make, args, re) => {
    h.orgClient = orgClient();
    await expect(run(make(), args)).rejects.toThrow(re);
    expect(sent()).toEqual([]);
  });

  it("info: the default window is 200 versions, and the help says so", async () => {
    let window: unknown;
    h.orgClient = orgClient({ projectVersions: async (_id: bigint, o: unknown) => ((window = o), []) , readProject: async () => ({ tokenId: 3n, collection: ORG, name: "p", owner: ACCOUNT, kind: 1, cid: ROOT, versionCount: 500, preferredGateway: null, viewUrl: null }) });
    await run(infoCommand(), ["--project-id", "3", "--org", ORG]);
    expect(window).toEqual({ start: 300, end: 500, limit: 200 });
    expect(printed()).toMatch(/omitted 300 older versions/);
    expect(infoCommand().helpInformation()).toMatch(/default 200/);
  });
});

describe("upload / update branches", () => {
  it("--kind is checked before any work", async () => {
    h.client = uploadClient([]);
    await expect(run(uploadCommand(), [site(), "--kind", "folder"])).rejects.toThrow(/--kind must be one of: file, directory, auto/);
    await expect(run(uploadCommand(), [site(), "--kind", "file", "--dry-run"])).rejects.toThrow(/--kind=file but local path .* is a directory/);
    const f = join(site(), "index.html");
    await expect(run(uploadCommand(), [f, "--kind", "directory", "--dry-run"])).rejects.toThrow(/is a file/);
  });

  it("upload --project-id publishes into the project after checking it may, naming the org", async () => {
    const oc = orgClient();
    h.orgClient = oc;
    h.client = uploadClient([], oc);
    await run(uploadCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"]);
    expect(h.calls.indexOf("assertCanPublish:5")).toBeLessThan(h.calls.indexOf("upload"));
    expect(printed()).toMatch(/publish it to project #5/);
    expect(printed()).toMatch(/version published to project #5 in org "Test Org" 0x0+a1 as v3/);
  });

  it("update refuses a kind mismatch before uploading", async () => {
    h.orgClient = orgClient({ readProject: async () => ({ name: "p", kind: ProjectKind.File, cid: ROOT, versionCount: 1 }) });
    await expect(run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"])).rejects.toThrow(/is file-kind but local path .* is a directory/);
    expect(sent()).toEqual([]);
  });

  it("update refuses on a chain with no project hook", async () => {
    h.orgClient = orgClient({ addresses: { ...(orgClient().addresses as object), projectHook: undefined } });
    await expect(run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"])).rejects.toThrow(/has no projectHook configured/);
  });

  it("update refuses a project with nothing published", async () => {
    h.orgClient = orgClient({ readProject: async () => ({ name: "p", kind: ProjectKind.Unset, cid: null, versionCount: 0 }) });
    await expect(run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"])).rejects.toThrow(/has not published anything yet/);
  });

  it("update previews, then publishes, naming the org", async () => {
    h.orgClient = orgClient();
    await run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--tag", "stable", "--yes"]);
    expect(sent()).toEqual(["update"]);
    expect(printed()).toMatch(/updating directory project #5 \("proj"\) in org "Test Org" 0x0+a1/);
    expect(printed()).toMatch(/new version: v3 of project #5 in org "Test Org"/);
    expect(printed()).toMatch(/tag "stable" → v3 on project #5 in org "Test Org"/);
  });
});

describe("info and diff", () => {
  it("info prints the project, its links, versions and tags", async () => {
    h.orgClient = orgClient({
      readProject: async () => ({ tokenId: 5n, collection: ORG, name: "p\u001b[2J", owner: ACCOUNT, kind: 1, cid: ROOT, versionCount: 1, preferredGateway: "http://localhost/x", viewUrl: "https://ok.example/" }),
    });
    await run(infoCommand(), ["--project-id", "5", "--org", ORG]);
    const p = printed();
    expect(p).not.toContain("\u001b[2J");
    expect(p).toMatch(/gateway: .*ignored/);
    expect(p).toMatch(/view: .*https:\/\/ok\.example\//);
    expect(p).toMatch(/live at: +https:\/\/gw\.example\/g\/p\/84532\/0x0+a1\/5\/latest\//);
    expect(p).not.toMatch(/✓ live at/);
    expect(p).toMatch(/stable → v2/);
  });

  it("diff prints each path with its change", async () => {
    h.orgClient = orgClient();
    await run(diffCommand(), [site(), "--project-id", "5", "--org", ORG]);
    expect(printed()).toMatch(/~ index\.html/);
    expect(printed()).toMatch(/1 changed \/ 0 unchanged/);
  });
});

describe("pin", () => {
  it("--project-id pins the current version, after checking the provider", async () => {
    h.orgClient = orgClient({ addresses: { ...(orgClient().addresses as object), ipfsCidResolver: "0x00000000000000000000000000000000000000c9" } });
    await run(pinCommand(), ["--project-id", "5", "--org", ORG, "--provider", "local"]);
    expect(h.pin.preflight).toEqual(["local"]);
    expect(h.calls).toContain(`pinRoot:local:${ROOT}`);
    expect(printed()).toMatch(/on-chain CID matches pinned root/);
  });

  it("--project-version pins that version", async () => {
    h.orgClient = orgClient({ projectVersions: async () => [{ version: 1, cid: "0x" + "ee".repeat(32) }] });
    await run(pinCommand(), ["--project-id", "5", "--project-version", "1", "--org", ORG, "--no-verify"]);
    expect(h.calls).toContain(`pinRoot:local:0x${"ee".repeat(32)}`);
    await expect(run(pinCommand(), ["--project-id", "5", "--project-version", "3", "--org", ORG])).rejects.toThrow(/--project-version 3 is out of range \(project #5 has 2 versions\)/);
  });

  it("Pinata without a key is refused before anything is read from chain", async () => {
    h.orgClient = orgClient({ readProject: async () => (h.calls.push("readProject"), {}) });
    await expect(run(pinCommand(), ["--project-id", "5", "--org", ORG, "--provider", "pinata"])).rejects.toThrow(/an API key is required for the pinata provider/);
    expect(h.calls).toEqual([]);
  });

  it("--no-verify skips the on-chain comparison", async () => {
    h.orgClient = orgClient({ verifyOnChainIpfsCid: async () => (h.calls.push("verifyOnChain"), PINNED) });
    await run(pinCommand(), ["--project-id", "5", "--org", ORG, "--no-verify"]);
    expect(h.calls).not.toContain("verifyOnChain");
  });

  it("a mismatch with the on-chain CID fails", async () => {
    h.orgClient = orgClient({ addresses: { ...(orgClient().addresses as object), ipfsCidResolver: "0x00000000000000000000000000000000000000c9" }, verifyOnChainIpfsCid: async () => "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" });
    await expect(run(pinCommand(), ["--project-id", "5", "--org", ORG])).rejects.toThrow(/on-chain IPFS CID \(bafkrei[a-z2-7]+\) differs from pinned root/);
  });

  it("a codec file the resolver cannot derive is reported as derived from chain", async () => {
    h.orgClient = orgClient({
      addresses: { ...(orgClient().addresses as object), ipfsCidResolver: "0x00000000000000000000000000000000000000c9" },
      verifyOnChainIpfsCid: async () => {
        throw new CodecNotSupportedOnChainError(ROOT as never, "0x67" as Hex);
      },
    });
    await run(pinCommand(), ["--project-id", "5", "--org", ORG]);
    expect(printed()).toMatch(/root derived from chain.*cannot derive this one/);
  });
});
