/**
 * `abxfs upload --project-id N --tag T` and `abxfs update --tag T` use the SDK's ONE publish-and-tag
 * implementation (audit H3). The CLI itself must not read a count and tag it, nor wait for "at least
 * one version".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = "0x00000000000000000000000000000000000000a1";
const { calls, rec, flags } = vi.hoisted(() => {
  const flags = { planFails: false };
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => async (...a: unknown[]) => void calls.push({ fn, args: a });
  return { calls, rec, flags };
});

vi.mock("../src/client.js", async () => {
  const { mockClient } = await import("./helpers/mock-client.js");
  const orgClient = mockClient({
    assertCanPublish: rec("assertCanPublish"),
    publishVersion: rec("publishVersion"),
    setProjectName: rec("setProjectName"),
    waitForVersion: rec("waitForVersion"),
    // A lagging replica: the CLI must not rely on this.
    readProject: async () => ({ versionCount: 3, cid: "0x" + "11".repeat(32), kind: 1, name: "p" }),
    setTag: rec("setTag"),
    publishAndTag: async (...a: unknown[]) => {
      calls.push({ fn: "publishAndTag", args: a });
      return { publishTxHash: "0x01", versionNumber: 4n };
    },
    update: async (a: unknown) => {
      calls.push({ fn: "update", args: [a] });
      return { newRootCid: "0x" + "cd".repeat(32), txHash: "0x01", versionNumber: 4n };
    },
  });
  const client = mockClient({
    upload: async () => (calls.push({ fn: "upload", args: [] }), { rootCid: "0x" + "cd".repeat(32), rootKind: "directory", txHashes: [] }),
    // The offline preflight (PlanTooLargeError check) that runs before any org is resolved or token minted.
    planUpload: async () => { if (flags.planFails) throw Object.assign(new Error("The top-level folder has 1000 entries"), { name: "PlanTooLargeError" }); return { rootCid: "0x" + "cd".repeat(32), files: [], rootKind: "directory" }; },
    resolveOrg: async () => orgClient,
    forOrg: () => orgClient,
  });
  return { createClient: () => client, createOrgClient: async () => orgClient };
});

import { uploadCommand } from "../src/commands/upload.js";
import { updateCommand } from "../src/commands/update.js";

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  calls.length = 0;
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), "abxfs-tag-"));
  writeFileSync(join(dir, "index.html"), "x");
  process.env["ABXFS_CONFIG"] = join(dir, "none.json");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
}

describe("upload preflight", () => {
  it("a plan no transaction can execute is refused BEFORE ownership is checked, an org created or a token minted", async () => {
    setup();
    flags.planFails = true;
    try {
      await expect(
        uploadCommand().parseAsync([dir, "--chain", "base-sepolia", "--name", "x", "--org", ORG], { from: "user" }),
      ).rejects.toThrow(/1000 entries/);
    } finally {
      flags.planFails = false;
    }
    expect(calls.map((c) => c.fn)).toEqual([]); // no assertCanPublish, no mint, no upload
  });
});

describe("upload --project-id --tag", () => {
  it("publishes and tags through publishAndTag only, and never waits for 'at least 1' or tags a read count", async () => {
    setup();
    await uploadCommand().parseAsync(
      [dir, "--chain", "base-sepolia", "--project-id", "5", "--org", ORG, "--tag", "release", "--yes"],
      { from: "user" },
    );
    const fns = calls.map((c) => c.fn);
    // Ownership is checked BEFORE the content is uploaded (audit 4), not discovered at the last step.
    expect(fns.indexOf("assertCanPublish")).toBeGreaterThanOrEqual(0);
    expect(fns.indexOf("assertCanPublish")).toBeLessThan(fns.indexOf("upload"));
    expect(fns).toContain("publishAndTag");
    expect(fns).not.toContain("setTag");
    expect(fns).not.toContain("waitForVersion");
    expect(fns).not.toContain("publishVersion");
    const p = calls.find((c) => c.fn === "publishAndTag")!;
    expect(p.args).toEqual([5n, "0x" + "cd".repeat(32), { tag: "release" }]);
  });

  it("an untagged publish still goes through publishAndTag (proving the version), with no tag", async () => {
    setup();
    await uploadCommand().parseAsync([dir, "--chain", "base-sepolia", "--project-id", "5", "--org", ORG, "--yes"], { from: "user" });
    expect(calls.find((c) => c.fn === "publishAndTag")!.args[2]).toEqual({});
  });
});

describe("update --tag", () => {
  it("hands the tag to the SDK update and does no tagging of its own", async () => {
    setup();
    await updateCommand().parseAsync(
      [dir, "--chain", "base-sepolia", "--project-id", "5", "--org", ORG, "--tag", "release", "--yes"],
      { from: "user" },
    );
    const fns = calls.map((c) => c.fn);
    expect(fns).not.toContain("setTag");
    expect(fns).not.toContain("waitForVersion");
    const u = calls.find((c) => c.fn === "update")!.args[0] as { tag?: string };
    expect(u.tag).toBe("release");
  });
});
