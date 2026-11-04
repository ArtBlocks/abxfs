/**
 * Delta audit: branches the fix round added that no test reached (the auditor's coverage of `abx-fs-freeze-2`). Each
 * `describe` names the file; each case says what the branch is for.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BaseError,
  HttpRequestError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { DirectoryNeedsShardingError, ZERO_HASH, ipfsDirectoryCid, ipfsFileCid } from "../../src/cid.js";
import { applyNewProject, executeDraftPublish, executeNewProjectPublish, uploadContent, type TxPlan } from "../../src/draft.js";
import { flzDecodeWork } from "../../src/fastlz.js";
import { LEGACY_GAS_SCHEDULE } from "../../src/gas-schedule.js";
import type { Bundle } from "../../src/gas.js";
import { LimitExceededError } from "../../src/limits.js";
import { sendBundles } from "../../src/multicall.js";
import { packFile } from "../../src/nodes.js";
import { planChunk } from "../../src/plan.js";
import { readTrackedTokens } from "../../src/project.js";
import { lookupEntry, planChunkReadSlices, readChunkSlices } from "../../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";
import { verifyLocalIpfsCid } from "../../src/verify.js";

const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
} as ContractAddresses;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const DIR = ("0x32" + "00".repeat(31)) as AbxfsCid;
const httpDown = () => new BaseError("request failed", { cause: new HttpRequestError({ url: "http://rpc.example", status: 503 }) });

describe("read.ts", () => {
  it("a name that is not UTF-8 is looked up as its bytes through `call`, and its answer decoded (lookupEntry, and the client's)", async () => {
    const calls: Hex[] = [];
    const client = {
      async call({ data }: { data: Hex }) {
        calls.push(data);
        return { data: encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }], [id(7), true]) };
      },
    } as unknown as PublicClient;
    expect(await lookupEntry(client, ADDRS, DIR, "\\xff")).toEqual({ cid: id(7), isDirectory: true });
    const abx = new AbxfsClient({ publicClient: client, addresses: ADDRS });
    expect(await abx.lookupEntry(DIR, Uint8Array.of(0xfe))).toEqual({ cid: id(7), isDirectory: true });
    expect(calls).toHaveLength(2);
  });

  it("the client's lookupEntry of UTF-8 text goes through readContract, as before", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        expect(functionName).toBe("lookup");
        expect(args[1]).toBe("index.html");
        return [id(9), false];
      }),
    } as unknown as PublicClient;
    expect(await new AbxfsClient({ publicClient: client, addresses: ADDRS }).lookupEntry(DIR, "index.html")).toEqual({ cid: id(9), isDirectory: false });
  });

  /** A ChunkStore: records `size` bytes on the raw backend; `read` answers by `reads`. */
  const store = (size: number, reads: (n: number) => Hex[] | Error, records: () => void = () => undefined) => {
    let calls = 0;
    const client = {
      async simulateContract({ args }: { args: [Hex[]] }) {
        calls++;
        const inner = args[0].map((data) => decodeFunctionData({ abi: chunkStoreAbi, data }));
        if (inner[0]!.functionName === "recordOf") {
          records();
          return {
            result: inner.map(() =>
              encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: [ADDRS.sstore2Backend, size, ZERO_HASH, ZERO_HASH] as never }),
            ),
          };
        }
        const r = reads(inner.length);
        if (r instanceof Error) throw r;
        return { result: r };
      },
    } as unknown as PublicClient;
    return { client, calls: () => calls };
  };
  const bytes = (n: number) => encodeAbiParameters([{ type: "bytes" }], [`0x${"ab".repeat(n)}`]);

  it("a failure of the connection while reading records, or chunks, is thrown at once, never halved", async () => {
    const recs = store(100, () => [], () => {
      throw httpDown();
    });
    await expect(readChunkSlices(recs.client, ADDRS, id(1), Array.from({ length: 100 }, (_, i) => id(i)), 1e9)).rejects.toThrow(/request failed/);
    expect(recs.calls()).toBe(1);
    const chunks = store(100, () => httpDown());
    await expect(readChunkSlices(chunks.client, ADDRS, id(1), [id(1), id(2), id(3)], 1e9)).rejects.toThrow(/request failed/);
    expect(chunks.calls()).toBe(1);
  });

  it("records that already exceed maxBytes refuse before a chunk is read; chunks that do are refused as they arrive", async () => {
    const planned = store(1000, () => {
      throw new Error("no chunk may be read");
    });
    const err = await readChunkSlices(planned.client, ADDRS, id(1), Array.from({ length: 100 }, (_, i) => id(i)), 50_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect((err as LimitExceededError).limit).toBe("bytes");
    expect(planned.calls()).toBe(1); // the records only

    const arriving = store(0, (n) => Array.from({ length: n }, () => bytes(100)));
    await expect(readChunkSlices(arriving.client, ADDRS, id(1), [id(1), id(2), id(3)], 250)).rejects.toMatchObject({ limit: "bytes" });
  });

  it("a chunk whose record could not be read is planned as the costliest chunk: a full FastLZ one at the worst stream", () => {
    const full = planChunkReadSlices([undefined, undefined], ADDRS);
    expect(full).toEqual([[0, 2]]);
    // 200 unknown records (delta audit round 2): each may be a full FastLZ chunk (3.1M at the worst stream), so 8 go to
    // a call, as 8 known full FastLZ chunks do. Priced as full RAW chunks (177k) they went 64 a call, ~200M of FastLZ.
    expect(planChunkReadSlices(Array.from({ length: 200 }, () => undefined), ADDRS)).toEqual(
      Array.from({ length: 25 }, (_, i) => [i * 8, i * 8 + 8]),
    );
    // Mixed with known FastLZ chunks, an unknown one counts as one more of them.
    const fastLz = { backend: ADDRS.fastLzBackend!, size: 24_575 };
    const mixed = planChunkReadSlices([...Array.from({ length: 7 }, () => fastLz), undefined, fastLz], ADDRS);
    expect(mixed).toEqual([[0, 8], [8, 9]]);
  });
});

describe("cid.ts", () => {
  it("a directory with one name twice is not a directory", async () => {
    const leaf = await ipfsFileCid(new Uint8Array([1]));
    await expect(
      ipfsDirectoryCid([
        { name: "a", cid: leaf, tsize: 1 },
        { name: "a", cid: leaf, tsize: 1 },
      ]),
    ).rejects.toThrow(/two entries have the same name/);
  });

  it("a Tsize dag-pb cannot encode is refused", async () => {
    const leaf = await ipfsFileCid(new Uint8Array([1]));
    for (const tsize of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(ipfsDirectoryCid([{ name: "a", cid: leaf, tsize }])).rejects.toThrow(/Tsize .* cannot be encoded/);
    }
  });
});

describe("verify.ts", () => {
  it("a directory IPFS would shard is refused from its listing, before any child is read", async () => {
    const names = Array.from({ length: 1200 }, (_, i) => `${String(i).padStart(6, "0")}-${"x".repeat(240)}`);
    const read: string[] = [];
    const client = {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        read.push(functionName);
        if (functionName === "getFileInfo") throw Object.assign(new Error("FileNotFound"), { name: "ContractFunctionRevertedError" });
        if (functionName === "fileExists") return false;
        if (functionName === "entryCount") return BigInt(names.length);
        if (functionName === "getEntries") {
          const [s, e] = [Number(args[1]), Number(args[2])];
          return names.slice(s, e).map((n, i) => ({ name: `0x${Buffer.from(n).toString("hex")}`, cid: id(s + i + 1), isDirectory: false }));
        }
        throw new Error(`unexpected ${functionName}`);
      },
    } as unknown as PublicClient;
    await expect(verifyLocalIpfsCid(client, ADDRS, DIR)).rejects.toThrow(DirectoryNeedsShardingError);
    expect(read.filter((f) => f === "getEntries").length).toBe(12);
    expect(read.filter((f) => f === "getChunkIds")).toHaveLength(0);
  });
});

describe("draft.ts: the executors check a plan handed in before any content is written", () => {
  const ME = "0x00000000000000000000000000000000000a11ce" as Address;
  const project = { collection: "0x00000000000000000000000000000000000000a1" as Address, hook: "0x00000000000000000000000000000000000000a2" as Address };
  const unset = ["0x" + "00".repeat(32), false, false];

  function rig() {
    const simulate = vi.fn();
    const write = vi.fn();
    const publicClient = {
      async multicall() {
        return [
          { status: "success", result: ME },
          { status: "success", result: unset },
        ];
      },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "fileStore") return ADDRS.fileStore;
        if (functionName === "directoryStore") return ADDRS.directoryStore;
        throw new Error(`unexpected ${functionName}`);
      },
      simulateContract: simulate,
    } as unknown as PublicClient;
    const walletClient = { account: { address: ME, type: "json-rpc" }, writeContract: write } as unknown as WalletClient;
    return { clients: { publicClient, walletClient }, simulate, write };
  }

  /** A plan holding one full raw chunk, which a 2M-gas block cannot store. */
  function oversizePlan(): TxPlan {
    const chunk = planChunk(new Uint8Array(24_000).fill(7), { raw: ADDRS.sstore2Backend! });
    return {
      chunksToWrite: [chunk],
      chunkNodesToCreate: [],
      filesToCreate: [],
      entryNodesToCreate: [],
      dirsToCreate: [],
      bundles: [],
      publishVersion: { estGas: 0n },
    };
  }
  const opts = { plan: oversizePlan(), gasSchedule: LEGACY_GAS_SCHEDULE, blockGasLimit: 2_000_000 };

  it("executeDraftPublish, executeNewProjectPublish and uploadContent refuse a chunk no transaction can store", async () => {
    const applied = await applyNewProject({} as never, ADDRS, [{ path: "a.txt", bytes: new Uint8Array([1]), mimeType: "text/plain" }]);
    const message = /a chunk of 24000 input bytes is more than one transaction can store on this network/;
    for (const run of [
      (r: ReturnType<typeof rig>) => executeDraftPublish(r.clients, ADDRS, project, 1n, applied, opts),
      (r: ReturnType<typeof rig>) => executeNewProjectPublish(r.clients, ADDRS, project, 1n, "name", applied, opts),
      (r: ReturnType<typeof rig>) => uploadContent(r.clients, ADDRS, [], { ...opts, applied }),
    ]) {
      const r = rig();
      await expect(run(r)).rejects.toThrow(message);
      expect(r.simulate).not.toHaveBeenCalled();
      expect(r.write).not.toHaveBeenCalled();
    }
  });
});

describe("project.ts: readTrackedTokens", () => {
  const client = (next: bigint) =>
    ({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        expect(functionName).toBe("nextTokenId");
        return next;
      }),
    }) as unknown as PublicClient;
  const contracts = { collection: "0x00000000000000000000000000000000000000a1" as Address, hook: "0x00000000000000000000000000000000000000a2" as Address };

  it("is the window of ids 0 … nextTokenId() - 1, clamped; undefined without an enumeration hook", async () => {
    const withEnum = { ...contracts, enumeration: "0x00000000000000000000000000000000000000e1" as Address };
    expect(await readTrackedTokens(client(5n), withEnum)).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(await readTrackedTokens(client(5n), withEnum, { start: 3n, limit: 10 })).toEqual([3n, 4n]);
    expect(await readTrackedTokens(client(5n), withEnum, { start: 1n, limit: 2 })).toEqual([1n, 2n]);
    expect(await readTrackedTokens(client(5n), withEnum, { start: 5n })).toEqual([]);
    expect(await readTrackedTokens(client(5n), withEnum, { limit: 0 })).toEqual([]);
    const none = client(5n);
    expect(await readTrackedTokens(none, contracts)).toBeUndefined();
    expect(none.readContract).not.toHaveBeenCalled();
  });
});

describe("multicall.ts: a split bundle keeps its state-gas split", () => {
  it("halves of a bundle that carried estimatedStateGas carry their own", async () => {
    const out = (() => new BaseError("out of gas")) as () => BaseError;
    const sent: Bundle[] = [];
    const publicClient = {
      async simulateContract({ args }: { args: [Hex[]] }) {
        if (args[0].length > 1) throw out();
        return { request: { args } };
      },
      async waitForTransactionReceipt() {
        return { status: "success" };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { type: "json-rpc", address: "0x00000000000000000000000000000000000000ee" },
      async writeContract() {
        return `0x${"ab".repeat(32)}` as Hex;
      },
    } as unknown as WalletClient;
    const calls = [1, 2].map((i) => ({ target: ADDRS.chunkStore!, data: `0x0${i}` as Hex, estimatedGas: 1_000_000, estimatedStateGas: 600_000 }));
    await sendBundles({ publicClient, walletClient }, [{ target: ADDRS.chunkStore!, calls, estimatedGas: 2_015_000, estimatedStateGas: 1_200_000 }], [] as never, {
      onBundleSent: (b) => sent.push(b),
    });
    expect(sent.map((b) => [b.calls.length, b.estimatedStateGas])).toEqual([
      [1, 600_000],
      [1, 600_000],
    ]);
  });
});

describe("nodes.ts: a file past what a chunk node can record", () => {
  it("is refused with the file's path, before any CID exists", () => {
    const chunks = [planChunk(new Uint8Array([1]), { raw: ADDRS.sstore2Backend! }), planChunk(new Uint8Array([2]), { raw: ADDRS.sstore2Backend! })];
    expect(() => packFile({ chunkIds: chunks.map((c) => c.id), chunkSizes: [2 ** 47, 2 ** 47], mimeType: "x/y", path: "big.bin" } as never)).toThrow(
      /the file "big\.bin" totals 281474976710656 bytes in one node, more than the 281474976710655 a chunk node can record/,
    );
    expect(() => packFile({ chunkIds: chunks.map((c) => c.id), chunkSizes: [2 ** 47, 2 ** 47], mimeType: "x/y" })).toThrow(/^this file totals/);
  });
});

describe("fastlz.ts: flzDecodeWork on long and truncated back-references", () => {
  it("a long match (type 7) adds its length byte; a truncated token counts as far as it goes", () => {
    // A literal run of 1 byte, then a long match: length 9 + 5 = 14 at distance 1 (one byte a step).
    expect(flzDecodeWork(Uint8Array.of(0x00, 0x41, 0xe0, 5, 0))).toEqual({ literals: 1, matches: 1, steps: 14 });
    // The same long match at distance 0x20 + 1 = 33: 32 bytes a step.
    expect(flzDecodeWork(Uint8Array.of(0xe0, 5, 0x20))).toEqual({ literals: 0, matches: 1, steps: 1 });
    // Truncated: a long match with no length or distance byte reads them as 0 (length 9, distance 1).
    expect(flzDecodeWork(Uint8Array.of(0xe0))).toEqual({ literals: 0, matches: 1, steps: 9 });
    // A short match (type 1, length 3) missing its distance byte: distance 1.
    expect(flzDecodeWork(Uint8Array.of(0x20))).toEqual({ literals: 0, matches: 1, steps: 3 });
  });
});
