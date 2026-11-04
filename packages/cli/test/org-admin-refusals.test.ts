/**
 * The org admin commands refuse, in one sentence and before the prompt, what the factory would revert: `accept-admin`
 * from an address the role was not offered to (`NotPendingAdmin`), and `transfer-admin`, `open` and `close` from one
 * that is not the admin (`NotAdmin`). It used to print viem's whole revert dump (seen on Base Sepolia, 2026-10-31).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Org } from "@abxfs/sdk";
import type { Address } from "viem";

const h = vi.hoisted(() => ({ sent: [] as string[], record: null as unknown, readFails: false }));

vi.mock("../src/client.js", async () => {
  const { mockClient } = await import("./helpers/mock-client.js");
  const c = mockClient({
    readOrg: async () => {
      if (h.readFails) throw new Error("the RPC timed out");
      return h.record;
    },
    acceptAdmin: async () => (h.sent.push("acceptAdmin"), "0x01"),
    transferAdmin: async () => (h.sent.push("transferAdmin"), "0x01"),
    setOpen: async (open: boolean) => (h.sent.push(`setOpen:${open}`), "0x01"),
  });
  return { createClient: () => c, createOrgClient: async () => c };
});

import { ACCOUNT as SIGNER } from "./helpers/mock-client.js";

const ACCOUNT = SIGNER as Address;
import { adminRefusal, orgCommand } from "../src/commands/org.js";

const ORG: Address = "0x00000000000000000000000000000000000000a1";
const ADMIN: Address = "0x00000000000000000000000000000000000000ad";
const OTHER: Address = "0x0000000000000000000000000000000000000b0b";
const record = (admin: Address, pendingAdmin: Address | null): Org => ({
  org: ORG,
  name: "Test Org",
  admin,
  pendingAdmin,
  open: false,
  createdBlock: 1n,
});

const saved = { ...process.env };
beforeEach(() => {
  h.sent.length = 0;
  h.readFails = false;
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const org = (args: string[]) => orgCommand().parseAsync([...args, "--yes", "--chain", "base-sepolia"], { from: "user" });

/** The command's refusal: one line, saying nothing was sent, and nothing was. */
async function refused(args: string[]): Promise<string> {
  const err = (await org(args).then(
    () => null,
    (e: unknown) => e,
  )) as Error | null;
  expect(err, `${args[0]} should have been refused`).toBeInstanceOf(Error);
  expect(err!.message).not.toMatch(/\n/);
  expect(err!.message).toMatch(/Nothing was sent\.$/);
  expect(err!.message).not.toMatch(/reverted|Contract Call|docs/i);
  expect(h.sent).toEqual([]);
  return err!.message;
}

describe("org accept-admin", () => {
  it("from an address the role was offered to, accepts", async () => {
    h.record = record(ADMIN, ACCOUNT);
    await org(["accept-admin", ORG]);
    expect(h.sent).toEqual(["acceptAdmin"]);
  });

  it("offered to someone else: names who it was offered to", async () => {
    h.record = record(ADMIN, OTHER);
    expect(await refused(["accept-admin", ORG])).toBe(
      `the admin role of org ${ORG} was offered to ${OTHER}, not to your account ${ACCOUNT}: only they can accept it. Nothing was sent.`,
    );
  });

  it("offered to nobody: says how the admin offers it", async () => {
    h.record = record(ADMIN, null);
    const message = await refused(["accept-admin", ORG]);
    expect(message).toMatch(/has not been offered to anyone/);
    expect(message).toContain(`\`abxfs org transfer-admin ${ORG} ${ACCOUNT}\``);
  });

  it("by the admin itself, with nothing pending: says it already is", async () => {
    h.record = record(ACCOUNT, null);
    expect(await refused(["accept-admin", ORG])).toMatch(/is already the admin/);
  });

  it("addresses compare case-insensitively", async () => {
    h.record = record(ADMIN, ACCOUNT.toUpperCase().replace("0X", "0x") as Address);
    await org(["accept-admin", ORG]);
    expect(h.sent).toEqual(["acceptAdmin"]);
  });

  it("an unreadable record is left to the chain: the command goes on to send", async () => {
    h.readFails = true;
    await org(["accept-admin", ORG]);
    expect(h.sent).toEqual(["acceptAdmin"]);
  });
});

describe("the admin-only commands", () => {
  it.each([
    [["transfer-admin", ORG, "0x1111111111111111111111111111111111111111"], "offer the admin role"],
    [["open", ORG], "open it"],
    [["close", ORG], "close it"],
  ])("%j from a non-admin is refused", async (args, what) => {
    h.record = record(ADMIN, null);
    expect(await refused(args)).toBe(
      `your account ${ACCOUNT} is not the admin of org ${ORG} (${ADMIN} is): only the admin can ${what}. Nothing was sent.`,
    );
  });

  it("an offer pending to the signer does not make it the admin", async () => {
    h.record = record(ADMIN, ACCOUNT);
    await refused(["open", ORG]);
  });

  it("from the admin, they send", async () => {
    h.record = record(ACCOUNT, null);
    await org(["open", ORG]);
    await org(["close", ORG]);
    await org(["transfer-admin", ORG, "0x1111111111111111111111111111111111111111"]);
    expect(h.sent).toEqual(["setOpen:true", "setOpen:false", "transferAdmin"]);
  });
});

describe("adminRefusal", () => {
  it("is null exactly when the factory would accept the call", () => {
    expect(adminRefusal(record(ACCOUNT, null), ACCOUNT, "admin", "open it")).toBeNull();
    expect(adminRefusal(record(ADMIN, ACCOUNT), ACCOUNT, "offered", "accept it")).toBeNull();
    // An admin may offer the role to itself, and then accept it.
    expect(adminRefusal(record(ACCOUNT, ACCOUNT), ACCOUNT, "offered", "accept it")).toBeNull();
    expect(adminRefusal(record(ADMIN, null), ACCOUNT, "admin", "open it")).not.toBeNull();
    expect(adminRefusal(record(ADMIN, OTHER), ACCOUNT, "offered", "accept it")).not.toBeNull();
  });
});
