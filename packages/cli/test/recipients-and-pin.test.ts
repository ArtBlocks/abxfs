/**
 * Recipient validation and confirmations for irreversible writes (F), and pin credential handling (C).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

const ORG = "0x00000000000000000000000000000000000000a1";
const SIGNER = "0x00000000000000000000000000000000000a11ce";
const sent: string[] = [];

vi.mock("../src/client.js", async () => {
  const { mockClient } = await import("./helpers/mock-client.js");
  const c = mockClient({
    mintProject: async () => (sent.push("mint"), { tokenId: 1n, txHash: "0x01" }),
    transferAdmin: async () => (sent.push("transferAdmin"), "0x01"),
    transferProject: async () => (sent.push("transferProject"), "0x01"),
    readProject: async () => ({ owner: "0x0000000000000000000000000000000000000001", name: "n", versionCount: 1 }),
  });
  return { createClient: () => c, createOrgClient: async () => c };
});

import { mintRecipientWarning, orgCommand } from "../src/commands/org.js";
import { transferCommand } from "../src/commands/transfer.js";
import { resolveApiKey } from "../src/commands/pin.js";

const GOOD = getAddress("0x1111111111111111111111111111111111111111");
const saved = { ...process.env };
beforeEach(() => {
  sent.length = 0;
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const org = (args: string[]) => orgCommand().parseAsync(args, { from: "user" });

describe("org mint --to", () => {
  it.each([
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["a burn address", "0x000000000000000000000000000000000000dEaD"],
    ["the org itself", ORG],
    ["a bad checksum", "0x1111111111111111111111111111111111111111".replace("1111", "AbCd")],
    ["a short address", "0x1234"],
  ])("rejects %s", async (_n, to) => {
    await expect(org(["mint", ORG, "--to", to, "--chain", "base-sepolia"])).rejects.toThrow(/invalid recipient/);
    expect(sent).toEqual([]);
  });

  it("accepts a valid checksummed address", async () => {
    await org(["mint", ORG, "--to", GOOD, "--chain", "base-sepolia", "--yes"]);
    expect(sent).toEqual(["mint"]);
  });

  // The admin has no power over a minted project, so minting to someone else is giving it away.
  it("warns on stderr, once, when the recipient is not the signer", async () => {
    await org(["mint", ORG, "--to", GOOD, "--chain", "base-sepolia", "--yes"]);
    const errs = vi.mocked(console.error).mock.calls.map((c) => c.join(" "));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(GOOD);
    expect(errs[0]).toMatch(/cannot edit it or take it back/);
    expect(errs[0]).not.toMatch(/\n/);
    expect(sent).toEqual(["mint"]);
  });

  it("does not warn when minting to the signer (by --to, in any case, or by default)", async () => {
    await org(["mint", ORG, "--to", getAddress(SIGNER), "--chain", "base-sepolia", "--yes"]);
    await org(["mint", ORG, "--chain", "base-sepolia", "--yes"]);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(sent).toEqual(["mint", "mint"]);
    expect(mintRecipientWarning("0x00000000000000000000000000000000000A11CE", SIGNER)).toBeNull();
  });
});

describe("org transfer-admin", () => {
  it("rejects a zero/burn/self target before any prompt or send", async () => {
    for (const to of ["0x0000000000000000000000000000000000000000", ORG]) {
      await expect(org(["transfer-admin", ORG, to, "--chain", "base-sepolia"])).rejects.toThrow(/invalid admin offer target/);
    }
    expect(sent).toEqual([]);
  });

  it("without --yes and without a TTY it refuses instead of sending", async () => {
    await expect(org(["transfer-admin", ORG, GOOD, "--chain", "base-sepolia"])).rejects.toThrow(/--yes/);
    expect(sent).toEqual([]);
  });

  it("with --yes it sends", async () => {
    await org(["transfer-admin", ORG, GOOD, "--yes", "--chain", "base-sepolia"]);
    expect(sent).toEqual(["transferAdmin"]);
  });
});

describe("transfer", () => {
  const t = (args: string[]) => transferCommand().parseAsync(args, { from: "user" });
  it("rejects zero, burn, the org and a mistyped checksum", async () => {
    for (const to of [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dEaD",
      ORG,
      "0xAbCd111111111111111111111111111111111111",
    ]) {
      await expect(t(["1", to, "--org", ORG, "--chain", "base-sepolia", "--yes"])).rejects.toThrow(/invalid new owner/);
    }
    expect(sent).toEqual([]);
  });

  it("requires a typed confirmation without --yes", async () => {
    await expect(t(["1", GOOD, "--org", ORG, "--chain", "base-sepolia"])).rejects.toThrow(/--yes/);
    expect(sent).toEqual([]);
    await t(["1", GOOD, "--org", ORG, "--chain", "base-sepolia", "--yes"]);
    expect(sent).toEqual(["transferProject"]);
  });
});

describe("pin credentials", () => {
  it("takes the key from env, without a warning", () => {
    process.env["PINATA_JWT"] = "env-token-123456";
    expect(resolveApiKey({ provider: "pinata" })).toBe("env-token-123456");
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });

  it("warns that --api-key leaks to shell history and ps", () => {
    expect(resolveApiKey({ provider: "pinata", apiKey: "flag-token-123456" })).toBe("flag-token-123456");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toMatch(/history/);
  });

  it("refuses a non-https endpoint when a key is attached, except localhost", () => {
    expect(() => resolveApiKey({ provider: "pinata", apiKey: "k-123456", endpoint: "http://pin.example/api" })).toThrow(/non-https/);
    expect(resolveApiKey({ provider: "pinata", apiKey: "k-123456", endpoint: "https://pin.example/api" })).toBe("k-123456");
    expect(resolveApiKey({ provider: "pinata", apiKey: "k-123456", endpoint: "http://localhost:5001" })).toBe("k-123456");
  });
});
