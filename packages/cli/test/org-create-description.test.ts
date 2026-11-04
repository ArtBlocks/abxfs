/**
 * `org create --description` / `--description-file`: the description is permanent, so a value the factory
 * would refuse is refused here before any client is built or anything is sent.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { name: string; description?: string }[] = [];
const built: string[] = [];

vi.mock("../src/client.js", async () => {
  const { mockClient } = await import("./helpers/mock-client.js");
  const c = mockClient({
    createOrg: async ({ name, description }: { name: string; description?: string }) => (
      sent.push({ name, ...(description !== undefined ? { description } : {}) }),
      { org: "0x00000000000000000000000000000000000000a1", firstTokenId: 0n, txHash: "0x01" }
    ),
  });
  return { createClient: () => (built.push("client"), c), createOrgClient: async () => c };
});

import { orgCommand, orgDescriptionFromOptions } from "../src/commands/org.js";

const saved = { ...process.env };
beforeEach(() => {
  sent.length = 0;
  built.length = 0;
  process.env["ABXFS_CONFIG"] = "/nonexistent.json";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const org = (args: string[]) => orgCommand().parseAsync(args, { from: "user" });
const file = (content: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "abxfs-desc-")), "description.txt");
  writeFileSync(p, content);
  return p;
};

describe("org create --description", () => {
  it("sends an empty description when none is given", async () => {
    await org(["create", "Studio", "--chain", "base-sepolia", "--yes"]);
    expect(sent).toEqual([{ name: "Studio", description: "" }]);
  });

  it("sends the description it is given", async () => {
    await org(["create", "Studio", "--description", "We make sites.", "--chain", "base-sepolia", "--yes"]);
    expect(sent).toEqual([{ name: "Studio", description: "We make sites." }]);
  });

  it.each([
    ["non-ASCII", "café", /printable ASCII/],
    ["a tab", "a\tb", /printable ASCII/],
    ["only whitespace", "   ", /only spaces/],
    ["over 1000 bytes", "a".repeat(1001), /limit is 1000/],
  ])("refuses %s before building a client or sending", async (_n, description, err) => {
    await expect(org(["create", "Studio", "--description", description, "--chain", "base-sepolia"])).rejects.toThrow(err);
    expect(built).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("says in its help that the description is permanent", () => {
    const create = orgCommand().commands.find((c) => c.name() === "create")!;
    expect(create.helpInformation()).toMatch(/--description <text>[\s\S]*PERMANENT/);
  });
});

describe("org create --description-file", () => {
  it("reads the file, keeps inner newlines and drops trailing ones", async () => {
    await org(["create", "Studio", "--description-file", file("Line one\n\nLine two\n\n"), "--chain", "base-sepolia", "--yes"]);
    expect(sent).toEqual([{ name: "Studio", description: "Line one\n\nLine two" }]);
  });

  it("refuses Windows line endings instead of rewriting a permanent value", () => {
    expect(() => orgDescriptionFromOptions({ descriptionFile: file("a\r\nb\r\n") })).toThrow(/printable ASCII/);
  });

  it("refuses both flags at once", () => {
    expect(() => orgDescriptionFromOptions({ description: "a", descriptionFile: file("b") })).toThrow(/not both/);
  });
});
