import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AbxfsClient } from "../src/abxfs.js";
import { autoRegisterNodeCodecs } from "../src/compression.js";
import {
  applyDraftToBase,
  diffRoots,
  executeDraftPublish,
  planPublish,
} from "../src/draft.js";
import { walkDirectoryTree } from "../src/read.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";
import type { DraftOp, FileDescriptor } from "../src/index.js";

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

const enc = new TextEncoder();
const baseFiles = (): FileDescriptor[] => [
  { path: "index.html", bytes: enc.encode("<!doctype html><h1>v1</h1>"), mimeType: "text/html" },
  { path: "app/main.js", bytes: enc.encode("console.log('v1');"), mimeType: "application/javascript" },
  { path: "README.md", bytes: enc.encode("# v1\n"), mimeType: "text/markdown" },
];

/**
 * Three tests below are skipped, and the reason is a missing FIXTURE, not missing behavior.
 *
 * They drive the pipeline through its final publish step, which writes the `abxfs.cid` PostParam on
 * an ABX token. That needs a deployed ABX collection, and standing one up means deploying ABX's
 * factories, renderer, minter and seed source on anvil — ABX-side infrastructure that an ABX FS test
 * harness has no business reproducing, and that would silently rot against ABX releases.
 *
 * What is NOT lost: the publish step's on-chain behavior (CID validation, kind lock, version
 * numbering, tags) is covered directly against the veto in
 * `packages/contracts-projects/test/ProjectHook.t.sol`, and the delta-upload path these tests
 * share is covered by the four chain-backed cases that still run here plus `upload.test.ts`.
 *
 * What IS lost: nothing asserts end-to-end that a draft's phases fire in order and land readable
 * content through `executeDraftPublish` specifically. Closing that needs an anvil fixture that
 * deploys an ABX collection.
 */
const NEEDS_ABX_COLLECTION = true;

describe("draft model: applyDraftToBase + planPublish + executeDraftPublish", () => {
  it("applyDraftToBase computes the same root as planUpload would for the merged set", async () => {
    const base = await client.upload(baseFiles());

    // Stage: edit README, add a new CHANGELOG, leave the rest alone.
    const ops: DraftOp[] = [
      { kind: "edit", path: "README.md", bytes: enc.encode("# v2\n"), mimeType: "text/markdown" },
      {
        kind: "add",
        path: "CHANGELOG.md",
        bytes: enc.encode("v2: breaking changes\n"),
        mimeType: "text/markdown",
      },
    ];

    const applied = await applyDraftToBase(
      harness.publicClient,
      harness.addresses,
      base.rootCid,
      ops,
    );

    // Cross-check: building the equivalent FileDescriptor set and running planUpload
    // should produce the same root CID.
    const merged: FileDescriptor[] = [
      ...baseFiles().filter((f) => f.path !== "README.md"),
      { path: "README.md", bytes: enc.encode("# v2\n"), mimeType: "text/markdown" },
      { path: "CHANGELOG.md", bytes: enc.encode("v2: breaking changes\n"), mimeType: "text/markdown" },
    ];
    const sanity = await client.diff(base.rootCid, merged);
    expect(applied.newRootCid).toBe(sanity.newRootCid);
  }, 120_000);

  it("planPublish reports zero work when ops cancel out (add then remove)", async () => {
    const base = await client.upload([
      { path: "a.txt", bytes: enc.encode("a"), mimeType: "text/plain" },
    ]);
    const ops: DraftOp[] = [
      { kind: "add", path: "b.txt", bytes: enc.encode("b"), mimeType: "text/plain" },
      { kind: "remove", path: "b.txt" },
    ];
    const applied = await applyDraftToBase(
      harness.publicClient,
      harness.addresses,
      base.rootCid,
      ops,
    );
    // Remove cancels out the add → only the original file remains, root CID unchanged.
    expect(applied.newRootCid).toBe(base.rootCid);
    const plan = await planPublish(harness.publicClient, harness.addresses, applied);
    expect(plan.chunksToWrite.length).toBe(0);
    expect(plan.filesToCreate.length).toBe(0);
    expect(plan.dirsToCreate.length).toBe(0);
  }, 60_000);

  it("planPublish dedupes against existing chunks (no rewrites for unchanged files)", async () => {
    const base = await client.upload(baseFiles());
    // Only edit README; index.html + app/main.js are unchanged → their chunks
    // already exist, so the plan should only flag README's chunks as new.
    const ops: DraftOp[] = [
      {
        kind: "edit",
        path: "README.md",
        bytes: enc.encode("# v3 totally different content here\n"),
        mimeType: "text/markdown",
      },
    ];
    const applied = await applyDraftToBase(
      harness.publicClient,
      harness.addresses,
      base.rootCid,
      ops,
    );
    const plan = await planPublish(harness.publicClient, harness.addresses, applied);
    // README is small so it's a single chunk. Plan should reflect that and not
    // touch chunks belonging to the unchanged files.
    const readmeChunkIds =
      applied.files.find((f) => f.path === "README.md")?.chunkIds ?? [];
    expect(plan.chunksToWrite.length).toBe(readmeChunkIds.length);
  }, 90_000);

  it.skipIf(NEEDS_ABX_COLLECTION)("end-to-end: draft + executeDraftPublish lands a new version on chain", async () => {
    const base = await client.upload(baseFiles());
    const name = "draft-e2e-" + Math.floor(Math.random() * 1e9);
    // A project is an ABX token in an org: `createOrg` mints token 0 to the creator, and the base root is its v1.
    const { org, firstTokenId: tokenId } = await client.createOrg({ name });
    const orgClient = client.forOrg(org);
    await orgClient.publishVersion(tokenId, base.rootCid);

    const ops: DraftOp[] = [
      { kind: "edit", path: "README.md", bytes: enc.encode("# v2\n"), mimeType: "text/markdown" },
      {
        kind: "add",
        path: "NOTICE",
        bytes: enc.encode("(c) 2026 ABX FS\n"),
        mimeType: "text/plain",
      },
    ];

    const applied = await applyDraftToBase(
      harness.publicClient,
      harness.addresses,
      base.rootCid,
      ops,
    );

    const phases: string[] = [];
    const result = await executeDraftPublish(
      { publicClient: harness.publicClient, walletClient: harness.walletClient },
      harness.addresses,
      { collection: org, hook: harness.addresses.projectHook! },
      tokenId,
      applied,
      {
        onPhase: (p) => phases.push(p),
      },
    );

    expect(result.versionNumber).toBe(2n);
    expect(result.newRootCid).toBe(applied.newRootCid);
    // Sanity: the contract reflects the new root.
    const proj = await orgClient.readProject(tokenId);
    expect(proj.cid).toBe(applied.newRootCid);
    // Verify content is readable through the standard read path.
    const readme = await client.readFileByPath(applied.newRootCid, "README.md");
    expect(new TextDecoder().decode(readme.bytes)).toBe("# v2\n");
    const notice = await client.readFileByPath(applied.newRootCid, "NOTICE");
    expect(new TextDecoder().decode(notice.bytes)).toBe("(c) 2026 ABX FS\n");
    // Phases must end with `complete` and pass through publishing-version.
    expect(phases).toContain("publishing-version");
    expect(phases[phases.length - 1]).toBe("complete");
  }, 180_000);

  it.skipIf(NEEDS_ABX_COLLECTION)("publishNewProject: lands a multi-file project in ≤ 4 wallet prompts (chunks+files+dirs+create)", async () => {
    // Three files in two directories — exercises every phase. One transaction per
    // write would be 3 chunk writes + 3 createFile + 2 createDirectory + the create
    // = 9 prompts; the pipeline batches each phase into one multicall, plus the
    // create tx = 4. We assert the upper bound, not the exact count, so the test is
    // robust against future inner-call additions that still fit one bundle.
    const name = "atomic-create-" + Math.floor(Math.random() * 1e9);
    const files: FileDescriptor[] = [
      {
        path: "index.html",
        bytes: enc.encode("<!doctype html><h1>multi-file</h1>"),
        mimeType: "text/html",
      },
      {
        path: "assets/app.js",
        bytes: enc.encode("console.log('multi-file');"),
        mimeType: "application/javascript",
      },
      {
        path: "assets/style.css",
        bytes: enc.encode("body{font-family:system-ui}"),
        mimeType: "text/css",
      },
    ];
    const phases: string[] = [];
    // Minting is its own step now: `createOrg` mints token 0, which this publishes into.
    const { org, firstTokenId: tokenId } = await client.createOrg({ name });
    const orgClient = client.forOrg(org);
    const result = await orgClient.publishNewProject({
      tokenId,
      name,
      files,
      tag: "v0.1.0", // exercises createProjectAndTag — single tx for create+tag
      opts: { onPhase: (p) => phases.push(p) },
    });
    // Atomic create+tag ⇒ exactly four phases for this layout: chunks, files,
    // dirs (root + assets/), create+tag. No separate "setting-tag" phase.
    expect(phases).toContain("writing-chunks");
    expect(phases).toContain("creating-files");
    expect(phases).toContain("creating-directories");
    expect(phases).toContain("publishing-version");
    expect(phases[phases.length - 1]).toBe("complete");
    expect(result.txHashes.length).toBeLessThanOrEqual(4);

    // Tag is attached to version 1 via the atomic helper — no second tx.
    const proj = await orgClient.readProject(result.tokenId);
    expect(proj.versionCount).toBe(1);
    const tag = await orgClient.readTag(result.tokenId, "v0.1.0");
    expect(tag.version).toBe(1);
    expect(tag.cid).toBe(result.rootCid);
  }, 180_000);

  it.skipIf(NEEDS_ABX_COLLECTION)("publishUpdate: lands version+tag (two txs — the tag is on the hook, not the collection)", async () => {
    const name = "atomic-update-" + Math.floor(Math.random() * 1e9);
    // Seed a v1 with no tag, into the token `createOrg` minted.
    const { org, firstTokenId: tokenId } = await client.createOrg({ name });
    const orgClient = client.forOrg(org);
    const create = await orgClient.publishNewProject({ tokenId, name, files: baseFiles() });
    expect(create.txHashes.length).toBeLessThanOrEqual(4);

    const baselineTxs = create.txHashes.length;

    const ops: DraftOp[] = [
      { kind: "edit", path: "README.md", bytes: enc.encode("# v2\n"), mimeType: "text/markdown" },
    ];
    const phases: string[] = [];
    const result = await orgClient.publishUpdate({
      tokenId: create.tokenId,
      baseRootCid: create.rootCid,
      ops,
      tag: "v0.2.0",
      opts: { onPhase: (p) => phases.push(p) },
    });
    expect(result.versionNumber).toBe(2n);
    // 1 chunk write + 1 file create + 1 dir create + 1 publishVersionAndTag = 4.
    // Asserting ≤ 4 covers the case where chunk dedup short-circuits some phases.
    expect(result.txHashes.length).toBeLessThanOrEqual(4);
    // Critically: NO separate "setting-tag" phase — atomic helper covers it.
    expect(phases).not.toContain("setting-tag");

    const tag = await orgClient.readTag(create.tokenId, "v0.2.0");
    expect(tag.version).toBe(2);

    void baselineTxs;
  }, 180_000);

  it("diffRoots: classifies added / removed / changed / unchanged correctly", async () => {
    const v1 = await client.upload([
      { path: "a.txt", bytes: enc.encode("alpha"), mimeType: "text/plain" },
      { path: "b.txt", bytes: enc.encode("bravo"), mimeType: "text/plain" },
      { path: "stable.txt", bytes: enc.encode("never changes"), mimeType: "text/plain" },
    ]);
    const v2 = await client.upload([
      { path: "a.txt", bytes: enc.encode("alpha v2"), mimeType: "text/plain" },
      { path: "stable.txt", bytes: enc.encode("never changes"), mimeType: "text/plain" },
      { path: "c.txt", bytes: enc.encode("charlie"), mimeType: "text/plain" },
    ]);

    const diff = await diffRoots(harness.publicClient, harness.addresses, v1.rootCid, v2.rootCid);
    expect(diff.added.map((e) => e.path)).toEqual(["c.txt"]);
    expect(diff.removed.map((e) => e.path)).toEqual(["b.txt"]);
    expect(diff.changed.map((e) => e.path)).toEqual(["a.txt"]);
    expect(diff.unchanged.map((e) => e.path)).toEqual(["stable.txt"]);
    // Reflexive: diffing a tree against itself yields no changes.
    const same = await diffRoots(harness.publicClient, harness.addresses, v1.rootCid, v1.rootCid);
    expect(same.changed.length).toBe(0);
    expect(same.added.length).toBe(0);
    expect(same.removed.length).toBe(0);
  }, 90_000);

  /**
   * Empty folders are part of a root, so an in-browser edit must keep the base's (it rebuilds the tree from the walk),
   * and a diff must say when they are the only difference.
   */
  it("an edit keeps the base's empty folders, a file fills one, and diffRoots reports empty-folder changes", async () => {
    const a = (text: string): FileDescriptor => ({ path: "a.txt", bytes: enc.encode(text), mimeType: "text/plain" });
    const base = await client.upload([a("alpha")], { emptyDirectories: ["assets/empty", "logs"] });

    const walked = await walkDirectoryTree(harness.publicClient, harness.addresses, base.rootCid);
    expect(walked.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect([...walked.emptyDirectories].sort()).toEqual(["assets/empty", "logs"]);

    const edited = await applyDraftToBase(harness.publicClient, harness.addresses, base.rootCid, [
      { kind: "edit", path: "a.txt", bytes: enc.encode("alpha v2"), mimeType: "text/plain" },
    ]);
    expect(edited.emptyDirectories).toEqual(["assets/empty", "logs"]);
    const reupload = await client.planUpload([a("alpha v2")], { emptyDirectories: ["assets/empty", "logs"] });
    expect(edited.newRootCid).toBe(reupload.rootCid);

    const filled = await applyDraftToBase(harness.publicClient, harness.addresses, base.rootCid, [
      { kind: "add", path: "logs/today.txt", bytes: enc.encode("entry"), mimeType: "text/plain" },
    ]);
    expect(filled.emptyDirectories).toEqual(["assets/empty"]);

    const other = await client.upload([a("alpha")], { emptyDirectories: ["logs", "new"] });
    const d = await diffRoots(harness.publicClient, harness.addresses, base.rootCid, other.rootCid);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
    expect(d.emptyDirectoriesAdded).toEqual(["new"]);
    expect(d.emptyDirectoriesRemoved).toEqual(["assets/empty"]);
  }, 120_000);
});
