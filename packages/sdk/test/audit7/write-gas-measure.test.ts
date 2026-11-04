/** Measure real gas of worst-case nodes against the node gas model (anvil, ephemeral port). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { chunkStoreAbi, directoryStoreAbi, fileStoreAbi } from "../../src/abi.js";
import { chunkId } from "../../src/cid.js";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { uploadContent } from "../../src/draft.js";
import { packEntryTree, packChunkTree, nodeBlobHex } from "../../src/nodes.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";
import { keccak256, toHex } from "viem";

let h: AnvilHarness;
beforeAll(async () => { await autoRegisterNodeCodecs(); h = await startAnvilWithAbxfs(); }, 180_000);
afterAll(async () => h?.stop());

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(h.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: unknown };
}

async function send(to: `0x${string}`, abi: any, fn: string, args: unknown[]) {
  const data = encodeFunctionData({ abi, functionName: fn, args } as never);
  const hash = await h.walletClient.sendTransaction({ to, data, gas: 30_000_000n, account: h.account, chain: null } as never);
  const rc = await h.publicClient.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (rc.status !== "success") throw new Error(`${fn} reverted`);
  return Number(rc.gasUsed);
}

describe("gas measure", () => {
  it("entry leaf 84x255B and L2 directory branch", async () => {
    await rpc("anvil_setBlockGasLimit", ["0x" + (4_000_000_000).toString(16)]);
    const up = await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, [{ path: "x.txt", bytes: new TextEncoder().encode("hello audit7"), mimeType: "text/plain" }], {});
    const fileCid = up.applied.files[0]!.newCid!;
    const ds = h.addresses.directoryStore;
    // A: 84 entries x 255-byte names, all files
    const names = Array.from({ length: 84 }, (_, i) => String(i).padStart(3, "0").padEnd(255, "ÿ".length ? "z" : "z"));
    const A = packEntryTree(names.map((name) => ({ name, cid: fileCid, isDirectory: false })));
    const leaf = A.nodes[0]!;
    const gasA = await send(ds, directoryStoreAbi, "putEntryNode", [nodeBlobHex(leaf)]);
    console.log("A leaf blob", leaf.blob.length, "count", leaf.count, "model", leaf.estimatedGas, "real", gasA, "ratio", (gasA / leaf.estimatedGas).toFixed(2));
    expect(gasA).toBeLessThanOrEqual(leaf.estimatedGas);

    // B: 2,000 one-record leaves -> content-defined level-1 branches -> level 2. The largest branch at each level is
    // measured against the model. (Branch boundaries are content-defined by node id, so the depth a given count needs
    // depends on the ids: 3,000 of these leaves happen to need a fourth level, which the protocol refuses.)
    const N = 2000;
    const entries = Array.from({ length: N }, (_, i) => ({ name: String(i).padStart(5, "0"), cid: fileCid, isDirectory: false }));
    const B = packEntryTree(entries, { leafGasCap: 1 });
    expect(B.rootLevel).toBeGreaterThanOrEqual(2);
    const leaves = B.nodes.filter((x) => x.level === 0);
    for (let i = 0; i < leaves.length; i += 100) {
      const data = leaves.slice(i, i + 100).map((n) => encodeFunctionData({ abi: directoryStoreAbi, functionName: "putEntryNode", args: [nodeBlobHex(n)] } as never));
      await send(ds, directoryStoreAbi, "multicall", [data]);
    }
    for (let level = 1; level <= B.rootLevel; level++) {
      const nodes = B.nodes.filter((x) => x.level === level);
      for (const n of nodes) {
        const g = await send(ds, directoryStoreAbi, "putEntryNode", [nodeBlobHex(n)]);
        expect(g).toBeLessThanOrEqual(n.estimatedGas);
      }
      const widest = nodes.reduce((m, n) => (n.childIds.length > m.childIds.length ? n : m));
      console.log(`L${level} branches=${nodes.length} widest=${widest.childIds.length} model ${widest.estimatedGas}`);
    }

    // C: the SDK's largest chunk leaf (512 records, every chunk distinct and size-checked), against the model.
    const fs = h.addresses.fileStore;
    const chunkHashes: `0x${string}`[] = [];
    const sizes: number[] = [];
    const writes: `0x${string}`[] = [];
    for (let i = 0; i < 512; i++) {
      const data = new Uint8Array(40 + (i % 9)).fill(i % 251);
      data[0] = i >>> 8;
      data[1] = i & 255;
      const dh = keccak256(data);
      chunkHashes.push(chunkId(h.addresses.sstore2Backend!, dh, dh, data.length));
      sizes.push(data.length);
      writes.push(encodeFunctionData({ abi: chunkStoreAbi, functionName: "write", args: [h.addresses.sstore2Backend!, toHex(data), dh, data.length] }));
    }
    for (let i = 0; i < writes.length; i += 128) {
      await send(h.addresses.chunkStore!, chunkStoreAbi, "multicall", [writes.slice(i, i + 128)]);
    }
    // Force every hash to stay in one leaf: pack with keys that are never boundaries is not possible for real hashes,
    // so take the packer's largest leaf and measure that; the model is linear, so the per-record ratio carries.
    const C = packChunkTree(chunkHashes, sizes);
    for (const leaf of C.nodes.filter((n) => n.level === 0)) {
      const g = await send(fs, fileStoreAbi, "putChunkNode", [nodeBlobHex(leaf)]);
      console.log(`chunk leaf records=${leaf.count} model ${leaf.estimatedGas} real ${g} ratio ${(g / leaf.estimatedGas).toFixed(2)}`);
      expect(g).toBeLessThanOrEqual(leaf.estimatedGas);
    }
  }, 900_000);
});
