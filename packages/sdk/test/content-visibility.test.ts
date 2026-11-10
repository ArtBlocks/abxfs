/**
 * "A receipt is not visibility" for the write pipeline (AGENTS.md; `settle.ts`).
 *
 * Public RPCs are load balanced across replicas that lag each other, so the read after a receipt can land on a node that
 * has not seen the write. Here EVERY read (planning probes, stage confirmations and the simulation that precedes each
 * transaction) is served three blocks behind the head, with the chain mining a block a second and receipts noticed within 100 ms (so the lag is real, not hidden by slow receipt polling). Each stage creates what the
 * next one references (`ChunkMissing`, `NodeMissing`, `CidNotFound` when the node simulating it is behind), so the
 * executor must wait for what it just wrote to become visible before it simulates the next stage; if it did not, the
 * second stage would revert at simulation and nothing past it would be written.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, createWalletClient, custom, http, numberToHex } from "viem";
import { foundry } from "viem/chains";

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { uploadContent } from "../src/draft.js";
import { readDirectory } from "../src/read.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => {
  await autoRegisterNodeCodecs();
  h = await startAnvilWithAbxfs({ deployCompanion: true });
  // A replica three blocks behind must still be past the deployment (a real lagging replica is behind by seconds, not
  // behind the contracts' creation): the deploy is only a handful of blocks.
  await h.publicClient.request({ method: "anvil_mine" as never, params: ["0x4"] as never });
  await h.publicClient.request({ method: "evm_setIntervalMining" as never, params: [1] as never });
}, 120_000);
afterAll(async () => h?.stop());

it("every stage waits for the previous one to be visible on a replica three blocks behind", async () => {
  const enc = new TextEncoder();
  const salt = randomBytes(6).toString("hex");
  const files = [
    { path: "a.txt", bytes: enc.encode(`a ${salt}`), mimeType: "text/plain" },
    { path: "d/b.txt", bytes: enc.encode(`b ${salt}`), mimeType: "text/plain" },
    { path: "d/big.bin", bytes: new Uint8Array(randomBytes(40_000)), mimeType: "application/octet-stream" },
  ];

  let lagged = 0;
  const fastPublic = createPublicClient({ chain: foundry, transport: http(h.rpcUrl), pollingInterval: 100 });
  const fastWallet = createWalletClient({ chain: foundry, transport: http(h.rpcUrl), account: h.account, pollingInterval: 100 });
  const behind = new Proxy(fastPublic, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "readContract" && prop !== "simulateContract") return v;
      return async (args: Record<string, unknown>) => {
        const head = await target.getBlockNumber();
        lagged++;
        const out = (await (v as (a: unknown) => Promise<unknown>).call(target, { ...args, blockNumber: head > 3n ? head - 3n : 0n })) as {
          request?: Record<string, unknown>;
        };
        // `simulateContract` echoes its arguments into `request`; the transaction built from it must not be pinned to
        // the stale block too (that is the wallet's view, not the lagging reader's).
        if (prop === "simulateContract" && out.request) return { ...out, request: { ...out.request, blockNumber: undefined } };
        return out;
      };
    },
  }) as typeof fastPublic;

  const r = await uploadContent({ publicClient: behind, walletClient: fastWallet as never }, h.addresses, files, {});
  expect(lagged).toBeGreaterThan(10);
  expect(r.txHashes.length).toBeGreaterThan(5);
  // The root is visible at the head, and complete.
  const dir = await readDirectory(h.publicClient, h.addresses, r.applied.newRootCid);
  expect(dir.entries.map((e) => e.name)).toEqual(["a.txt", "d"]);
}, 300_000);


it("pins dependent simulations when presence probes are fresh but latest eth_call hits a stale replica", async () => {
  const enc = new TextEncoder();
  const salt = randomBytes(6).toString("hex");
  const fastPublic = createPublicClient({ chain: foundry, transport: http(h.rpcUrl), pollingInterval: 100 });
  const staleBlock = await fastPublic.getBlockNumber({ cacheTime: 0 });
  let unpinnedWalletEstimates = 0;
  const fastWallet = createWalletClient({ chain: foundry, account: h.account, pollingInterval: 100, transport: custom({
    request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
      if (method === "eth_estimateGas" && (params?.[1] === undefined || params[1] === "latest")) {
        unpinnedWalletEstimates++;
        // The wallet's next estimate would see the same stale prerequisites as its eth_call.
        return fastPublic.request({ method, params: [params?.[0], numberToHex(staleBlock)] } as never);
      }
      return fastPublic.request({ method, params } as never);
    },
  }) });
  const simulatedBlocks: Array<bigint | undefined> = [];
  const estimatedBlocks: Array<bigint | undefined> = [];
  let writes = 0;
  const alternating = new Proxy(fastPublic, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "simulateContract" && prop !== "estimateContractGas") return v;
      return async (args: Record<string, unknown>) => {
        // Existence multicalls have no account and reach the fresh replica. Content simulation
        // and estimation reach the stale replica unless an exact confirmed block is requested.
        if (prop === "simulateContract" && args.account === undefined)
          return (v as (args: unknown) => Promise<unknown>).call(target, args);
        (prop === "simulateContract" ? simulatedBlocks : estimatedBlocks).push(args.blockNumber as bigint | undefined);
        return (v as (args: unknown) => Promise<unknown>).call(target, { ...args, blockNumber: args.blockNumber ?? staleBlock });
      };
    },
  }) as typeof fastPublic;
  const wallet = new Proxy(fastWallet, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "writeContract") return v;
      return async (args: Record<string, unknown>) => {
        expect(args).not.toHaveProperty("blockNumber");
        if (writes > 0) expect(typeof args.gas).toBe("bigint");
        writes++;
        return (v as (args: unknown) => Promise<unknown>).call(target, args);
      };
    },
  }) as typeof fastWallet;
  const files = [
    { path: "index.html", bytes: enc.encode(`<p>replica ${salt}</p>`), mimeType: "text/html" },
    { path: "a.txt", bytes: enc.encode(`asset ${salt}`), mimeType: "text/plain" },
  ];
  const result = await uploadContent({ publicClient: alternating, walletClient: wallet as never }, h.addresses, files);
  expect(simulatedBlocks[0]).toBeUndefined();
  expect(simulatedBlocks.slice(1).every((block) => block !== undefined && block >= staleBlock)).toBe(true);
  expect(estimatedBlocks.length).toBeGreaterThan(0);
  expect(estimatedBlocks.every((block) => block !== undefined && block >= staleBlock)).toBe(true);
  expect(unpinnedWalletEstimates).toBe(1); // Only the first write has no prerequisite receipts.
  expect(writes).toBe(result.txHashes.length); // No repeated broadcast to repair stale reads.
  const dir = await readDirectory(h.publicClient, h.addresses, result.applied.newRootCid);
  expect(dir.entries.map((entry) => entry.name)).toEqual(["a.txt", "index.html"]);
}, 120_000);
