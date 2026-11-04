/**
 * Receipt status (audit M1) and `mintInOrg` trust (audit low item): a reverted transaction is an
 * error, and a mint is only ever sent to an org an ABX FS factory created.
 */
import { describe, expect, it } from "vitest";
import { encodeEventTopics } from "viem";
import { seriesCodeAbi } from "@artblocks/abx-sdk/abi";

import { generationOfOrg, mintInOrg } from "../src/org.js";
import { TransactionRevertedError, assertReceiptSuccess, waitForSuccessfulReceipt } from "../src/receipts.js";
import type { ContractAddresses } from "../src/index.js";

const FACTORY = "0x00000000000000000000000000000000000f4c70";
const MINTER = "0x000000000000000000000000000000000000beef";
const ORG = "0x00000000000000000000000000000000000000a1";
const ME = "0x00000000000000000000000000000000000a11ce";
const ADDRS = { orgFactory: FACTORY, projectHook: "0x0000000000000000000000000000000000000002" } as unknown as ContractAddresses;

function transferLog(id: bigint) {
  const topics = encodeEventTopics({
    abi: seriesCodeAbi,
    eventName: "Transfer",
    args: { from: "0x0000000000000000000000000000000000000000", to: ME, id },
  } as never);
  return { address: ORG, topics, data: "0x", blockNumber: 1n, logIndex: 0, transactionIndex: 0, blockHash: "0x00", transactionHash: "0x00", removed: false };
}

function fakeClients(opts: { registered: boolean; receiptStatus: "success" | "reverted"; logs?: unknown[] }) {
  const sent: { address: string; functionName: string }[] = [];
  const reads: string[] = [];
  const publicClient = {
    async readContract(a: { address: string; functionName: string }) {
      reads.push(a.functionName);
      switch (a.functionName) {
        case "isOrg":
          return opts.registered;
        case "minter":
          return MINTER;
        case "mayMint":
          return true;
        case "ownerOf":
          return ME;
        default:
          throw new Error("unexpected " + a.functionName);
      }
    },
    async simulateContract(a: { address: string; functionName: string }) {
      return { request: { address: a.address, functionName: a.functionName }, result: 7n };
    },
    async waitForTransactionReceipt() {
      return { status: opts.receiptStatus, logs: opts.logs ?? [transferLog(7n)] };
    },
  };
  const walletClient = {
    account: { address: ME },
    async writeContract(req: { address: string; functionName: string }) {
      sent.push(req);
      return "0x" + "11".repeat(32);
    },
  };
  return { publicClient: publicClient as never, walletClient: walletClient as never, sent, reads };
}

describe("receipt status", () => {
  it("assertReceiptSuccess throws for anything but success", () => {
    expect(() => assertReceiptSuccess({ status: "reverted" }, "0x01")).toThrow(TransactionRevertedError);
    expect(() => assertReceiptSuccess({ status: "weird" }, "0x01")).toThrow(/reverted/);
    expect(assertReceiptSuccess({ status: "success" }, "0x01").status).toBe("success");
  });

  it("waitForSuccessfulReceipt rejects a mined-but-reverted transaction", async () => {
    const client = { waitForTransactionReceipt: async () => ({ status: "reverted" }) } as never;
    await expect(waitForSuccessfulReceipt(client, "0xabc", "publish")).rejects.toThrow(/publish reverted on chain/);
  });
});

describe("mintInOrg", () => {
  it("returns the token id from the receipt's own Transfer log", async () => {
    const c = fakeClients({ registered: true, receiptStatus: "success" });
    const out = await mintInOrg(c, ORG, { addresses: ADDRS });
    expect(out.tokenId).toBe(7n);
  }, 20_000);

  it("throws for a REVERTED mint (it used to return the simulated id)", async () => {
    const c = fakeClients({ registered: true, receiptStatus: "reverted" });
    await expect(mintInOrg(c, ORG, { addresses: ADDRS })).rejects.toThrow(/reverted/);
  }, 20_000);

  it("refuses to guess the id when a successful receipt has no Transfer", async () => {
    const c = fakeClients({ registered: true, receiptStatus: "success", logs: [] });
    await expect(mintInOrg(c, ORG, { addresses: ADDRS })).rejects.toThrow(/refusing to guess/);
  }, 20_000);

  it("sends NOTHING and reads nothing from an address no ABX FS factory created", async () => {
    const c = fakeClients({ registered: false, receiptStatus: "success" });
    await expect(mintInOrg(c, ORG, { addresses: ADDRS })).rejects.toThrow(/not an org/);
    expect(c.sent).toHaveLength(0);
    expect(c.reads).not.toContain("minter");
    expect(c.reads).not.toContain("factory");
  });

  it("rejects a mint-to target that is zero, a burn address, or the org itself, before any call", async () => {
    for (const to of [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dEaD",
      ORG,
      "0x1234", // not an address
    ]) {
      const c = fakeClients({ registered: true, receiptStatus: "success" });
      await expect(mintInOrg(c, ORG, { to: to as never, addresses: ADDRS })).rejects.toThrow(/invalid mint target/);
      expect(c.reads).toHaveLength(0);
      expect(c.sent).toHaveLength(0);
    }
  });
});

describe("generationOfOrg", () => {
  // ACCEPTED RISK, kept as a PoC on purpose: the factory addresses come from the SDK's registry (or
  // from whoever constructs the client), and are trusted. A client given a hostile factory address
  // will believe it. Nothing in the SDK can distinguish that from a legitimate deployment; the fix
  // is to take addresses from the registry, which is what every in-repo caller does.
  it("believes whichever factory addresses it is handed", async () => {
    const hostile = "0x00000000000000000000000000000000000f4c70";
    const client = {
      async readContract(a: { address: string; functionName: string }) {
        return a.address.toLowerCase() === hostile && a.functionName === "isOrg";
      },
    } as never;
    const g = await generationOfOrg(
      client,
      { orgFactory: hostile, projectHook: "0x0000000000000000000000000000000000000002" } as never,
      ORG,
    );
    expect(g?.orgFactory).toBe(hostile);
  });
});
