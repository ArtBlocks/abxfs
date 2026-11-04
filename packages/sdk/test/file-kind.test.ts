/**
 * File-kind vs directory-kind content, against a real chain.
 *
 * An ABX FS root is either a single file or a directory, and the distinction is not encoded in the CID
 * — an ABX FS CID is a bare keccak256 hash, so the only authority is which store holds it. These tests
 * exercise that derivation and the client-side guards built on it.
 *
 * The *project-level* consequences of kind — the lock across versions, the `RootKindLocked` revert —
 * moved to `ProjectHook` and are tested in Solidity
 * (`packages/contracts-projects/test/ProjectHook.t.sol`), where they can be asserted directly
 * against the veto rather than through a full ABX deployment on anvil. What remains here is what the
 * SDK itself owns: kind derivation from the stores, and the pre-flight checks that fail before any
 * gas is spent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AbxfsClient } from "../src/abxfs.js";
import { autoRegisterNodeCodecs } from "../src/compression.js";
import { ProjectKind, asAbxfsCid } from "../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";
import type { Address } from "viem";

import type { FileDescriptor } from "../src/types.js";

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

/**
 * The guards below reject before a project contract is ever addressed, so these addresses are never
 * called. Using obvious placeholders makes that explicit — if a guard regresses and a real call goes
 * out, it fails loudly against a codeless address instead of quietly hitting something real.
 */
const UNUSED_PROJECT = {
  collection: "0x000000000000000000000000000000000c0ffee0" as Address,
  hook: "0x000000000000000000000000000000000000d00d" as Address,
};

function htmlFile(body: string): FileDescriptor {
  return { path: "index.html", bytes: new TextEncoder().encode(body), mimeType: "text/html" };
}

describe("kind derivation", () => {
  it("uploadFile produces a file-kind root registered in FileStore", async () => {
    const result = await client.uploadFile(htmlFile("<!doctype html><h1>v1</h1>"));
    expect(result.files.length).toBe(1);
    expect(result.rootKind).toBe("file");
    expect(result.rootCid).toBe(result.files[0]!.cid);

    expect(await client.cidKind(result.rootCid)).toBe(ProjectKind.File);
  }, 120_000);

  it("upload produces a directory-kind root registered in DirectoryStore", async () => {
    const result = await client.upload([htmlFile("<!doctype html><h1>dir</h1>")]);
    expect(result.rootKind).toBe("directory");
    expect(await client.cidKind(result.rootCid)).toBe(ProjectKind.Directory);
  }, 120_000);

  /**
   * `Unset`, not `null`. It is the same value `ProjectHook.kindOf` returns for a project that
   * has never published, so a caller can compare a loose CID's kind against a project's locked kind
   * without translating between two encodings.
   */
  it("reports Unset for a CID in neither store", async () => {
    const unknown = asAbxfsCid(`0x${"00".repeat(32)}`);
    expect(await client.cidKind(unknown)).toBe(ProjectKind.Unset);
  }, 60_000);
});

describe("update() kind guards", () => {
  // These fire before any transaction is built. The binding check is the configure hook, which
  // re-derives the kind on-chain — but reverting there costs gas, and the shape mismatch is fully
  // knowable from the existing root.

  it("rejects array content against a file-kind root", async () => {
    const upload = await client.uploadFile(htmlFile("<!doctype html><h1>v1</h1>"));
    await expect(
      client.update({
        project: UNUSED_PROJECT,
        tokenId: 1n,
        existingRootCid: upload.rootCid,
        newContent: [htmlFile("<!doctype html><h1>v2</h1>")],
      }),
    ).rejects.toThrow(/file-kind .* array/i);
  }, 120_000);

  it("rejects single-file content against a directory-kind root", async () => {
    const upload = await client.upload([htmlFile("<!doctype html><h1>v1</h1>")]);
    await expect(
      client.update({
        project: UNUSED_PROJECT,
        tokenId: 1n,
        existingRootCid: upload.rootCid,
        newContent: htmlFile("<!doctype html><h1>v2</h1>"),
      }),
    ).rejects.toThrow(/directory-kind .* single/i);
  }, 120_000);

  it("rejects a root that is in neither store", async () => {
    await expect(
      client.update({
        project: UNUSED_PROJECT,
        tokenId: 1n,
        existingRootCid: asAbxfsCid(`0x${"11".repeat(32)}`),
        newContent: htmlFile("<!doctype html><h1>v2</h1>"),
      }),
    ).rejects.toThrow(/not registered in either content store/i);
  }, 120_000);
});
