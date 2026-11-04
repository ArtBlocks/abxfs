/**
 * Delta audit L2 (ported from the auditor's PoC, inverted): the implicit org choice must never read "the record of
 * the org I administer could not be read" as "I administer no org". The SDK's org list drops an org whose record read
 * fails (it throws only when NO org could be read), so an account that administers org A and holds an unsolicited
 * project in someone else's org B used to get a NEW personal org created (a paid, permanent write) when A's read
 * failed once. Now the upload refuses, naming what could not be read, before anything is uploaded or created.
 *
 * Delta audit round 2 (informational 5): the choice used to refuse when ANY connected org's read failed, held ones
 * included, and anyone can mint into a wallet from an open org: one unreadable org of theirs blocked every implicit
 * upload. "Administers none" is now decided from the factories' administered lists alone
 * (`readOrgsAdministeredAcrossGenerations`). A failed administered read still refuses; a failed held read (an org's
 * record, or the held list itself) does not. And a factory whose list cannot be read is named as a factory, not
 * counted as an "org".
 *
 * Runs the real SDK reads over a stub public client.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], client: {} as Record<string, unknown> }));
vi.mock("../../src/client.js", () => ({
  createClient: () => h.client,
  createOrgClient: async () => h.client,
}));

import { mockClient, CONTENT_ADDRESSES } from "../helpers/mock-client.js";
import { uploadCommand } from "../../src/commands/upload.js";

const MINE = "0x00000000000000000000000000000000000000a1"; // administered by the account
const THEIRS = "0x00000000000000000000000000000000000000b7"; // an open org that minted a project into the account's wallet
const registry = { ...CONTENT_ADDRESSES, projectEnumeration: "0x00000000000000000000000000000000000000e1" };

interface Stub {
  /** Orgs the account administers (the factory's list). */
  administered?: string[];
  /** Orgs whose record read fails. */
  failing?: Set<string>;
  /** The factory's administered list cannot be read. */
  factoryDown?: boolean;
  /** The enumeration hook's held list cannot be read. */
  heldDown?: boolean;
}

/** A node that answers the factory's and the enumeration hook's paged lists, and the orgs' records. */
function stubPublicClient(stub: Stub) {
  const administered = stub.administered ?? [MINE];
  const page = (list: string[], args: readonly unknown[]) => {
    const start = Number(args[1] ?? 0n);
    const count = Number(args[2] ?? 200n);
    return list.slice(start, start + count);
  };
  return {
    chain: { id: 84532 },
    getBalance: async () => 10n ** 18n,
    getBlockNumber: async () => 100n,
    estimateContractGas: async () => 1_800_000n,
    readContract: async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "orgsAdministeredSlice") {
        if (stub.factoryDown) throw new Error("HTTP request failed.");
        return page(administered, args);
      }
      if (functionName === "orgsHeldCount" || functionName === "orgsHeldSlice") {
        if (stub.heldDown) throw new Error("HTTP request failed.");
        return functionName === "orgsHeldCount" ? 1n : page([THEIRS], args);
      }
      throw new Error(`unexpected ${functionName}`);
    },
    multicall: async ({ contracts }: { contracts: Array<{ args?: unknown[] }> }) => {
      const org = String(contracts[0]!.args![0]);
      if (stub.failing?.has(org)) throw new Error("HTTP request failed.");
      const ok = (result: unknown) => ({ status: "success", result });
      const name = org === MINE ? "Mine" : "Someone Else";
      const admin = org === MINE ? "0x00000000000000000000000000000000000a11ce" : "0x00000000000000000000000000000000000000ee";
      return [ok(true), ok(admin), ok("0x0000000000000000000000000000000000000000"), ok(org !== MINE), ok(org === MINE ? 7n : 5n), ok(name)];
    },
  };
}

let out: string[] = [];
beforeEach(() => {
  h.calls.length = 0;
  out = [];
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_ORG"];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function setup(stub: Stub) {
  const pc = stubPublicClient(stub);
  const orgClient = mockClient({
    mayMint: async () => true,
    mintProject: async () => (h.calls.push("mintProject"), { tokenId: 3n, txHash: "0x" + "12".repeat(32) }),
    publishAndTag: async () => (h.calls.push("publishAndTag"), { versionNumber: 1n }),
    setProjectName: async () => (h.calls.push("setProjectName"), "0x" + "12".repeat(32)),
  });
  h.client = mockClient({
    registry,
    publicClient: pc,
    planUpload: async () => ({ rootCid: "0x" + "cd".repeat(32), files: [], rootKind: "directory" }),
    upload: async () => (h.calls.push("upload"), { rootCid: "0x" + "cd".repeat(32), rootKind: "directory", txHashes: [] }),
    createOrg: async (a: { name: string }) => (h.calls.push(`createOrg:${a.name}`), { org: "0x00000000000000000000000000000000000000c3", firstTokenId: 0n, txHash: "0x" + "12".repeat(32) }),
    resolveOrg: async (o: string) => (h.calls.push(`resolveOrg:${o}`), orgClient),
    forOrg: () => orgClient,
  });
}

const site = () => {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-implicit-"));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  return dir;
};
const upload = () => uploadCommand().parseAsync([site(), "--name", "site", "--yes", "--chain", "base-sepolia"], { from: "user" });

describe("implicit org choice when a read fails", () => {
  it("refuses, and creates nothing, when the record of the org the account administers could not be read", async () => {
    setup({ failing: new Set([MINE]) });
    await expect(upload()).rejects.toThrow(/could not read 1 org\(s\) you administer; pass --org or retry\. Nothing was uploaded/);
    expect(out.join("\n")).not.toMatch(/you administer no org on this chain/);
    expect(h.calls.some((c) => c.startsWith("createOrg:"))).toBe(false);
    expect(h.calls).not.toContain("upload");
  });

  it("refuses when the factory's list of the orgs it administers could not be read, naming the factory, not an 'org'", async () => {
    setup({ factoryDown: true });
    const err = (await upload().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(
      new RegExp(`could not read the list of orgs you administer from 1 org factory\\(ies\\) \\(${CONTENT_ADDRESSES.orgFactory}\\); pass --org or retry`),
    );
    expect(err.message).not.toMatch(/\d+ org\(s\)/);
    expect(h.calls).toEqual([]);
  });

  it("an org the account only HOLDS a project in, whose record cannot be read, does not stop the choice", async () => {
    setup({ failing: new Set([THEIRS]) });
    await upload();
    expect(out.join("\n")).toMatch(/using the newest org you administer, "Mine" 0x0+a1/);
    expect(h.calls).toContain(`resolveOrg:${MINE}`);
    expect(h.calls.some((c) => c.startsWith("createOrg:"))).toBe(false);
  });

  it("nor does a held list that cannot be read at all", async () => {
    setup({ heldDown: true });
    await upload();
    expect(h.calls).toContain(`resolveOrg:${MINE}`);
    expect(h.calls.some((c) => c.startsWith("createOrg:"))).toBe(false);
  });

  it("administering none with the held list unreadable creates the personal org, without counting held orgs", async () => {
    setup({ administered: [], heldDown: true });
    await upload();
    expect(out.join("\n")).toMatch(/you administer no org on this chain, so a personal org .* will be created for this project$/m);
    expect(out.join("\n")).not.toMatch(/You hold projects in/);
    expect(h.calls.some((c) => c.startsWith("createOrg:"))).toBe(true);
  });

  it("administering none with the held list readable says the held orgs are never used", async () => {
    setup({ administered: [] });
    await upload();
    expect(out.join("\n")).toMatch(/You hold projects in 1 org\(s\) run by others; those are never used without --org/);
    expect(h.calls).not.toContain(`resolveOrg:${THEIRS}`);
  });

  it("with every read answered, the org the account administers is used and no org is created", async () => {
    setup({});
    await upload();
    expect(out.join("\n")).toMatch(/using the newest org you administer, "Mine" 0x0+a1/);
    expect(h.calls).toContain(`resolveOrg:${MINE}`);
    expect(h.calls.some((c) => c.startsWith("createOrg:"))).toBe(false);
    expect(h.calls).toEqual(expect.arrayContaining(["upload", "mintProject", "publishAndTag", "setProjectName"]));
  });
});
