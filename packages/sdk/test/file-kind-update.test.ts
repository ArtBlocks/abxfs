/**
 * Editing a file-kind project.
 *
 * Kind DERIVATION — which store holds a root, and the pre-flight guards on it — is covered against a
 * real chain in `file-kind.test.ts`. This file is about the update path built on top of that.
 *
 * `abxfs upload <file> --kind file` publishes a project whose root IS the file: no directory
 * anywhere in its tree. The web never creates one (uploads always fold through a directory), but it
 * has to read and edit them, because the kind is permanent — `ProjectHook` locks it on the
 * first publish, so such a project can never be migrated to a directory to make the ordinary path
 * work. It is either editable as a file or not editable at all.
 *
 * Before `applyFileReplacement`, it was the latter: the update path's first move is
 * `walkDirectory(baseRootCid)`, which reverts against a file root.
 */
import { describe, expect, it } from "vitest";

import { autoRegisterNodeCodecs, planDirectoryTree, planFile, type PlanBackends } from "../src/index.js";

await autoRegisterNodeCodecs();

const BACKENDS: PlanBackends = {
  raw: "0x00000000000000000000000000000000000000Aa",
  fastLz: "0x00000000000000000000000000000000000000Bb",
};
const BYTES = new TextEncoder().encode("<h1>single</h1>\n".repeat(50));

describe("a file root is not a directory root", () => {
  /**
   * The distinction the kind lock enforces, and the reason a file project cannot borrow the
   * directory update path: folding the same file into a tree produces a different CID entirely.
   */
  it("differs from the same file wrapped in a directory", async () => {
    const file = await planFile({ backends: BACKENDS, bytes: BYTES, mimeType: "text/html", fastLz: false, path: "index.html" });
    const wrapped = planDirectoryTree([{ path: "index.html", cid: file.cid }]).rootCid;

    expect(wrapped).not.toBe(file.cid);
  });

  /** A file root is the file's own CID, so publishing a new version means a new file CID. */
  it("changes root when the bytes change, with no directory involved", async () => {
    const v1 = await planFile({ backends: BACKENDS, bytes: BYTES, path: "f" });
    const v2 = await planFile({ backends: BACKENDS, bytes: new TextEncoder().encode("<h1>single v2</h1>\n".repeat(50)), path: "f" });

    expect(v2.cid).not.toBe(v1.cid);
  });

  /**
   * The same content stored differently (per-chunk FastLZ or raw) is a different file root — chunk ids commit to the
   * backend and the stored input. Worth pinning here because a file project's root has no directory layer to absorb
   * that.
   */
  it("changes root with the storage choice", async () => {
    const plain = await planFile({ backends: BACKENDS, bytes: BYTES, fastLz: false, path: "f" });
    const packed = await planFile({ backends: BACKENDS, bytes: BYTES, path: "f" });
    expect(packed.cid).not.toBe(plain.cid);
  });
});

describe("applyFileReplacement", () => {
  it("is exported for callers that must edit a file-kind project", async () => {
    const mod = await import("../src/draft.js");
    expect(typeof mod.applyFileReplacement).toBe("function");
  });

  /**
   * The structural guard. `collectDirEntries` must register NO directory when the root is the file
   * itself — folding one would invent a wrapping directory, changing the root the hook is asked to
   * accept, which the kind lock would then reject.
   */
  it("registers no directories for a file root", async () => {
    const { applyFileReplacement, collectContent, draftRootIsDirectory } = await import("../src/draft.js");
    const addresses = {
      sstore2Backend: BACKENDS.raw,
      fastLzBackend: BACKENDS.fastLz,
      chunkStore: "0x00000000000000000000000000000000000000c0",
      fileStore: "0x00000000000000000000000000000000000000f1",
      directoryStore: "0x00000000000000000000000000000000000000d1",
    } as never;
    const applied = await applyFileReplacement(
      {} as never,
      addresses,
      ("0x" + "11".repeat(32)) as never,
      { bytes: new TextEncoder().encode("one file"), mimeType: "text/plain" },
    );
    const { files, directories } = collectContent(applied);
    expect(directories).toEqual([]);
    expect(files.length).toBe(1);
    expect(files[0]!.cid).toBe(applied.newRootCid);
    expect(draftRootIsDirectory(applied)).toBe(false);
  });

  /** The ordinary path still walks a directory — this is an alternative, not a replacement. */
  it("leaves the directory path unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/draft.ts"), "utf8");
    expect(src).toMatch(/const base = await walkDirectoryTree\(publicClient, addresses, baseRootCid\)/);
  });
});
