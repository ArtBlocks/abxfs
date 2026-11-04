import { describe, expect, it } from "vitest";
import { planUpload } from "../../src/upload.js";
import { ZERO_HASH } from "../../src/cid.js";
import { fileCid } from "../../src/nodes.js";

/**
 * Audit 7 found that one zero-length file aborted the WHOLE upload with a bare message naming no path (the v1 and v2
 * contracts reverted `EmptyFile`). ABX FS has an empty file (root zero, no chunks), so the finding is closed by design:
 * this pins that an empty file plans alongside the others instead of aborting them.
 */
describe("audit7 zero-length file", () => {
  it("planUpload with one empty file plans every file, the empty one as root zero with no chunks", async () => {
    const backend = "0x1111111111111111111111111111111111111111" as const;
    const plan = await planUpload(
      [{ path: "empty.txt", bytes: new Uint8Array(0), mimeType: "text/plain" }, { path: "a.txt", bytes: new Uint8Array([1]), mimeType: "text/plain" }],
      { backends: { raw: backend } },
    );
    const empty = plan.files.find((f) => f.path === "empty.txt")!;
    expect(empty.chunkIds).toEqual([]);
    expect(empty.cid).toBe(fileCid(ZERO_HASH, "text/plain"));
    expect(plan.files.find((f) => f.path === "a.txt")!.chunkIds).toHaveLength(1);
  });
});
