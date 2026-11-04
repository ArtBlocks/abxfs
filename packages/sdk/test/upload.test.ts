import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";

import { AbxfsClient } from "../src/abxfs.js";
import { CODEC_BROTLI, CODEC_GZIP, CODEC_NONE, autoRegisterNodeCodecs } from "../src/compression.js";
import { ZERO_HASH } from "../src/cid.js";
import { packChunkTree, packDirectory, packFile } from "../src/nodes.js";
import { chunkStoreAbi, directoryStoreAbi, fileStoreAbi } from "../src/abi.js";
import { planUpload } from "../src/upload.js";
import { planBackendsFor, planFile, planUploadOffline } from "../src/plan.js";
import {
  ChunkUnavailableError,
  OutputHashMismatchError,
  getFileInfo,
} from "../src/read.js";
import { fromHex, toHex } from "../src/util.js";
import { deployCoreArtifact, startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";
import type { AbxfsCid, FileDescriptor } from "../src/types.js";

let harness: AnvilHarness;
let client: AbxfsClient;

beforeAll(async () => {
  await autoRegisterNodeCodecs();
  harness = await startAnvilWithAbxfs({ deployCompanion: true });
  client = new AbxfsClient({
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    addresses: harness.addresses,
  });
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

function files(): FileDescriptor[] {
  return [
    {
      path: "index.html",
      bytes: new TextEncoder().encode("<!doctype html><h1>hi</h1>"),
      mimeType: "text/html",
    },
    {
      path: "app/main.js",
      bytes: new TextEncoder().encode("console.log('hello');"),
      mimeType: "application/javascript",
    },
    {
      path: "app/style.css",
      bytes: new TextEncoder().encode("body{color:red}"),
      mimeType: "text/css",
    },
    {
      path: "README.md",
      bytes: new TextEncoder().encode("# hello\n"),
      mimeType: "text/markdown",
    },
  ];
}

/** Bytes FastLZ cannot shrink (a keccak stream). */
function noise(n: number, seed = "noise"): Uint8Array {
  const out = new Uint8Array(n);
  let h = keccak256(toBytes(seed));
  for (let o = 0; o < n; o += 32) {
    out.set(fromHex(h).slice(0, Math.min(32, n - o)), o);
    h = keccak256(h);
  }
  return out;
}

async function write(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await harness.walletClient.writeContract({ address, abi: abi as never, functionName, args } as never);
  const receipt = await harness.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

async function recordOf(id: AbxfsCid): Promise<{ backend: Address; size: number; dataHash: Hex }> {
  const [backend, size, , dataHash] = (await harness.publicClient.readContract({
    address: harness.addresses.chunkStore!,
    abi: chunkStoreAbi,
    functionName: "recordOf",
    args: [id],
  })) as readonly [Address, number | bigint, Hex, Hex];
  return { backend, size: Number(size), dataHash };
}

describe("AbxfsClient upload/read", () => {
  it("plans with matching root CID (no chain calls)", async () => {
    // Offline: the backends come from the address book; chunk ids are bound to them.
    const plan = await planUpload(files(), { addresses: harness.addresses });
    expect(plan.files.length).toBe(4);
    expect(plan.rootCid).toMatch(/^0x[0-9a-f]{64}$/);
    // Each file's CID is reproducible from its chunk ids, sizes and metadata.
    for (const f of plan.files) {
      expect(f.cid).toBe(
        packFile({ chunkIds: f.chunkIds, chunkSizes: f.chunkSizes, mimeType: f.mimeType, codec: f.codec, outputHash: f.outputHash }).cid,
      );
    }
    // The same plan with the backends passed explicitly.
    const explicit = await planUpload(files(), { backends: planBackendsFor(harness.addresses) });
    expect(explicit.rootCid).toBe(plan.rootCid);
  });

  it("planUpload rejects when no backend can be resolved", async () => {
    await expect(planUpload(files())).rejects.toThrow(/backends/);
    // An address book with no raw backend (a chain with no deployment) cannot plan.
    const noRaw = { ...harness.addresses, sstore2Backend: undefined as unknown as Address };
    await expect(planUpload(files(), { addresses: noRaw })).rejects.toThrow(/sstore2Backend/);
  });

  it("uploads a tree and round-trips file contents", async () => {
    const fs = files();
    const result = await client.upload(fs);
    expect(result.files.length).toBe(4);

    // Root directory CID matches pure planUpload computation.
    const plan = await planUpload(fs, { addresses: harness.addresses });
    expect(result.rootCid).toBe(plan.rootCid);

    // Read back each file by path.
    for (const f of fs) {
      const read = await client.readFileByPath(result.rootCid, f.path);
      expect(read.mimeType).toBe(f.mimeType);
      expect(new Uint8Array(read.bytes)).toEqual(f.bytes);
    }

    // walkDirectory returns all paths.
    const walked = await client.walkDirectory(result.rootCid);
    expect(walked.map((w) => w.path).sort()).toEqual(
      fs.map((f) => f.path).sort(),
    );
  }, 120_000);

  it("deduplicates: second upload is a no-op for chunks/files/dirs", async () => {
    const fs = files();
    const r1 = await client.upload(fs);
    const r2 = await client.upload(fs);
    expect(r2.rootCid).toBe(r1.rootCid);
    expect(r2.files.every((f) => f.existedOnChain)).toBe(true);
  }, 120_000);

  for (const [name, codec] of [
    ["gzip", CODEC_GZIP],
    ["br", CODEC_BROTLI],
  ] as const) {
    it(`round-trips a file under the ${name} file codec, checked against outputHash`, async () => {
      const data = new TextEncoder().encode(`hello ${name} `.repeat(2000));
      const result = await client.upload([{ path: `${name}.txt`, bytes: data, mimeType: "text/plain" }], { codec });
      expect(result.files[0]!.codec).toBe(codec);
      expect(result.files[0]!.outputHash).toBe(keccak256(data));
      const read = await client.readFileByPath(result.rootCid, `${name}.txt`);
      expect(read.codec).toBe(codec);
      expect(read.outputHash).toBe(keccak256(data));
      expect(new Uint8Array(read.bytes)).toEqual(data);
      // The stored data is the encoded stream, and every chunk of it went to the raw backend.
      expect(read.data.length).toBeLessThan(data.length);
      for (const id of read.chunkIds) expect((await recordOf(id)).backend).toBe(harness.addresses.sstore2Backend);
    }, 120_000);
  }

  /**
   * The file codec is decoded off chain, so its output is bound only by `outputHash`. A file registered over the same
   * chunks with a wrong `outputHash` is a legal record: the reader must refuse to return what it decodes to.
   */
  it("refuses a codec file whose decoded content does not hash to its outputHash", async () => {
    const data = new TextEncoder().encode("mismatch ".repeat(500));
    const result = await client.upload([{ path: "m.txt", bytes: data, mimeType: "text/plain" }], { codec: CODEC_GZIP });
    const good = result.files[0]!.cid;
    const { root } = await getFileInfo(harness.publicClient, harness.addresses, good);
    const wrong = keccak256(toBytes("not the content"));
    await write(harness.addresses.fileStore!, fileStoreAbi, "createFile", [root, "text/plain", CODEC_GZIP, wrong]);
    const bad = (await harness.publicClient.readContract({
      address: harness.addresses.fileStore!,
      abi: fileStoreAbi,
      functionName: "fileCid",
      args: [root, "text/plain", CODEC_GZIP, wrong],
    })) as AbxfsCid;
    expect(bad).not.toBe(good);
    await expect(client.readFile(bad)).rejects.toBeInstanceOf(OutputHashMismatchError);
    // The honest record over the same chunks still reads.
    expect(new Uint8Array((await client.readFile(good)).bytes)).toEqual(data);
  }, 120_000);

  it("stores a compressible chunk through FastLZ and the chain inflates it", async () => {
    const data = new TextEncoder().encode("the quick brown fox jumps over the lazy dog. ".repeat(400));
    const result = await client.upload([{ path: "fastlz.txt", bytes: data, mimeType: "text/plain" }]);

    // No file codec: per-chunk FastLZ is a backend choice, invisible in the CID's codec fields.
    const uploaded = result.files[0]!;
    expect(uploaded.codec).toBe(CODEC_NONE);
    expect(uploaded.outputHash).toBe(ZERO_HASH);
    expect(uploaded.storedBytesLength).toBeLessThan(data.length);

    // The crucial cross-check: `ChunkStore.write` only records a FastLZ chunk whose ON-CHAIN inflation hashes to the
    // planned dataHash, and `ChunkStore.read` serves the inflated bytes. So the SDK's JS compressor is byte-compatible
    // with the on-chain decompressor, or the upload would have reverted.
    const parts: Uint8Array[] = [];
    for (const id of uploaded.chunkIds) {
      expect((await recordOf(id)).backend).toBe(harness.addresses.fastLzBackend);
      const hex = (await harness.publicClient.readContract({
        address: harness.addresses.chunkStore!,
        abi: chunkStoreAbi,
        functionName: "read",
        args: [id],
      })) as Hex;
      parts.push(fromHex(hex));
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(data));
    const read = await client.readFileByPath(result.rootCid, "fastlz.txt");
    expect(new Uint8Array(read.bytes)).toEqual(data);
  }, 120_000);

  it("stores an incompressible chunk raw", async () => {
    const data = noise(3000);
    const result = await client.upload([{ path: "noise.bin", bytes: data, mimeType: "application/octet-stream" }]);
    const uploaded = result.files[0]!;
    expect(uploaded.storedBytesLength).toBe(data.length);
    for (const id of uploaded.chunkIds) expect((await recordOf(id)).backend).toBe(harness.addresses.sstore2Backend);
    expect(new Uint8Array((await client.readFile(uploaded.cid)).bytes)).toEqual(data);
  }, 120_000);

  /** The planner and `ChunkStore` must compute the same id from the same parts, or nothing an uploader plans exists. */
  it("chunk ids: the SDK formula equals ChunkStore.chunkId, and every written record recomputes to its id", async () => {
    const bytes = new Uint8Array([...noise(30_000, "mixed"), ...new TextEncoder().encode("abc".repeat(20_000))]);
    const planned = await planFile({ backends: planBackendsFor(harness.addresses), bytes, mimeType: "application/octet-stream" });
    const backends = new Set(planned.chunks.map((c) => c.backend));
    expect(backends).toEqual(new Set([harness.addresses.sstore2Backend, harness.addresses.fastLzBackend]));
    for (const c of planned.chunks) {
      const onChain = await harness.publicClient.readContract({
        address: harness.addresses.chunkStore!,
        abi: chunkStoreAbi,
        functionName: "chunkId",
        args: [c.backend, c.inputHash, c.dataHash, c.size],
      });
      expect(onChain).toBe(c.id);
    }
    const result = await client.upload([{ path: "mixed.bin", bytes, mimeType: "application/octet-stream" }]);
    expect(result.files[0]!.cid).toBe(planned.cid);
    for (const c of planned.chunks) {
      const r = await recordOf(c.id);
      expect([r.backend, r.size, r.dataHash]).toEqual([c.backend, c.size, c.dataHash]);
    }
  }, 120_000);

  it("diffs a changed file set and uploads only the delta", async () => {
    // This used to create a project and publish two versions. The project half needs a deployed ABX
    // collection (see the note in draft.test.ts); what it was really exercising is the diff + delta
    // upload, which is content-layer and needs no token.
    const fs = files();
    const up1 = await client.upload(fs);

    const newFiles: FileDescriptor[] = [
      ...fs,
      {
        path: "CHANGELOG.md",
        bytes: new TextEncoder().encode("# changelog\n"),
        mimeType: "text/markdown",
      },
    ];

    const diff = await client.diff(up1.rootCid, newFiles);
    expect(diff.rootChanged).toBe(true);
    expect(diff.changed.some((e) => e.path === "CHANGELOG.md" && e.kind === "added")).toBe(true);
    // Every pre-existing file must come back unchanged — that is what makes the delta a delta.
    expect(diff.unchanged.length).toBe(fs.length);

    const up2 = await client.upload(newFiles);
    expect(up2.rootCid).toBe(diff.newRootCid);
    expect(up2.rootCid).not.toBe(up1.rootCid);

    // Both roots stay independently readable: adding a file never disturbs the old tree.
    const oldReadme = await client.readFileByPath(up1.rootCid, "README.md");
    const newChangelog = await client.readFileByPath(up2.rootCid, "CHANGELOG.md");
    expect(new TextDecoder().decode(newChangelog.bytes)).toBe("# changelog\n");
    expect(oldReadme.bytes.byteLength).toBeGreaterThan(0);
    await expect(client.readFileByPath(up1.rootCid, "CHANGELOG.md")).rejects.toThrow();
  }, 180_000);

  /**
   * A chunk can live on a backend the EVM cannot read (a log backend, a blob, an off-chain store): `ChunkStore` records
   * its claims, and `read` refuses it. The reader must say so, and pass on where the backend says the bytes are,
   * rather than fail with an opaque revert.
   */
  it("a chunk on an unreadable backend throws ChunkUnavailableError naming the backend and its retrieval answer", async () => {
    const logBackend = await deployCoreArtifact(harness, "Backends.sol", "LogBackend");
    const input = new TextEncoder().encode("kept in a log, not in code");
    const h = keccak256(input) as AbxfsCid;
    await write(harness.addresses.chunkStore!, chunkStoreAbi, "write", [logBackend, toHex(input), h, input.length]);
    const id = (await harness.publicClient.readContract({
      address: harness.addresses.chunkStore!,
      abi: chunkStoreAbi,
      functionName: "chunkId",
      args: [logBackend, h, h, input.length],
    })) as AbxfsCid;
    const tree = packChunkTree([id], [input.length]);
    await write(harness.addresses.fileStore!, fileStoreAbi, "putChunkNode", [toHex(tree.nodes[0]!.blob)]);
    await write(harness.addresses.fileStore!, fileStoreAbi, "createFile", [tree.root, "text/plain", ZERO_HASH, ZERO_HASH]);
    const cid = packFile({ chunkIds: [id], chunkSizes: [input.length], mimeType: "text/plain" }).cid;

    const err = await client.readFile(cid).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkUnavailableError);
    const e = err as ChunkUnavailableError;
    expect(e.chunkId).toBe(id);
    expect(e.backend.toLowerCase()).toBe(logBackend.toLowerCase());
    expect(e.scheme).toBe("evm-log");
    expect(e.instructions).toMatch(/Stored\(bytes32,bytes\)/);
  }, 120_000);

  it("splits files larger than the backend maximum into multiple chunks", async () => {
    // The SSTORE2 input cap is 24,575 bytes; 60 KiB of incompressible data needs at least 3 chunks.
    const bytes = noise(60 * 1024, "big");
    const result = await client.upload([{ path: "big.bin", bytes, mimeType: "application/octet-stream" }]);
    const read = await client.readFileByPath(result.rootCid, "big.bin");
    expect(read.chunkIds.length).toBeGreaterThanOrEqual(3);
    expect(new Uint8Array(read.bytes)).toEqual(bytes);
  }, 120_000);

  it("the empty file and an empty directory upload and read back", async () => {
    const result = await client.upload([{ path: "e/.keep", bytes: new Uint8Array(0), mimeType: "text/plain" }], {
      emptyDirectories: ["void"],
    });
    const keep = await client.readFileByPath(result.rootCid, "e/.keep");
    expect(keep.bytes.length).toBe(0);
    expect(keep.chunkIds).toEqual([]);
    const voidDir = await client.resolvePath(result.rootCid, "void");
    expect(voidDir.isDirectory).toBe(true);
    expect((await client.readDirectory(voidDir.cid)).entries).toEqual([]);
  }, 120_000);
});

describe("AbxfsClient directory CID parity", () => {
  it("planUpload root CID matches a manually packed directory", async () => {
    const plan = await planUpload(files(), { addresses: harness.addresses });

    const rootFiles = new Map<string, AbxfsCid>();
    const appFiles = new Map<string, AbxfsCid>();
    for (const p of plan.files) {
      if (p.path.startsWith("app/")) appFiles.set(p.path.slice(4), p.cid);
      else rootFiles.set(p.path, p.cid);
    }

    const appDirCid = packDirectory([...appFiles.entries()].map(([name, cid]) => ({ name, cid, isDirectory: false }))).cid;
    const rootEntries = [
      ...[...rootFiles.entries()].map(([name, cid]) => ({ name, cid, isDirectory: false })),
      { name: "app", cid: appDirCid, isDirectory: true },
    ];
    expect(plan.rootCid).toBe(packDirectory(rootEntries).cid);
  });
});

/**
 * The offline plan must equal what a real upload writes.
 *
 * `planUploadOffline` and `uploadFiles` share `plan.ts`, so this is a regression guard on that sharing rather than a
 * coincidence check. It is the claim the whole module exists to make: a client can predict a root CID with no chain,
 * connect a wallet, and get exactly that root — including the directory CIDs in between, which is what makes the
 * predicted tree reachable rather than merely well-formed.
 */
describe("offline plan matches a real upload", () => {
  for (const [label, opts] of [
    ["per-chunk FastLZ", {}],
    ["raw only", { fastLz: false }],
    ["gzip file codec", { codec: CODEC_GZIP }],
  ] as const) {
    it(`agrees on every CID (${label})`, async () => {
      const input = files();
      const offline = await planUploadOffline(input, { backends: planBackendsFor(harness.addresses), ...opts });
      const real = await client.upload(input, opts);

      expect(real.rootCid).toBe(offline.rootCid);
      expect(real.files.map((f) => f.cid)).toEqual(offline.files.map((f) => f.cid));

      // Every planned directory must actually exist on chain after the upload. A mismatch here is
      // the dangerous shape: a valid-looking root whose children were never written.
      for (const dir of offline.directories) {
        const exists = await harness.publicClient.readContract({
          address: harness.addresses.directoryStore!,
          abi: directoryStoreAbi,
          functionName: "directoryExists",
          args: [dir.cid],
        });
        expect(exists, `planned directory "${dir.path}" (${dir.cid}) missing on chain`).toBe(true);
      }
    }, 120_000);
  }

  /** The uploader's own dry-run path must also agree — it is the third caller of the same planner. */
  it("agrees with the planUpload wrapper and the dry run", async () => {
    const input = files();
    const viaWrapper = await planUpload(input, { addresses: harness.addresses });
    const offline = await planUploadOffline(input, { backends: planBackendsFor(harness.addresses) });
    const dry = await client.upload(input, { dryRun: true });
    expect(viaWrapper.rootCid).toBe(offline.rootCid);
    expect(dry.rootCid).toBe(offline.rootCid);
    expect(dry.txHashes).toEqual([]);
  });
});
