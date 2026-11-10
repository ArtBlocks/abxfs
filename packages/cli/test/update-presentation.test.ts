import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  supported: true, status: 0, readFails: false,
  update: vi.fn(), preview: vi.fn(), method: vi.fn(), target: vi.fn(),
}));
const ORG = "0x00000000000000000000000000000000000000a1";
vi.mock("../src/client.js", async () => {
  const { mockClient, CONTENT_ADDRESSES } = await import("./helpers/mock-client.js");
  return { createOrgClient: async () => mockClient({
    addresses: { ...CONTENT_ADDRESSES, ...(h.supported ? { projectPresentation: ORG } : {}) },
    readProject: async () => ({ cid: `0x${"ab".repeat(32)}`, kind: 1, name: "project" }),
    update: h.update,
    previewPresentation: h.preview,
    setPresentationMethod: h.method,
    configurePresentationTarget: h.target,
    readTokenLinks: async () => ({ animationUrl: "", externalUrl: "https://example.com" }),
  }) };
});
import { PresentationStatus } from "@artblocks/abxfs-sdk";
import { updateCommand } from "../src/commands/update.js";

const saved = { ...process.env };
let dir: string;
let warnings: string[];
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-update-presentation-"));
  writeFileSync(join(dir, "index.html"), "<p>updated</p>");
  process.env["ABXFS_CONFIG"] = join(dir, "missing.json");
  process.env["ABXFS_CHAIN"] = "base-sepolia";
  h.supported = true; h.status = PresentationStatus.Ready; h.readFails = false;
  h.update.mockReset().mockResolvedValue({ newRootCid: `0x${"cd".repeat(32)}`, txHash: "0x01", versionNumber: 2n });
  h.preview.mockReset().mockImplementation(async () => {
    if (h.readFails) throw new Error("RPC failed https://rpc.example/v2/secret-provider-key");
    return { status: h.status };
  });
  h.method.mockReset(); h.target.mockReset();
  warnings = []; lines = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.join(" ")); });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...saved }; vi.restoreAllMocks(); });
const run = () => updateCommand().parseAsync([dir, "--project-id", "3", "--org", ORG, "--yes"], { from: "user" });
function expectOnePublishedUpdate() {
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledExactlyOnceWith(3n);
  expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.preview.mock.invocationCallOrder[0]!);
  expect(h.method).not.toHaveBeenCalled(); expect(h.target).not.toHaveBeenCalled();
  expect(lines.join("\n")).toContain("new version: v2");
}

describe("update preserves presentation and diagnoses it after success", () => {
  it.each([PresentationStatus.OverBudget, PresentationStatus.UnsupportedCodec])("warns for status %s without changing presentation or resending the successful update", async (status) => {
    h.status = status;
    await expect(run()).resolves.toBeDefined();
    expectOnePublishedUpdate();
    const text = warnings.join("\n");
    expect(text).toContain(PresentationStatus[status]);
    expect(text).toContain("Published successfully");
    expect(text).toContain("do not rerun update");
    const flags = `--project-id 3 --org ${ORG} --chain base-sepolia`;
    expect(text).toContain(`abxfs presentation preview ${flags}`);
    expect(text).toContain(`abxfs presentation set-method chain-gateway ${flags}`);
  });
  it("keeps publication successful when the preview read fails, with redacted recovery output", async () => {
    h.readFails = true;
    await expect(run()).resolves.toBeDefined();
    expectOnePublishedUpdate();
    expect(warnings.join("\n")).toContain("could not preview presentation");
    expect(warnings.join("\n")).not.toContain("secret-provider-key");
    expect(warnings.join("\n")).toContain("abxfs presentation preview");
  });
  it("does not warn when the preserved presentation remains Ready", async () => {
    await run(); expectOnePublishedUpdate(); expect(warnings).toEqual([]);
  });
  it("does not query presentation for a legacy org", async () => {
    h.supported = false;
    await run();
    expect(h.update).toHaveBeenCalledTimes(1); expect(h.preview).not.toHaveBeenCalled();
    expect(h.method).not.toHaveBeenCalled(); expect(warnings).toEqual([]);
  });
});
