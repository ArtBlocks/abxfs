/**
 * Every contract has one address on every chain, so a write planned against Base Sepolia is a valid transaction on
 * Base. A wallet client set up for another chain than the one the SDK reads is refused before anything is sent.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, custom, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import { AbxfsClient } from "../src/abxfs.js";
import { sendBundles } from "../src/multicall.js";
import { publishRootAndTag } from "../src/publish.js";
import { createOrg, mintInOrg } from "../src/org.js";
import { WrongChainError, assertWalletChain } from "../src/wallet-chain.js";
import { chunkStoreAbi } from "../src/abi.js";
import type { AbxfsCid, ContractAddresses } from "../src/types.js";

// Any RPC call at all fails the test: the refusal must come first.
const calls: string[] = [];
const noRpc = custom({
  async request({ method }: { method: string }) {
    calls.push(method);
    throw new Error(`unexpected RPC call ${method}`);
  },
});
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const reader = (chain?: Chain) => createPublicClient({ ...(chain ? { chain } : {}), transport: noRpc });
const wallet = (chain?: Chain) => createWalletClient({ ...(chain ? { chain } : {}), transport: noRpc, account });
const A = "0x0000000000000000000000000000000000000001" as const;
const addresses = { chunkStore: A, fileStore: A, directoryStore: A, sstore2Backend: A, fastLzBackend: A } as ContractAddresses;
const file = { path: "a.txt", bytes: new TextEncoder().encode("a"), mimeType: "text/plain" };
const ROOT = `0x${"11".repeat(32)}` as AbxfsCid;

describe("a write is signed only for the chain the SDK reads", () => {
  it("refuses two different chains, and lets the same chain or an unnamed one through", () => {
    expect(() => assertWalletChain(reader(baseSepolia), wallet(base))).toThrow(WrongChainError);
    expect(() => assertWalletChain(reader(baseSepolia), wallet(base))).toThrow(/chain 8453, but this client reads chain 84532: nothing was sent/);
    expect(() => assertWalletChain(reader(base), wallet(base))).not.toThrow();
    expect(() => assertWalletChain(reader(), wallet(base))).not.toThrow();
    expect(() => assertWalletChain(reader(base), wallet())).not.toThrow();
  });

  it("every write entry point refuses a mismatched pair before any RPC call", async () => {
    calls.length = 0;
    const clients = { publicClient: reader(baseSepolia) as never, walletClient: wallet(base) as never };
    const client = new AbxfsClient({ ...clients, addresses });
    expect(() => client.uploadFile(file)).toThrow(WrongChainError);
    expect(() => client.upload([file])).toThrow(WrongChainError);
    await expect(sendBundles(clients, [{ target: A, calls: [] }] as never, chunkStoreAbi)).rejects.toThrow(WrongChainError);
    await expect(publishRootAndTag(clients, { collection: A, hook: A } as never, 1n, ROOT)).rejects.toThrow(WrongChainError);
    await expect(createOrg(clients, A, { name: "x" } as never)).rejects.toThrow(WrongChainError);
    await expect(mintInOrg(clients, A, {} as never)).rejects.toThrow(WrongChainError);
    expect(calls).toEqual([]);
  });
});
