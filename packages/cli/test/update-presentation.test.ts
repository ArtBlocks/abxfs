import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  supported: true, status: 0, readFails: false,
  update: vi.fn(), preview: vi.fn(), method: vi.fn(), target: vi.fn(), full: vi.fn(), planUpdate: vi.fn(), publishUpdate: vi.fn(),
}));
const ORG = "0x00000000000000000000000000000000000000a1";
vi.mock("../src/client.js", async () => {
  const { mockClient, CONTENT_ADDRESSES } = await import("./helpers/mock-client.js");
  return { createOrgClient: async () => mockClient({
    addresses: { ...CONTENT_ADDRESSES, ...(h.supported ? { projectPresentation: ORG } : {}) },
    readProject: async () => ({ cid: `0x${"ab".repeat(32)}`, kind: 1, name: "project" }),
    update: h.update,
    verifyPresentationTokenUri: h.full,
    planUpdate: h.planUpdate,
    publishUpdate: h.publishUpdate,
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
  h.method.mockReset().mockResolvedValue("0x03"); h.target.mockReset().mockResolvedValue("0x04");
  h.full.mockReset().mockResolvedValue({ok:true,status:"ready",callerGas:50_000_000n,reason:"complete metadata verified"});
  h.planUpdate.mockReset().mockResolvedValue({applied:{newRootCid:`0x${"cd".repeat(32)}`,emptyDirectories:["kept/empty"],files:[{path:"index.html",kind:"changed",newCid:`0x${"cd".repeat(32)}`},{path:"keep.webp",kind:"unchanged",newCid:`0x${"ef".repeat(32)}`}]}});
  h.publishUpdate.mockReset().mockResolvedValue({newRootCid:`0x${"cd".repeat(32)}`,publishTxHash:"0x05",versionNumber:2n});
  process.exitCode=0;
  vi.spyOn(console,"error").mockImplementation(()=>{});
  warnings = []; lines = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.join(" ")); });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...saved }; process.exitCode=0; vi.restoreAllMocks(); });
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
  it("warns on a failed complete tokenURI read while native preview is Ready, without a retry",async()=>{
    h.full.mockResolvedValue({ok:false,status:"read-failed",callerGas:50_000_000n,reason:"complete tokenURI caller budget exceeded"});
    await run();expectOnePublishedUpdate();expect(h.full).toHaveBeenCalledExactlyOnceWith(3n,{afterTransactionHash:"0x01"});
    expect(warnings.join("\n")).toContain("caller budget exceeded");
    expect(warnings.join("\n")).toContain("presentation set-method chain-gateway");
  });
  it("pins complete metadata verification to the final confirmed method change",async()=>{
    await updateCommand().parseAsync([dir,"--project-id","3","--org",ORG,"--yes","--presentation","embedded"],{from:"user"});
    expect(h.update).toHaveBeenCalledTimes(1);expect(h.method).toHaveBeenCalledExactlyOnceWith(3n,1);
    expect(h.full).toHaveBeenCalledExactlyOnceWith(3n,{afterTransactionHash:"0x03"});
  });
  it("reports a partial presentation failure as one recoverable JSON outcome after exactly one publication",async()=>{
    h.method.mockRejectedValue(new Error("method failed"));
    await updateCommand().parseAsync([dir,"--project-id","3","--org",ORG,"--yes","--presentation","embedded","--presentation-path","index.html","--json"],{from:"user"});
    const result=JSON.parse(lines.at(-1)!);
    expect(result).toMatchObject({ok:false,published:true,outcome:"published_presentation_pending",retryPublish:false,phase:"set-method"});
    expect(result.phases).toEqual([{phase:"set-target",txHash:"0x04"}]);
    expect(result.recovery[0]).toContain("presentation set-method embedded");expect(result.recovery[0]).not.toContain("update");
    expect(h.update).toHaveBeenCalledTimes(1);expect(h.method).toHaveBeenCalledTimes(1);expect(h.target).toHaveBeenCalledTimes(1);
  });
  it("delegates batch overlay to the SDK draft plan and executor while retaining omitted paths",async()=>{
    await updateCommand().parseAsync([dir,"--project-id","3","--org",ORG,"--yes","--overlay","--json"],{from:"user"});
    expect(h.planUpdate).toHaveBeenCalledTimes(1);expect(h.publishUpdate).toHaveBeenCalledTimes(1);expect(h.update).not.toHaveBeenCalled();
    expect(h.planUpdate.mock.calls[0]![0].ops).toEqual([expect.objectContaining({kind:"add",path:"index.html"})]);
    expect(h.publishUpdate.mock.calls[0]![0].applied.files).toContainEqual(expect.objectContaining({path:"keep.webp",kind:"unchanged"}));
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ok:true,published:true,contentMode:"overlay"});
  });
  it("does not query presentation for a legacy org", async () => {
    h.supported = false;
    await run();
    expect(h.update).toHaveBeenCalledTimes(1); expect(h.preview).not.toHaveBeenCalled();
    expect(h.method).not.toHaveBeenCalled(); expect(warnings).toEqual([]);
  });
});

it.each([false,true])("passes complete empty-directory evidence for snapshot/overlay update preflight (overlay=%s)",async overlay=>{
 if(!overlay) mkdirSync(join(dir,"local","empty"),{recursive:true});
 const target=overlay ? "kept" : "local";
 await updateCommand().parseAsync([dir,"--project-id","3","--org",ORG,"--yes","--json","--presentation","ipfs","--presentation-path",target,...(overlay ? ["--overlay"] : [])],{from:"user"});
 expect(JSON.parse(lines.at(-1)!)).toMatchObject({ok:true,published:true,outcome:"published",contentMode:overlay ? "overlay" : "snapshot"});
 expect(overlay ? h.publishUpdate : h.update).toHaveBeenCalledTimes(1);
 expect(h.target).toHaveBeenCalledExactlyOnceWith(3n,expect.objectContaining({path:target}));
});
