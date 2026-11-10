import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  fail: "" as "" | "set-target" | "set-method" | "inspect-result",
  calls: [] as string[], inspections: 0, targetError: "", refusal: false,
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
    mintProject: async () => { h.calls.push("mint"); return { tokenId: 7n }; },
    publishAndTag: async () => { h.calls.push("publish"); return { versionNumber: 1n }; },
    setProjectName: async () => "0x12",
    configurePresentationTarget: async () => {
      h.calls.push("set-target");
      if (h.fail === "set-target") throw new Error("target receipt unavailable");
      return "0x12";
    },
    inspectPresentation: async () => {
      h.inspections++;
      if (h.fail === "inspect-result" && h.inspections === 2) throw new Error("post-write read unavailable");
      return { root: `0x${"ab".repeat(32)}`, path: "", method: 1, locks: 0,
        chainBase: "https://chain.example/content/base", ipfsBase: "https://ipfs.example",
        targetError: h.inspections === 2 ? h.targetError || null : null };
    },
    setPresentationMethod: async () => {
      h.calls.push("set-method");
      if (h.fail === "set-method") throw (h.refusal ? new CliRefusal("RPC fee exceeds configured ceiling") : new Error("method receipt unavailable"));
      return "0x12";
    },
    planUpload: async () => ({ rootCid: `0x${"ab".repeat(32)}`, files: [] }),
    upload: async () => ({ rootCid: `0x${"ab".repeat(32)}`, txHashes: [] }),
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
  h.fail = ""; h.calls = []; h.inspections = 0; h.targetError = ""; h.refusal = false; output = [];
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  process.env["ABXFS_CHAIN"] = "base-sepolia";
  dir = mkdtempSync(join(tmpdir(), "abxfs-presentation-recovery-"));
  writeFileSync(join(dir, "index.html"), "<p>hello</p>");
  vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

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
    ...(phase === "set-target" ? [`abxfs presentation set-target --latest --path '' ${FLAGS}`] : []),
    ...(phase !== "inspect-result" ? [`abxfs presentation set-method ${phase === "set-target" ? "auto" : "embedded"} ${FLAGS}`] : []),
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
