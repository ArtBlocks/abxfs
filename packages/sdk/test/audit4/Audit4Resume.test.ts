import { describe, expect, it } from "vitest";
import { encodeEventTopics, encodeAbiParameters, zeroAddress, type Abi } from "viem";
import { seriesCodeAbi } from "@artblocks/abx-sdk/abi";
import { createOrg, recoverCreateOrg, recoverMint } from "../../src/org.js";

const ORG = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000b2" as const;
const HASH = ("0x" + "ee".repeat(32)) as `0x${string}`;

function transferLog(address: `0x${string}`, from: `0x${string}`, id: bigint) {
  const ev = (seriesCodeAbi as readonly any[]).find((x) => x.type === "event" && x.name === "Transfer");
  const topics = encodeEventTopics({ abi: [ev] as Abi, eventName: "Transfer", args: { from, to: "0x00000000000000000000000000000000000a11ce", id } });
  return { address, topics, data: "0x" as const, blockNumber: 1n, transactionHash: HASH, logIndex: 0, blockHash: HASH, transactionIndex: 0, removed: false };
}
const client = (receipt: unknown | Error) => ({ getTransactionReceipt: async () => { if (receipt instanceof Error) throw receipt; return receipt; } }) as never;

describe("Audit4 recoverMint", () => {
  it("mined: returns token id from the org's own mint log", async () => {
    const r = await recoverMint(client({ status: "success", logs: [transferLog(ORG, zeroAddress, 7n)] }), ORG, HASH);
    expect(r).toEqual({ state: "mined", org: ORG, tokenId: 7n });
  });
  it("a Transfer from a DIFFERENT contract is ignored, and a successful receipt with no mint is 'unknown', NEVER 'reverted'", async () => {
    const r = await recoverMint(client({ status: "success", logs: [transferLog(OTHER, zeroAddress, 7n)] }), ORG, HASH);
    expect(r.state).toBe("unknown"); // 'reverted' would tell the caller a fresh mint is safe
    expect(r).toMatchObject({ reason: expect.stringContaining(HASH) });
  });
  it("only a mined-and-FAILED transaction is 'reverted'", async () => {
    expect((await recoverMint(client({ status: "reverted", logs: [] }), ORG, HASH)).state).toBe("reverted");
  });
  it("not found => pending, never reverted", async () => {
    const e = new Error("Transaction receipt with hash 0x.. could not be found"); e.name = "TransactionReceiptNotFoundError";
    expect((await recoverMint(client(e), ORG, HASH)).state).toBe("pending");
  });
  it("other RPC errors propagate (caller treats as wait)", async () => {
    await expect(recoverMint(client(new Error("HTTP 429")), ORG, HASH)).rejects.toThrow("429");
  });
  it("with a holder, the account must still own the token: a moved token is 'unknown', not 'mined'", async () => {
    const HOLDER = "0x00000000000000000000000000000000000a11ce" as const;
    const withOwner = (owner: string | Error) => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [transferLog(ORG, zeroAddress, 1n)], from: OTHER }),
      readContract: async () => { if (owner instanceof Error) throw owner; return owner; },
    }) as never;
    expect((await recoverMint(withOwner(HOLDER), ORG, HASH, { holder: HOLDER })).state).toBe("mined");
    expect((await recoverMint(withOwner(HOLDER.toUpperCase().replace("0X", "0x")), ORG, HASH, { holder: HOLDER })).state).toBe("mined");
    const moved = await recoverMint(withOwner(OTHER), ORG, HASH, { holder: HOLDER });
    expect(moved.state).toBe("unknown");
    expect((await recoverMint(withOwner(new Error("ownerOf reverted")), ORG, HASH, { holder: HOLDER })).state).toBe("unknown");
  });
  it("without a holder the old behaviour is kept (mined on the org's own mint log)", async () => {
    const r = await recoverMint(client({ status: "success", logs: [transferLog(ORG, zeroAddress, 1n)], from: OTHER }), ORG, HASH);
    expect(r.state).toBe("mined");
  });
  it("recoverCreateOrg: a successful receipt without OrgCreated is 'unknown' too", async () => {
    const r = await recoverCreateOrg(client({ status: "success", logs: [] }), ORG, HASH);
    expect(r.state).toBe("unknown");
  });
  it("createOrg reports the hash through onSent the instant it is submitted, before waiting for the receipt", async () => {
    const seen: string[] = [];
    const order: string[] = [];
    const publicClient = {
      simulateContract: async () => ({ request: { r: 1 } }),
      getTransactionReceipt: async () => { order.push("receipt"); throw Object.assign(new Error("never mined"), { name: "TransactionReceiptNotFoundError" }); },
      waitForTransactionReceipt: async () => { order.push("wait"); throw new Error("timeout"); },
      getTransaction: async () => { throw new Error("n/a"); },
    } as never;
    const walletClient = { account: { address: "0x00000000000000000000000000000000000a11ce" }, writeContract: async () => { order.push("sent"); return HASH; } } as never;
    await expect(
      createOrg({ publicClient, walletClient }, ORG, { name: "My org", onSent: (h) => { order.push("onSent"); seen.push(h); } }),
    ).rejects.toThrow();
    expect(seen).toEqual([HASH]);
    expect(order.slice(0, 2)).toEqual(["sent", "onSent"]);
  });
});
