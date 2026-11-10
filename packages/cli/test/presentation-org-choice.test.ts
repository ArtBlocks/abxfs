import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const h = vi.hoisted(() => ({ presentation: false, calls: [] as string[], scopedRegistries: [] as { previousGenerations?: unknown[] }[] }));
vi.mock("@artblocks/abxfs-sdk", async (original) => ({
  ...await original<typeof import("@artblocks/abxfs-sdk")>(),
  recommendPresentationMethod: async () => ({ method: 1, reason: "small payload", residualDependencies: [], runtimeUncertain: false }),
  readOrgsAdministeredAcrossGenerations: async (_client: unknown, registry: { previousGenerations?: unknown[] }) => {
    h.scopedRegistries.push(registry);
    return { orgs: [{ org: "0x00000000000000000000000000000000000000a1", name: "Current" }], failed: [], failedGenerations: [] };
  },
}));
vi.mock("../src/client.js", async () => {
  const { mockClient, CONTENT_ADDRESSES } = await import("./helpers/mock-client.js");
  const bound = (org: string) => mockClient({
    addresses: { ...CONTENT_ADDRESSES, ...(h.presentation ? { projectPresentation: "0x0000000000000000000000000000000000000cc1" } : {}), ...(org.endsWith("b1") ? { orgFactory: "0x0000000000000000000000000000000000000ff1", projectHook: "0x0000000000000000000000000000000000000bb2" } : {}) },
    configurePresentationTarget: async () => { h.calls.push("target:latest"); return "0x12"; },
    setPresentationMethod: async (_id: bigint, method: number) => { h.calls.push(`method:${method}`); return "0x12"; },
    inspectPresentation: async () => ({ root: `0x${"ab".repeat(32)}`, path: "", method: 1, locks: 0 }),
    readPresentation: async () => ({ locks: 0 }),
    mayMint: async () => true,
    assertCanPublish: async () => { h.calls.push(`owner:${org}`); },
    mintProject: async () => { h.calls.push(`mint:${org}`); return { tokenId: 1n }; },
    publishAndTag: async () => { h.calls.push(`publish:${org}`); return { versionNumber: 1n }; },
    setProjectName: async () => "0x12",
  });
  const client = mockClient({
    registry: { ...CONTENT_ADDRESSES, previousGenerations: [{ orgFactory: "0x0000000000000000000000000000000000000ff1", projectHook: "0x0000000000000000000000000000000000000bb2" }] },
    resolveOrg: async (org: string) => bound(org),
    planUpload: async () => ({ rootCid: `0x${"ab".repeat(32)}`, files: [] }),
    upload: async () => ({ rootCid: `0x${"ab".repeat(32)}`, txHashes: [] }),
  });
  return { createClient: () => client };
});
import { uploadCommand } from "../src/commands/upload.js";
const OLD_ORG = "0x00000000000000000000000000000000000000b1";
const CURRENT_ORG = "0x00000000000000000000000000000000000000a1";
const saved = { ...process.env };
let dir: string;
beforeEach(() => {
  h.calls.length = 0; h.scopedRegistries.length = 0; h.presentation = false;
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  process.env["ABXFS_ORG"] = OLD_ORG;
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "abxfs-current-org-"));
  writeFileSync(join(dir, "index.html"), "hello");
});
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
it("skips a remembered old-generation org and scopes administered discovery to the current factory", async () => {
  await uploadCommand().parseAsync([dir, "--name", "new", "--chain", "base-sepolia", "--yes"], { from: "user" });
  expect(h.scopedRegistries).toHaveLength(1);
  expect(h.scopedRegistries[0]!.previousGenerations).toEqual([]);
  expect(h.calls).toEqual([`mint:${CURRENT_ORG}`, `publish:${CURRENT_ORG}`]);
});
it("preserves an explicitly selected old project and resolves its original generation", async () => {
  await uploadCommand().parseAsync([dir, "--project-id", "3", "--org", OLD_ORG, "--chain", "base-sepolia", "--yes"], { from: "user" });
  expect(h.scopedRegistries).toEqual([]);
  expect(h.calls).toEqual([`owner:${OLD_ORG}`, `publish:${OLD_ORG}`]);
});

it("configures a new supported file or directory project with SDK auto and preserves existing project methods", async () => {
  h.presentation = true;
  await uploadCommand().parseAsync([dir, "--name", "new", "--org", CURRENT_ORG, "--chain", "base-sepolia", "--yes"], { from: "user" });
  expect(h.calls).toEqual([`mint:${CURRENT_ORG}`, `publish:${CURRENT_ORG}`, "target:latest", "method:1"]);
  h.calls.length = 0;
  await uploadCommand().parseAsync([dir, "--project-id", "3", "--org", CURRENT_ORG, "--chain", "base-sepolia", "--yes"], { from: "user" });
  expect(h.calls).toEqual([`owner:${CURRENT_ORG}`, `publish:${CURRENT_ORG}`]);
});
it("uses IPFS only when the upload explicitly requests it", async () => {
  h.presentation = true;
  await uploadCommand().parseAsync([dir, "--name", "new", "--org", CURRENT_ORG, "--presentation", "ipfs", "--chain", "base-sepolia", "--yes"], { from: "user" });
  expect(h.calls).toContain("method:2");
});
