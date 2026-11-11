import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  fail: "" as "" | "set-target" | "set-method" | "inspect-result" | "set-name" | "readback-version" | "setting-tag",
  calls: [] as string[], inspections: 0, targetError: "", refusal: false, versionCount:1, configuredFlags:0,
}));
vi.mock("@artblocks/abxfs-sdk", async original => ({
  ...await original<typeof import("@artblocks/abxfs-sdk")>(),
  recommendPresentationMethod: async () => ({ method: 1, reason: "small payload", residualDependencies: [], runtimeUncertain: false }),
}));
vi.mock("../../src/client.js", async () => {
  const { mockClient, CONTENT_ADDRESSES } = await import("../helpers/mock-client.js");
  const { CliRefusal } = await import("../../src/redact.js");
  const client = mockClient({
    addresses: { ...CONTENT_ADDRESSES, projectPresentation: "0x0000000000000000000000000000000000000cc1" },
    mayMint: async () => true,
    assertCanPublish: async () => {},
    readProject: async () => ({versionCount:h.versionCount,cid:h.versionCount ? `0x${"ab".repeat(32)}` : null,kind:1,name:"art"}),
    mintProject: async () => { h.calls.push("mint"); return { tokenId: 7n }; },
    publishAndTag: async () => { h.calls.push("publish");
      if(h.fail === "readback-version" || h.fail === "setting-tag") throw Object.assign(new Error("confirmed publish needs followup"),{published:true,retryPublish:false,phase:h.fail,root:`0x${"ab".repeat(32)}`,org:"0x00000000000000000000000000000000000000a1",tokenId:7n,publishTxHash:"0xpublish",...(h.fail === "setting-tag" ? {versionNumber:1n} : {})});
      return { versionNumber: 1n,publishTxHash:"0xpublish" }; },
    setProjectName: async () => {if(h.fail === "set-name") throw new Error("name write failed");return "0x12";},
    configurePresentationTarget: async () => {
      h.calls.push("set-target");
      if (h.fail === "set-target") throw new Error("target receipt unavailable");
      return "0x12";
    },
    inspectPresentation: async () => {
      h.inspections++;
      if (h.fail === "inspect-result" && h.inspections === 1) throw new Error("post-write read unavailable");
      return { root: `0x${"ab".repeat(32)}`, path: "", method: h.configuredFlags & 2 ? 0 : 1, locks: 0, configuredFlags:h.configuredFlags, selection:0,version:0,tag:"",frozenRoot:`0x${"00".repeat(32)}`,
        chainBase: "https://chain.example/content/base", ipfsBase: "https://ipfs.example",
        targetError: h.inspections === 1 ? h.targetError || null : null };
    },
    setPresentationMethod: async () => {
      h.calls.push("set-method");
      if (h.fail === "set-method") throw (h.refusal ? new CliRefusal("RPC fee exceeds configured ceiling") : new Error("method receipt unavailable"));
      return "0x12";
    },
    planUpload: async () => ({ rootCid: `0x${"ab".repeat(32)}`, files: [] }),
    upload: async () => { h.calls.push("upload"); return { rootCid: `0x${"ab".repeat(32)}`, txHashes: [] }; },
  });
  return { createClient: () => ({ ...client, resolveOrg: async () => client }), createOrgClient: async () => client };
});

import { UploadPresentationError, uploadCommand } from "../../src/commands/upload.js";
import { presentationCommand } from "../../src/commands/presentation.js";
import { formatCliError } from "../../src/redact.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const ROOT = `0x${"ab".repeat(32)}`;
const FLAGS = `--project-id 7 --org ${ORG} --chain base-sepolia`;
const saved = { ...process.env };
let dir: string;
let output: string[];
beforeEach(() => {
  h.fail = ""; h.calls = []; h.inspections = 0; h.targetError = ""; h.refusal = false; h.versionCount=1; h.configuredFlags=0; output = []; process.exitCode=0;
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  process.env["ABXFS_CHAIN"] = "base-sepolia";
  dir = mkdtempSync(join(tmpdir(), "abxfs-presentation-recovery-"));
  writeFileSync(join(dir, "index.html"), "<p>hello</p>");
  vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...saved }; process.exitCode=0; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const run = () => uploadCommand().parseAsync([dir, "--name", "art", "--org", ORG, "--yes"], { from: "user" });
it.each(["set-target", "set-method", "inspect-result"] as const)("recovers %s after publication without minting or publishing again", async phase => {
  h.fail = phase;
  const error: unknown = await run().catch(e => e);
  expect(error).toBeInstanceOf(UploadPresentationError);
  const failure = error as UploadPresentationError;
  expect(failure).toMatchObject({ org: ORG, tokenId: 7n, root: ROOT, chainId: 84532, phase });
  expect(failure.message).toContain("already published");
  expect(failure.message).toContain("Do NOT rerun the original upload --name");
  const expected = [
    ...(phase === "set-target" ? [`abxfs presentation set-target --latest --path index.html ${FLAGS}`] : []),
    ...(phase !== "inspect-result" ? [`abxfs presentation set-method embedded ${FLAGS}`] : []),
    `abxfs presentation inspect ${FLAGS}`,
  ].join(" && ");
  expect(failure.recoveryCommand).toBe(expected);
  expect(formatCliError(failure).at(-1)).toBe(`  ${expected}`);
  // Follow the actual printed commands through Commander. These fixture arguments need only
  // ordinary words and the explicit empty quoted path; production uses shellArg for arbitrary names.
  h.fail = ""; h.inspections = 0;
  for (const command of failure.recoveryCommand.split(" && ")) {
    const words = Array.from(command.matchAll(/'([^']*)'|([^ ]+)/g), match => match[1] ?? match[2]!);
    const args = words.slice(2);
    await presentationCommand().parseAsync([...args, ...(args[0] === "inspect" ? [] : ["--yes"])], { from: "user" });
  }
  expect(h.calls.filter(call => call === "mint")).toHaveLength(1);
  expect(h.calls.filter(call => call === "publish")).toHaveLength(1);
  expect(expected).not.toContain("upload");
});

it("redacts RPC credentials from a target read failure while retaining legitimate endpoint paths", async () => {
  process.env["ALCHEMY_API_KEY"] = "audit-only-test-secret";
  h.targetError = "HTTP request failed URL: https://rpc.example/v2/audit-only-test-secret";
  await run();
  const presentation = output.find(line => line.includes("presentation:"))!;
  expect(presentation).not.toContain("audit-only-test-secret");
  expect(presentation).toContain("https://rpc.example/<redacted>");
  expect(presentation).toContain("https://chain.example/content/base");
  expect(presentation).toContain("https://ipfs.example");
});

it("retains the published project context when a transport refusal caused setup to stop", async () => {
  h.fail = "set-method"; h.refusal = true;
  const error: unknown = await run().catch(e => e);
  expect(formatCliError(error)[0]).toContain(ROOT);
  expect(formatCliError(error)[0]).toContain("already published to project #7");
  expect(formatCliError(error)[0]).toContain("set-method");
});

it.each([["readback-version","published_readback_pending"],["setting-tag","published_tag_pending"],["set-name","published_name_pending"]] as const)("JSON preserves confirmed publication after %s failure",async(phase,outcome)=>{
 h.fail=phase;
 await uploadCommand().parseAsync([dir,"--name","art","--org",ORG,"--yes","--json"],{from:"user"});
 const result=JSON.parse(output.at(-1)!);
 expect(result).toMatchObject({ok:false,published:true,outcome,retryPublish:false,root:ROOT,tokenId:"7",publishTxHash:"0xpublish",phase:phase === "set-name" ? "setting-name" : phase});
 if(phase === "readback-version") expect(result.versionNumber).toBeUndefined();
 expect(h.calls.filter(c=>c === "publish")).toHaveLength(1);expect(h.calls.filter(c=>c === "mint")).toHaveLength(1);
 expect(h.calls).not.toContain("set-target");expect(h.calls).not.toContain("set-method");
});

it.each([0,4])("initializes Auto for a pre-minted empty project with flags %s without minting another token",async flags=>{
 h.versionCount=0;h.configuredFlags=flags;
 await uploadCommand().parseAsync([dir,"--project-id","7","--org",ORG,"--yes","--json"],{from:"user"});
 const result=JSON.parse(output.at(-1)!);
 expect(result).toMatchObject({ok:true,published:true,tokenId:"7"});
 expect(h.calls).toEqual(["upload","publish","set-target","set-method"]);
});
it("preserves a deliberately saved zero-valued method before first publication",async()=>{
 h.versionCount=0;h.configuredFlags=2;
 await uploadCommand().parseAsync([dir,"--project-id","7","--org",ORG,"--yes"],{from:"user"});
 expect(h.calls).toEqual(["upload","publish","set-target"]);
});
it("preserves existing publication choices when upload targets a published project",async()=>{
 await uploadCommand().parseAsync([dir,"--project-id","7","--org",ORG,"--yes"],{from:"user"});
 expect(h.calls).toEqual(["upload","publish"]);
});

it("emits one signer-free JSON dry run with the concrete first-publication plan and no writes",async()=>{
 h.versionCount=0;
 await uploadCommand().parseAsync([dir,"--project-id","7","--org",ORG,"--dry-run","--json"],{from:"user"});
 expect(output).toHaveLength(1);
 expect(JSON.parse(output[0]!)).toMatchObject({ok:true,published:false,outcome:"planned",dryRun:true,contentMode:"snapshot",root:ROOT,presentation:{path:"index.html",requested:"auto",method:1,readiness:"ready",readReach:{tokenUri:"not-measured"}}});
 expect(h.calls).toEqual([]);
});

it("blocks invalid explicit ChainGateway presentation paths before any upload, mint or publish",async()=>{
 await uploadCommand().parseAsync([dir,"--name","art","--org",ORG,"--yes","--json","--presentation","chain-gateway","--presentation-path","../index.html"],{from:"user"});
 expect(JSON.parse(output.at(-1)!)).toMatchObject({ok:false,published:false,outcome:"failed"});
 expect(h.calls).toEqual([]);
});
