/**
 * The dry-run, the real uploader, and the draft path must produce the same CIDs.
 *
 * This is the test that replaces a comment. Before `plan.ts`, the codec → chunk → hash → CID
 * pipeline existed in four places, one of which was annotated "mirrors `planUpload` exactly." That
 * kind of claim fails silently: each copy keeps producing well-formed CIDs, so a drifted dry-run
 * predicts a root the upload will never write, and a drifted draft previews a tree whose parent
 * points at children that were never created.
 *
 * These run with no chain — the agreement is arithmetic, so proving it needs no node.
 */
import { describe, expect, it } from "vitest";

import {
  CODEC_GZIP,
  EMPTY_DIRECTORY,
  ZERO_HASH,
  autoRegisterNodeCodecs,
  keccak256Hex,
  packDirectory,
  planBackendsFor,
  planDirectoryTree,
  planFile,
  planUploadOffline,
  sortDirectoryEntries,
} from "../src/index.js";
import type { AbxfsCid, FileDescriptor, PlanBackends } from "../src/index.js";

await autoRegisterNodeCodecs();

const BACKENDS: PlanBackends = {
  raw: "0x00000000000000000000000000000000000000Aa",
  fastLz: "0x00000000000000000000000000000000000000Bb",
  maxInputSize: 4096,
};

function file(path: string, body: string, mimeType?: string): FileDescriptor {
  // Deliberately leaves `mimeType` off when not given (the type requires it) so the planner's inference from the
  // path is what gets exercised.
  return { path, bytes: new TextEncoder().encode(body), ...(mimeType ? { mimeType } : {}) } as FileDescriptor;
}

/** Deliberately includes nesting, a shared-content pair, and a file larger than one chunk. */
const FILES: FileDescriptor[] = [
  file("index.html", "<h1>root</h1>"),
  file("lib/util.js", "export const x = 1;\n".repeat(500)),
  file("lib/nested/deep.txt", "deep"),
  file("copy-a.txt", "identical content here"),
  file("copy-b.txt", "identical content here"),
];

describe("planFile is the single implementation", () => {
  for (const fastLz of [true, false]) {
    it(`agrees with itself across calls (fastLz ${fastLz})`, async () => {
      const bytes = FILES[1]!.bytes;
      const a = await planFile({ backends: BACKENDS, bytes, fastLz, path: "a.js" });
      const b = await planFile({ backends: BACKENDS, bytes, fastLz, path: "a.js" });
      expect(a.cid).toBe(b.cid);
      expect(a.chunkIds).toEqual(b.chunkIds);
    });
  }

  /**
   * The backend is mixed into every chunk-id preimage, so this is not a configuration difference —
   * it is a different content-address space, and the CIDs must not collide.
   */
  it("produces different CIDs for a different backend", async () => {
    const bytes = FILES[0]!.bytes;
    const a = await planFile({ backends: BACKENDS, bytes });
    const b = await planFile({ backends: { ...BACKENDS, raw: "0x00000000000000000000000000000000000000Ab" }, bytes });
    expect(a.cid).not.toBe(b.cid);
  });

  /** Per-chunk FastLZ changes where and how the chunks are kept, so it changes their ids and the CID; never the content. */
  it("changes the CID with per-chunk FastLZ, never the logical size", async () => {
    const bytes = FILES[1]!.bytes;
    const plain = await planFile({ backends: BACKENDS, bytes, fastLz: false });
    const packed = await planFile({ backends: BACKENDS, bytes });
    expect(packed.cid).not.toBe(plain.cid);
    expect(packed.storedSize).toBeLessThan(plain.storedSize);
    // Logical size is what a reader gets back and must be invariant; without a file codec so is the data.
    expect(packed.logicalSize).toBe(plain.logicalSize);
    expect(packed.dataSize).toBe(plain.dataSize);
  });

  it("records ZERO_HASH as the output hash unless a file codec is set, and then keccak256(content)", async () => {
    const bytes = FILES[1]!.bytes;
    const plain = await planFile({ backends: BACKENDS, bytes, fastLz: false });
    const packed = await planFile({ backends: BACKENDS, bytes });
    const gz = await planFile({ backends: BACKENDS, bytes, codec: CODEC_GZIP });
    expect(plain.outputHash).toBe(ZERO_HASH);
    expect(packed.outputHash).toBe(ZERO_HASH);
    expect(gz.outputHash).toBe(keccak256Hex(bytes));
    expect(gz.codec).toBe(CODEC_GZIP);
    expect(gz.dataSize).toBeLessThan(gz.logicalSize);
  });
});

describe("planDirectoryTree", () => {
  it("returns nodes children-first, the only order they can be created in", () => {
    const files = FILES.map((f, i) => ({ path: f.path, cid: `0x${String(i).padStart(64, "0")}` as AbxfsCid }));
    const { directories, rootCid } = planDirectoryTree(files);

    // The root is last: a parent's CID commits to its children's, so children must exist first.
    expect(directories[directories.length - 1]!.cid).toBe(rootCid);
    expect(directories[directories.length - 1]!.path).toBe("");

    const seen = new Set<string>();
    for (const dir of directories) {
      for (const e of dir.entries) {
        // Every directory entry must already have been emitted.
        if (e.isDirectory) expect(seen.has(e.cid)).toBe(true);
      }
      seen.add(dir.cid);
    }
  });

  it("names nested directories by their full path", () => {
    const { directories } = planDirectoryTree(
      FILES.map((f, i) => ({ path: f.path, cid: `0x${String(i).padStart(64, "0")}` as AbxfsCid })),
    );
    const paths = directories.map((d) => d.path).sort();
    expect(paths).toEqual(["", "lib", "lib/nested"]);
  });

  it("emits entries in the sorted order the contract requires", () => {
    const { directories } = planDirectoryTree([
      { path: "z.txt", cid: `0x${"11".repeat(32)}` as AbxfsCid },
      { path: "a.txt", cid: `0x${"22".repeat(32)}` as AbxfsCid },
      { path: "m.txt", cid: `0x${"33".repeat(32)}` as AbxfsCid },
    ]);
    const root = directories.find((d) => d.path === "")!;
    expect(root.entries).toEqual(sortDirectoryEntries([...root.entries]));
    expect(packDirectory(root.entries).cid).toBe(root.cid);
  });

  /** ABX FS has a CID for the empty directory, and it exists on chain without being created. */
  it("an empty tree is the empty directory", () => {
    const { rootCid, directories } = planDirectoryTree([]);
    expect(rootCid).toBe(EMPTY_DIRECTORY);
    expect(directories).toHaveLength(1);
    expect(directories[0]!.tree.nodes).toEqual([]);
  });

  it("empty directories nest, and each is the empty directory", () => {
    const { rootCid, directories } = planDirectoryTree([], { emptyDirectories: ["a/b"] });
    expect(directories.find((d) => d.path === "a/b")!.cid).toBe(EMPTY_DIRECTORY);
    const a = directories.find((d) => d.path === "a")!;
    expect(a.entries).toEqual([{ name: "b", cid: EMPTY_DIRECTORY, isDirectory: true }]);
    expect(rootCid).toBe(packDirectory([{ name: "a", cid: a.cid, isDirectory: true }]).cid);
  });

  it("is insensitive to input order", () => {
    const pairs = FILES.map((f, i) => ({ path: f.path, cid: `0x${String(i).padStart(64, "0")}` as AbxfsCid }));
    const a = planDirectoryTree(pairs).rootCid;
    const b = planDirectoryTree([...pairs].reverse()).rootCid;
    expect(a).toBe(b);
  });
});

describe("planUploadOffline", () => {
  it("dedups identical chunks across files", async () => {
    const plan = await planUploadOffline(FILES, { backends: BACKENDS, fastLz: false });

    const totalChunks = plan.files.reduce((n, f) => n + f.chunkIds.length, 0);
    // copy-a.txt and copy-b.txt are byte-identical, so the upload stores one fewer chunk than the
    // per-file counts suggest. This is the number that determines what an upload actually costs.
    expect(plan.uniqueChunks).toBeLessThan(totalChunks);

    const a = plan.files.find((f) => f.path === "copy-a.txt")!;
    const b = plan.files.find((f) => f.path === "copy-b.txt")!;
    expect(a.cid).toBe(b.cid);
  });

  it("reports a root matching an independent fold of its own file CIDs", async () => {
    const plan = await planUploadOffline(FILES, { backends: BACKENDS });
    const refold = planDirectoryTree(plan.files.map((f) => ({ path: f.path, cid: f.cid }))).rootCid;
    expect(plan.rootCid).toBe(refold);
  });

  it("is deterministic", async () => {
    const a = await planUploadOffline(FILES, { backends: BACKENDS });
    const b = await planUploadOffline(FILES, { backends: BACKENDS });
    expect(a.rootCid).toBe(b.rootCid);
    expect(a.storedBytes).toBe(b.storedBytes);
    expect(a.uniqueChunks).toBe(b.uniqueChunks);
  });

  /** A smaller input cap means more chunks, and the CID commits to the chunk list. */
  it("changes the root when the backends' maxInputSize changes", async () => {
    const small = await planUploadOffline(FILES, { backends: { ...BACKENDS, maxInputSize: 512 } });
    const large = await planUploadOffline(FILES, { backends: { ...BACKENDS, maxInputSize: 16_384 } });
    expect(small.rootCid).not.toBe(large.rootCid);
  });

  it("optionally derives IPFS CIDs, which are invariant under per-chunk FastLZ and a file codec", async () => {
    const plain = await planUploadOffline(FILES, { backends: BACKENDS, fastLz: false, ipfsCids: true });
    const packed = await planUploadOffline(FILES, { backends: BACKENDS, ipfsCids: true });
    const gz = await planUploadOffline(FILES, { backends: BACKENDS, codec: CODEC_GZIP, ipfsCids: true });
    // The ABX FS roots differ (stored chunks differ) while every IPFS CID matches (content).
    expect(packed.rootCid).not.toBe(plain.rootCid);
    expect(gz.rootCid).not.toBe(plain.rootCid);
    expect(packed.ipfsCids).toEqual(plain.ipfsCids);
    expect(gz.ipfsCids).toEqual(plain.ipfsCids);
  });

  it("rejects a path that escapes the tree", async () => {
    await expect(planUploadOffline([file("../escape.txt", "no")], { backends: BACKENDS })).rejects.toThrow();
  });
});

describe("planBackendsFor", () => {
  it("resolves the raw and FastLZ backends from an address book, with the SSTORE2 input cap", () => {
    expect(planBackendsFor({ sstore2Backend: BACKENDS.raw, fastLzBackend: BACKENDS.fastLz! })).toEqual({
      raw: BACKENDS.raw,
      fastLz: BACKENDS.fastLz,
      maxInputSize: 24_575,
    });
    // No FastLZ backend: every chunk goes raw.
    expect(planBackendsFor({ sstore2Backend: BACKENDS.raw } as never).fastLz).toBeUndefined();
  });

  it("explains why a backend is mandatory rather than defaulting", () => {
    expect(() => planBackendsFor({} as never)).toThrow(/bound to the backend address/);
  });
});
