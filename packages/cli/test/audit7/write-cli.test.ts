import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanForUpload } from "../../src/scan-guard.js";
import { planUploadOffline } from "../../../sdk/src/plan.js";
import { autoRegisterNodeCodecs } from "../../../sdk/src/compression.js";
import { fileCid } from "../../../sdk/src/nodes.js";

const dir = mkdtempSync(join(tmpdir(), "audit7-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const BACKENDS = { raw: "0x00000000000000000000000000000000000000b1", fastLz: "0x00000000000000000000000000000000000000b2" } as const;

describe("audit7 cli upload path", () => {
  it("secret scanner still refuses .env before any planning", async () => {
    writeFileSync(join(dir, ".env"), "PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n");
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    await expect(scanForUpload(dir, { includeHidden: true })).rejects.toThrow();
    await expect(scanForUpload(dir, { includeHidden: false, allowPublic: [] })).resolves.toBeTruthy();
  });

  /**
   * An empty file (a folder holding an `__init__.py`, say) is content like any other: a file with no chunks and a zero
   * root, whose CID is a constant that depends only on the mime type. It must not abort the upload.
   */
  it("an empty file in a folder passes the scanner and plans as the empty file", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "audit7b-"));
    writeFileSync(join(d2, "index.html"), "<p>hi</p>");
    writeFileSync(join(d2, "__init__.py"), "");
    const files = await scanForUpload(d2, {});
    expect(files.map((f) => f.path).sort()).toEqual(["__init__.py", "index.html"]);
    await autoRegisterNodeCodecs();
    const plan = await planUploadOffline(files.map((f) => ({ ...f, mimeType: f.mimeType ?? "text/plain" })), { backends: BACKENDS });
    const empty = plan.files.find((f) => f.path === "__init__.py")!;
    expect(empty.chunks).toEqual([]);
    expect(empty.cid).toBe(fileCid(`0x${"00".repeat(32)}`, empty.mimeType));
    rmSync(d2, { recursive: true, force: true });
  });
});
