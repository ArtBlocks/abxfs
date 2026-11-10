import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const h = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown[] }[], locks: 0, writes: [] as boolean[] }));
const ORG = "0x00000000000000000000000000000000000000a1";
const ROOT = `0x${"ab".repeat(32)}`;
const COMMITMENT = `0x${"cd".repeat(32)}`;
vi.mock("../src/client.js", async () => {
  const { mockClient } = await import("./helpers/mock-client.js");
  const state = () => ({ selection: 0, method: 1, locks: h.locks, version: 0, frozenRoot: `0x${"00".repeat(32)}`, tag: "", path: "", chainBase: "https://chain.example/g/", ipfsBase: "https://ipfs.example/ipfs/", root: `0x${"ab".repeat(32)}`, targetError: null });
  const rec = (name: string) => async (...args: unknown[]) => { h.calls.push({ name, args }); return "0x12"; };
  return { createOrgClient: async (_chain: unknown, opts: { write?: boolean }) => {
    h.writes.push(opts.write === true);
    return mockClient({
      inspectPresentation: async () => state(), readPresentation: async () => state(),
      readPresentationLockCommitment: async () => `0x${"cd".repeat(32)}`,
      previewPresentation: async () => ({ ...state(), blockNumber: 123n, status: 0, contentType: "text/html", bytes: new Uint8Array([65]), residualDependencies: [], runtimeUncertain: false, recommendation: null }),
      configurePresentationTarget: rec("target"), setPresentationMethod: rec("method"),
      setPresentationEndpoints: rec("endpoints"), lockPresentation: rec("lock"),
      planUpload: async () => ({ rootCid: `0x${"cd".repeat(32)}` }),
      readProject: async () => ({ cid: `0x${"ab".repeat(32)}`, kind: 1, name: "project" }), update: rec("update"),
    });
  } };
});
vi.mock("@artblocks/abxfs-sdk", async (original) => ({
  ...await original<typeof import("@artblocks/abxfs-sdk")>(),
  recommendPresentationMethod: async () => ({ method: 1, reason: "small self-contained payload", residualDependencies: [], runtimeUncertain: false }),
}));
import { presentationCommand, parsePresentationMethod, parsePresentationLocks } from "../src/commands/presentation.js";
import { updateCommand } from "../src/commands/update.js";
const base = ["--project-id", "3", "--org", ORG, "--chain", "base-sepolia", "--json"];
let lines: string[];
const saved = { ...process.env };
beforeEach(() => {
  h.calls.length = 0; h.writes.length = 0; h.locks = 0; lines = [];
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  delete process.env["ABXFS_PRIVATE_KEY"];
  vi.spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });
const run = (args: string[]) => presentationCommand().parseAsync(args, { from: "user" });
describe("presentation CLI", () => {
  it("inspects generation-bound source and locks as one JSON object without a signer", async () => {
    h.locks = 3;
    await run(["inspect", ...base]);
    const result = JSON.parse(lines[0]!);
    expect(lines).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, source: { org: ORG, tokenId: "3" }, root: ROOT, methodName: "Embedded", lockNames: ["Content", "Method"] });
    expect(h.writes).toEqual([false]);
  });
  it("previews bytes and exact status without signing", async () => {
    await run(["preview", ...base]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ statusName: "Ready", contentType: "text/html", bytesHex: "0x41" });
    expect(h.writes).toEqual([false]);
  });
  it("dry-runs every mutation without requesting a signer or calling a write", async () => {
    for (const args of [["set-target", "--latest", "--path", "index.html"], ["set-method", "auto"], ["set-endpoints", "--chain-base", "https://chain.example/", "--ipfs-base", "https://ipfs.example/"], ["lock", "content,method"]]) {
      await run([...args, ...base, "--dry-run"]);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, dryRun: true });
    }
    expect(h.writes.every(value => !value)).toBe(true);
    expect(h.calls).toEqual([]);
  });
  it("resolves auto through the SDK and reports its reason and concrete mode", async () => {
    await run(["set-method", "auto", ...base, "--yes"]);
    expect(h.calls).toEqual([{ name: "method", args: [3n, 1] }]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).proposed).toMatchObject({ methodName: "Embedded", reason: "small self-contained payload" });
  });
  it("passes target and endpoint changes to the SDK", async () => {
    await run(["set-target", "--version", "2", "--path", "a.html", ...base, "--yes"]);
    await run(["set-endpoints", "--chain-base", "https://chain.example/", "--ipfs-base", "https://ipfs.example/", ...base, "--yes"]);
    expect(h.calls).toEqual([{ name: "target", args: [3n, { selection: 1, version: 2, path: "a.html" }] }, { name: "endpoints", args: [3n, { chainBase: "https://chain.example/", ipfsBase: "https://ipfs.example/" }] }]);
  });
  it("requires the reviewed settings commitment for real locks and preserves it in the SDK call", async () => {
    await expect(run(["lock", "content", ...base, "--yes"])).rejects.toThrow(/reviewed lock --dry-run/);
    await expect(run(["lock", "method", "--expected-commitment", ROOT, ...base, "--yes"])).rejects.toThrow(/does not match/);
    await run(["lock", "content,method", ...base, "--dry-run"]);
    expect(JSON.parse(lines[0]!).proposed).toMatchObject({ expectedCommitment: COMMITMENT, review: { blockNumber: "123", root: ROOT, statusName: "Ready", payloadBytes: 1 } });
    await run(["lock", "content,method", "--expected-commitment", COMMITMENT, ...base, "--yes"]);
    expect(h.calls).toEqual([{ name: "lock", args: [3n, 3, COMMITMENT] }]);
    expect(JSON.parse(lines.at(-1)!).permanent.join(" ")).toMatch(/permanent.*no force bypass/);
  });
  it("refuses a locked method even in a dry run, with no force bypass", async () => {
    h.locks = 2;
    await expect(run(["set-method", "ipfs", ...base, "--dry-run"])).rejects.toThrow(/permanently locked/);
    expect(h.calls).toEqual([]);
  });
  it("validates method and lock spellings", () => {
    expect(parsePresentationMethod("ipfs")).toBe(2);
    expect(parsePresentationLocks("content,endpoints")).toBe(5);
    expect(() => parsePresentationMethod("other")).toThrow(/method/);
    expect(() => parsePresentationLocks("force")).toThrow(/locks/);
  });
  it("dry-runs an existing project update without a signer or SDK update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abxfs-update-preview-"));
    try {
      writeFileSync(join(dir, "index.html"), "<p>hello</p>");
      await updateCommand().parseAsync([dir, ...base.filter(value => value !== "--json"), "--dry-run"], { from: "user" });
      expect(h.writes).toEqual([false]);
      expect(h.calls).toEqual([]);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ dryRun: true, existingRootCid: ROOT });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
