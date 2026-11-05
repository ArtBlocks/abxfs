/**
 * The delta audit's CLI command findings, against a stand-in client (the org layer cannot run on anvil):
 *
 *   - `transfer` refuses every factory generation's contracts as the new owner, not only the current hook;
 *   - `pin --project-id` checks the provider before it reads anything from chain (the org's factory included);
 *   - the plan says an OP-stack L2's L1 data fee is not in the max cost;
 *   - `upload` / `update` / `diff` take a chain's `fastLz: false` when no flag is given;
 *
 * and the declined, empty and error paths of the commands it listed as untested.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectKind } from "@artblocks/abxfs-sdk";
import type { Hex } from "viem";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  client: {} as Record<string, unknown>,
  orgClient: {} as Record<string, unknown>,
  myOrgs: { orgs: [] as unknown[], failed: [] as string[] },
}));

vi.mock("../../src/client.js", () => ({
  createClient: () => (h.calls.push("createClient"), h.client),
  createOrgClient: async () => (h.calls.push("createOrgClient"), h.orgClient),
}));
vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readOrgsAdministeredAcrossGenerations: async () => ({ ...h.myOrgs, failedGenerations: [] }),
}));
vi.mock("@artblocks/abxfs-pinning", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-pinning")>()),
  localPinningProvider: () => ({
    name: "local",
    preflight: async () => void h.calls.push("preflight"),
    pinCar: async () => ({}),
    unpin: async () => {},
    isPinned: async () => true,
  }),
  deriveCar: async () => {
    h.calls.push("deriveCar");
    throw new Error("the chain could not be read");
  },
}));

import { ACCOUNT, CONTENT_ADDRESSES, mockClient } from "../helpers/mock-client.js";
import { orgCommand } from "../../src/commands/org.js";
import { collectAllowPublic, uploadCommand } from "../../src/commands/upload.js";
import { updateCommand } from "../../src/commands/update.js";
import { tagCommand } from "../../src/commands/tag.js";
import { viewCommand } from "../../src/commands/view.js";
import { diffCommand } from "../../src/commands/diff.js";
import { pinCommand, resolveApiKey } from "../../src/commands/pin.js";
import { protocolAddresses, transferCommand } from "../../src/commands/transfer.js";
import { describeWritePlan } from "../../src/write-plan.js";
import * as prompt from "../../src/prompt.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const ROOT = ("0x" + "cd".repeat(32)) as Hex;
const TX = "0x" + "12".repeat(32);
const OLD_HOOK = "0x00000000000000000000000000000000000001d1";
const OLD_ENUM = "0x00000000000000000000000000000000000001d2";
const OLD_FACTORY = "0x00000000000000000000000000000000000001d3";
const rec = (name: string, ret: unknown = TX) => async (...a: unknown[]) => (h.calls.push(`${name}${a.length ? ":" + a.map(String).join(",") : ""}`), ret);

let out: string[];
const saved = { ...process.env };
beforeEach(() => {
  h.calls.length = 0;
  h.myOrgs = { orgs: [], failed: [] };
  out = [];
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_ORG"];
  delete process.env["PINATA_JWT"];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const printed = () => out.join("\n");
const sent = () =>
  h.calls.filter((c) => /^(createOrg|mintProject|publishAndTag|setProjectName|setTag|removeTag|setViewUrl|setOpen|upload|uploadFile|update|transferAdmin|acceptAdmin|transferProject)\b/.test(c));
const run = (cmd: { parseAsync: (a: string[], o: { from: "user" }) => Promise<unknown> }, args: string[]) =>
  cmd.parseAsync([...args, "--chain", "base-sepolia"], { from: "user" });
const site = () => {
  const d = mkdtempSync(join(tmpdir(), "abxfs-delta-"));
  writeFileSync(join(d, "index.html"), "<p>hi</p>");
  return d;
};
/** Answer the typed confirmation with `answer` on a terminal. */
const onTty = (answer: boolean) => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  return vi.spyOn(prompt, "confirmTyped").mockResolvedValue(answer);
};

function orgClient(extra: Record<string, unknown> = {}) {
  return mockClient({
    assertCanPublish: rec("assertCanPublish", undefined),
    mayMint: async () => true,
    readProject: async () => ({ tokenId: 5n, collection: ORG, name: "proj", owner: ACCOUNT, kind: ProjectKind.Directory, cid: ROOT, versionCount: 2, preferredGateway: null, viewUrl: null }),
    update: async (a: { opts: { fastLz: boolean; maxBundleGas?: number; onBundleSent?: (i: unknown) => void } }) => {
      h.calls.push(`update:fastLz=${a.opts.fastLz}:gas=${a.opts.maxBundleGas}`);
      a.opts.onBundleSent?.({ callCount: 1, estimatedGas: 500_000, txHash: TX, target: ORG });
      return { newRootCid: ROOT, txHash: TX, versionNumber: 3n };
    },
    removeTag: rec("removeTag"),
    setViewUrl: rec("setViewUrl"),
    acceptAdmin: rec("acceptAdmin"),
    publishAndTag: async (id: bigint) => (h.calls.push(`publishAndTag:${id}`), { publishTxHash: TX, versionNumber: 1n }),
    setProjectName: rec("setProjectName"),
    transferProject: rec("transferProject"),
    projectVersions: async () => [],
    diff: async (_root: unknown, _files: unknown, o: { fastLz: boolean }) => (
      h.calls.push(`diff:fastLz=${o.fastLz}`),
      { entries: [], changed: [], unchanged: [{}], emptyDirectoriesAdded: [], emptyDirectoriesRemoved: [], rootChanged: false, newRootCid: ROOT, oldRootCid: ROOT }
    ),
    ...extra,
  });
}

function uploadClient(extra: Record<string, unknown> = {}) {
  const oc = orgClient();
  return mockClient({
    createOrg: async (a: { name: string; salt?: string }) => (h.calls.push(`createOrg:${a.name}:${a.salt ?? "-"}`), { org: ORG, firstTokenId: 0n, txHash: TX }),
    planUpload: async () => ({ rootCid: ROOT, files: [], rootKind: "directory" }),
    upload: async (_f: unknown, o: { fastLz: boolean }) => (h.calls.push(`upload:fastLz=${o.fastLz}`), { rootCid: ROOT, rootKind: "directory", txHashes: [] }),
    resolveOrg: async () => oc,
    forOrg: () => oc,
    ...extra,
  });
}

describe("transfer: the new owner is never a protocol contract of any generation", () => {
  const book = {
    ...CONTENT_ADDRESSES,
    projectEnumeration: "0x00000000000000000000000000000000000000e1",
    previousGenerations: [{ orgFactory: OLD_FACTORY, projectHook: OLD_HOOK, projectEnumeration: OLD_ENUM }],
  };

  it("protocolAddresses lists the content layer, the current org layer and every earlier generation", () => {
    const all = protocolAddresses(book as never);
    for (const x of [CONTENT_ADDRESSES.chunkStore, CONTENT_ADDRESSES.projectHook, CONTENT_ADDRESSES.orgFactory, book.projectEnumeration, OLD_HOOK, OLD_ENUM, OLD_FACTORY]) {
      expect(all).toContain(x);
    }
    expect(protocolAddresses(undefined)).toEqual([]);
  });

  it.each([
    ["an earlier generation's hook", OLD_HOOK],
    ["an earlier generation's enumeration hook", OLD_ENUM],
    ["the current hook", CONTENT_ADDRESSES.projectHook],
    ["a content store", CONTENT_ADDRESSES.fileStore],
  ])("refuses %s, before anything is read", async (_what, to) => {
    const cfg = join(mkdtempSync(join(tmpdir(), "abxfs-delta-cfg-")), "config.json");
    writeFileSync(cfg, JSON.stringify({ chains: { local: { chainId: 31337, rpcUrl: "http://127.0.0.1:9", addresses: book } } }));
    process.env["ABXFS_CONFIG"] = cfg;
    h.orgClient = orgClient();
    await expect(transferCommand().parseAsync(["5", to, "--org", ORG, "--chain", "local", "--yes"], { from: "user" })).rejects.toThrow(
      /invalid new owner .*would lock it/,
    );
    expect(h.calls).toEqual([]);
  });

  it("declined on a terminal: nothing is sent", async () => {
    const ask = onTty(false);
    h.orgClient = orgClient();
    await run(transferCommand(), ["5", "0x1111111111111111111111111111111111111111", "--org", ORG]);
    expect(ask).toHaveBeenCalledOnce();
    expect(sent()).toEqual([]);
    expect(printed()).toMatch(/aborted: nothing was sent/);
  });

  it("sent with --yes", async () => {
    h.orgClient = orgClient();
    await run(transferCommand(), ["5", "0x1111111111111111111111111111111111111111", "--org", ORG, "--yes"]);
    expect(sent()).toEqual(["transferProject:5,0x1111111111111111111111111111111111111111"]);
  });
});

describe("pin --project-id: the provider is checked before anything is read from chain", () => {
  it("the preflight runs before the org's client (and its factory read) exists", async () => {
    h.orgClient = orgClient({ readProject: async () => (h.calls.push("readProject"), { cid: ROOT, versionCount: 1 }) });
    await run(pinCommand(), ["--project-id", "5", "--org", ORG, "--no-verify"]).catch(() => undefined);
    expect(h.calls.slice(0, 3)).toEqual(["preflight", "createOrgClient", "readProject"]);
  });
});

describe("pin: the remaining refusals and the --car cleanup", () => {
  it("an unknown provider is refused before anything is read", async () => {
    await expect(run(pinCommand(), ["--cid", ROOT, "--provider", "ipfs-cluster"])).rejects.toThrow(/unknown provider "ipfs-cluster": use local or pinata, or --car <path>/);
    expect(h.calls).toEqual([]);
  });

  it("a key with an --endpoint that is not a URL, or plaintext to another host, is refused", () => {
    process.env["PINATA_JWT"] = "jwt-value-123";
    expect(() => resolveApiKey({ provider: "pinata", endpoint: "not a url" })).toThrow(/--endpoint is not a valid URL/);
    expect(() => resolveApiKey({ provider: "pinata", endpoint: "http://pin.example/" })).toThrow(/refusing to send an API key to http:\/\/pin\.example.*only allowed for localhost/);
    expect(resolveApiKey({ provider: "pinata", endpoint: "http://127.0.0.1:3000/" })).toBe("jwt-value-123");
    expect(resolveApiKey({ provider: "pinata", endpoint: "https://pin.example/" })).toBe("jwt-value-123");
  });

  it("--project-version past the project's history is refused, and a missing record is said to be missing", async () => {
    h.orgClient = orgClient();
    await expect(run(pinCommand(), ["--project-id", "5", "--project-version", "9", "--org", ORG])).rejects.toThrow(/--project-version 9 is out of range \(project #5 has 2 versions\)/);
    h.orgClient = orgClient({ projectVersions: async () => [] });
    await expect(run(pinCommand(), ["--project-id", "5", "--project-version", "2", "--org", ORG])).rejects.toThrow(/version 2 not found for project #5/);
  });

  it("a project with nothing published has nothing to pin", async () => {
    h.orgClient = orgClient({ readProject: async () => ({ cid: null, versionCount: 0 }) });
    await expect(run(pinCommand(), ["--project-id", "5", "--org", ORG])).rejects.toThrow(/has not published anything yet — nothing to pin/);
  });

  it("neither --cid nor --project-id", async () => {
    h.client = orgClient();
    await expect(run(pinCommand(), [])).rejects.toThrow(/provide --cid or --project-id/);
  });

  it("--car: a run that fails part way removes the file it created; an existing file is never overwritten", async () => {
    h.client = orgClient();
    const dir = mkdtempSync(join(tmpdir(), "abxfs-car-"));
    const car = join(dir, "out.car");
    await expect(run(pinCommand(), ["--cid", ROOT, "--car", car])).rejects.toThrow(/the chain could not be read/);
    expect(h.calls).toContain("deriveCar");
    expect(existsSync(car)).toBe(false);

    writeFileSync(car, "mine");
    await expect(run(pinCommand(), ["--cid", ROOT, "--car", car])).rejects.toThrow(/EEXIST/);
    expect(existsSync(car)).toBe(true);
  });

  it("--project-id with --car: a failed org read removes the file too (the client is made after the file is opened)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abxfs-car-"));
    const car = join(dir, "out.car");
    h.orgClient = orgClient({ readProject: async () => Promise.reject(new Error("not an org")) });
    await expect(run(pinCommand(), ["--project-id", "5", "--org", ORG, "--car", car])).rejects.toThrow(/not an org/);
    expect(existsSync(car)).toBe(false);
  });
});

describe("the plan names what the max cost leaves out", () => {
  it("an OP-stack L2 (Base Sepolia): the L1 data fee is not included", () => {
    const lines = describeWritePlan({ action: "x", chainId: 84532, steps: [{ what: "y", txs: 1, gas: 100_000 }], permanent: [] }).join("\n");
    expect(lines).toMatch(/not included: this chain's L1 data fee/);
  });

  it("Ethereum and a local chain: no such line", () => {
    for (const chainId of [1, 31337]) {
      const lines = describeWritePlan({ action: "x", chainId, steps: [{ what: "y", txs: 1, gas: 100_000 }], permanent: [] }).join("\n");
      expect(lines, String(chainId)).not.toMatch(/L1 data fee|L1 component/);
    }
  });

  it("Arbitrum One and Arbitrum Sepolia (round 2): the L1 component, which Arbitrum charges as extra gas, is not included", () => {
    for (const chainId of [42161, 421614]) {
      const lines = describeWritePlan({ action: "x", chainId, steps: [{ what: "y", txs: 1, gas: 100_000 }], permanent: [] }).join("\n");
      expect(lines, String(chainId)).toMatch(/not included: this chain's L1 component, charged as extra gas on each transaction for its calldata/);
      expect(lines, String(chainId)).not.toMatch(/L1 data fee/);
    }
  });

  it("an EIP-8037 chain (Sepolia): the legacy-priced project and org figures are said to be so; content figures are not", () => {
    const plan = (steps: Array<{ what: string; txs: number; gas: number; scheduled?: boolean }>) =>
      describeWritePlan({ action: "x", chainId: 11155111, steps, permanent: [] }).join("\n");
    const note = /the project and org figures are legacy-priced: under EIP-8037 \(this chain\) state costs more, so a long name or view costs more than shown/;
    expect(plan([{ what: "store the content", txs: 3, gas: 30_000_000, scheduled: true }, { what: "set abxfs.view", txs: 1, gas: 400_000 }])).toMatch(note);
    expect(plan([{ what: "store the content", txs: 3, gas: 30_000_000, scheduled: true }])).not.toMatch(note);
    // A legacy chain: no note, whatever the steps.
    const base = describeWritePlan({ action: "x", chainId: 84532, steps: [{ what: "set abxfs.view", txs: 1, gas: 400_000 }], permanent: [] }).join("\n");
    expect(base).not.toMatch(/legacy-priced/);
  });
});

describe("a chain's fastLz: false applies when no flag is given (a lone --no-fastlz defaulted the flag to true)", () => {
  const cfg = () => {
    const p = join(mkdtempSync(join(tmpdir(), "abxfs-delta-cfg-")), "config.json");
    writeFileSync(p, JSON.stringify({ chains: { "base-sepolia": { fastLz: false } } }));
    process.env["ABXFS_CONFIG"] = p;
  };

  it("upload", async () => {
    cfg();
    h.client = uploadClient();
    await run(uploadCommand(), [site(), "--yes"]);
    expect(h.calls).toContain("upload:fastLz=false");
    h.calls.length = 0;
    await run(uploadCommand(), [site(), "--fastlz", "--yes"]);
    expect(h.calls).toContain("upload:fastLz=true");
  });

  it("update", async () => {
    cfg();
    h.orgClient = orgClient();
    await run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"]);
    expect(h.calls).toContain("update:fastLz=false:gas=undefined");
  });

  it("diff", async () => {
    cfg();
    h.orgClient = orgClient();
    await run(diffCommand(), [site(), "--project-id", "5", "--org", ORG]);
    expect(h.calls).toContain("diff:fastLz=false");
    expect(printed()).toMatch(/\(root unchanged\)/);
  });
});

describe("declined, empty and error paths", () => {
  it("upload: a folder with nothing to upload is refused", async () => {
    h.client = uploadClient();
    const empty = mkdtempSync(join(tmpdir(), "abxfs-empty-"));
    writeFileSync(join(empty, ".hidden"), "x");
    await expect(run(uploadCommand(), [empty, "--dry-run"])).rejects.toThrow(/nothing to upload in/);
  });

  it("upload: minting needs an account", async () => {
    h.client = uploadClient({ walletClient: undefined });
    await expect(run(uploadCommand(), [site(), "--name", "x", "--yes"])).rejects.toThrow(/no account to mint with — set ABXFS_PRIVATE_KEY/);
    expect(sent()).toEqual([]);
  });

  it("upload: creating the personal org says 'at most' when the node cannot estimate it", async () => {
    h.client = uploadClient({ publicClient: { getBalance: async () => 10n ** 18n, estimateContractGas: async () => Promise.reject(new Error("execution reverted")) } });
    await run(uploadCommand(), [site(), "--name", "x", "--yes"]);
    expect(printed()).toMatch(/create your personal org and mint its first project to you \(gas: at most\)\s+~16,777,216 gas/);
  });

  it("upload: content only (no --name or --project-id) stores and stops", async () => {
    h.client = uploadClient();
    await run(uploadCommand(), [site(), "--yes"]);
    expect(printed()).toMatch(/content only: no project/);
    expect(printed()).toMatch(/no --name or --project-id — content is stored and addressable by CID/);
  });

  it("update: declined on a terminal sends nothing; a folder with nothing in it is refused", async () => {
    onTty(false);
    h.orgClient = orgClient();
    await run(updateCommand(), [site(), "--project-id", "5", "--org", ORG]);
    expect(sent()).toEqual([]);
    expect(printed()).toMatch(/aborted: nothing was sent/);
    const empty = mkdtempSync(join(tmpdir(), "abxfs-empty-"));
    await expect(run(updateCommand(), [empty, "--project-id", "5", "--org", ORG, "--yes"])).rejects.toThrow(/nothing to upload in/);
  });

  it("update: a file project takes a single file, with --max-bundle-gas", async () => {
    h.orgClient = orgClient({ readProject: async () => ({ name: "f", kind: ProjectKind.File, cid: ROOT, versionCount: 1 }) });
    const f = join(site(), "index.html");
    await run(updateCommand(), [f, "--project-id", "5", "--org", ORG, "--max-bundle-gas", "9000000", "--yes"]);
    expect(h.calls).toContain("update:fastLz=true:gas=9000000");
  });

  it("org accept-admin: previews the warning and what becomes permanent, then accepts", async () => {
    const admin = "0x00000000000000000000000000000000000000ad";
    h.orgClient = orgClient({
      readOrg: async (org: string) => ({ org, name: "Test Org", admin, pendingAdmin: ACCOUNT, open: false, createdBlock: 1n }),
    });
    await expect(run(orgCommand(), ["accept-admin", ORG])).rejects.toThrow(/--yes/);
    expect(printed()).toMatch(/accept this org's admin role \(it also closes the org\)/);
    expect(printed()).toMatch(/permanent:\s+your address, recorded as the org's admin/);
    expect(printed()).toMatch(/Only accept an org you recognise/);
    expect(sent()).toEqual([]);
    await run(orgCommand(), ["accept-admin", ORG, "--yes"]);
    expect(sent()).toEqual(["acceptAdmin"]);
    expect(printed()).toMatch(/you are now the admin \(org "Test Org" 0x0+a1\)/);
  });

  it("org create: declined on a terminal creates nothing", async () => {
    onTty(false);
    h.client = uploadClient();
    await run(orgCommand(), ["create", "Studio"]);
    expect(sent()).toEqual([]);
    expect(printed()).toMatch(/aborted: nothing was sent/);
  });

  it("org create --salt: a malformed salt is refused before any client; a good one is sent", async () => {
    h.client = uploadClient();
    await expect(run(orgCommand(), ["create", "Studio", "--salt", "0x1234", "--yes"])).rejects.toThrow(/--salt must be 32 bytes of hex/);
    expect(h.calls).toEqual([]);
    const salt = "0x" + "00".repeat(20) + "ab".repeat(12);
    await run(orgCommand(), ["create", "Studio", "--salt", salt, "--yes"]);
    expect(sent()).toEqual([`createOrg:Studio:${salt}`]);
  });

  it("tag remove: declined on a terminal removes nothing", async () => {
    onTty(false);
    h.orgClient = orgClient();
    await run(tagCommand(), ["remove", "5", "stable", "--org", ORG]);
    expect(sent()).toEqual([]);
  });

  it("view: a URL and --clear, or neither, is refused before any client (neither used to CLEAR the view)", async () => {
    await expect(run(viewCommand(), ["https://example.com/", "--clear", "--project-id", "5", "--org", ORG])).rejects.toThrow(/give a URL or --clear, not both/);
    await expect(run(viewCommand(), ["--project-id", "5", "--org", ORG])).rejects.toThrow(/give a URL, or --clear to remove it/);
    expect(h.calls).toEqual([]);
  });

  it("view: a URL the token would not emit, or one that is not public, is refused", async () => {
    await expect(run(viewCommand(), ["http://example.com/", "--project-id", "5", "--org", ORG])).rejects.toThrow(/not a URL the token will emit/);
    await expect(run(viewCommand(), ["https://localhost/x", "--project-id", "5", "--org", ORG])).rejects.toThrow(/refusing that URL: it must be a public https URL/);
    await expect(run(viewCommand(), ["https://192.168.1.1/", "--project-id", "5", "--org", ORG])).rejects.toThrow(/refusing that URL/);
    expect(h.calls).toEqual([]);
  });

  it("view: priced as the SDK's setView (a 512-byte URL is a larger blob than a name)", async () => {
    h.orgClient = orgClient();
    await run(viewCommand(), ["https://example.com/", "--project-id", "5", "--org", ORG, "--yes"]);
    expect(printed()).toMatch(/set abxfs\.view\s+~435,000 gas/);
  });

  it("update: each content transaction is reported as it is sent", async () => {
    h.orgClient = orgClient();
    await run(updateCommand(), [site(), "--project-id", "5", "--org", ORG, "--yes"]);
    expect(printed()).toMatch(/bundled 1 call \(~500,000 gas\)/);
  });

  it("upload: a personal org whose creation timed out but mined is recovered, and the upload goes into its first project", async () => {
    const { TransactionTimeoutError } = await import("@artblocks/abxfs-sdk");
    h.client = uploadClient({
      createOrg: async (o: { onSent?: (x: Hex) => void }) => (o.onSent?.(TX as Hex), Promise.reject(new TransactionTimeoutError(TX as Hex, "createOrg"))),
      recoverCreateOrg: async () => ({ state: "mined", org: ORG, tokenId: 0n }),
    });
    await run(uploadCommand(), [site(), "--name", "x", "--yes"]);
    expect(printed()).toMatch(/creating your org confirmed late: project #0/);
    expect(sent()).toEqual(expect.arrayContaining(["publishAndTag:0"]));
    expect(sent()).not.toContain("mintProject");
  });

  it("org list: the account's orgs, none, or a refusal without an account", async () => {
    h.client = mockClient({ myOrgs: async () => [{ org: ORG, name: "Mine\u001b[2J", roles: ["admin", "holder"], open: true }] });
    await run(orgCommand(), ["list", "--address", ACCOUNT]);
    expect(printed()).toMatch(/0x0+a1 "Mine\S*" \[admin, holder\] open/);
    expect(printed()).not.toContain("\u001b[2J");
    out.length = 0;
    h.client = mockClient({ myOrgs: async () => [] });
    await run(orgCommand(), ["list", "--address", ACCOUNT]);
    expect(printed()).toMatch(/no orgs for 0x0+a11ce/);
    delete process.env["ABXFS_PRIVATE_KEY"];
    await expect(run(orgCommand(), ["list"])).rejects.toThrow(/pass --address <account>, or set ABXFS_PRIVATE_KEY/);
    await expect(run(orgCommand(), ["list", "--address", "0x12"])).rejects.toThrow(/not a valid address: 0x12/);
  });

  it("org list: the key's account when no --address is given", async () => {
    process.env["ABXFS_PRIVATE_KEY"] = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    let asked = "";
    h.client = mockClient({ myOrgs: async (acct: string) => ((asked = acct), []) });
    await run(orgCommand(), ["list"]);
    expect(asked).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("org info: the record, with a pending admin; an address the factory did not create is refused", async () => {
    h.client = mockClient({
      readOrg: async () => ({ org: ORG, name: "Studio", admin: ACCOUNT, pendingAdmin: "0x1111111111111111111111111111111111111111", open: true, createdBlock: 42n }),
    });
    await run(orgCommand(), ["info", ORG]);
    expect(printed()).toMatch(/offered to: 0x1{40} \(awaiting acceptance\)/);
    expect(printed()).toMatch(/minting:\s+open to anyone/);
    expect(printed()).toMatch(/created at block 42/);
    h.client = mockClient({ readOrg: async () => null });
    await expect(run(orgCommand(), ["info", ORG])).rejects.toThrow(/is not an org created by this chain's factory/);
  });
});

describe("--allow-public: a refused pattern shows what it would have approved in the upload on the command line", () => {
  const argv0 = process.argv;
  afterEach(() => {
    process.argv = argv0;
  });

  it("a directory on the command line: the matching files in it are listed", () => {
    const d = site();
    writeFileSync(join(d, "a.txt"), "a");
    process.argv = ["node", "abxfs", "upload", "--chain", "x", d, "--allow-public", "*"];
    expect(() => collectAllowPublic("*", [])).toThrow(/index\.html|a\.txt/);
  });

  it("a single file on the command line, or nothing that exists: still refused", () => {
    const f = join(site(), "index.html");
    process.argv = ["node", "abxfs", "upload", f];
    expect(() => collectAllowPublic("*", [])).toThrow(/name the files you approve/);
    process.argv = ["node", "abxfs", "upload", "/nonexistent/path"];
    expect(() => collectAllowPublic("*", [])).toThrow(/name the files you approve/);
  });
});

