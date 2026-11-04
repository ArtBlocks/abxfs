/**
 * Directory entry names are attacker-controlled bytes. Whatever the CLI prints from chain must have
 * terminal control sequences stripped (audit: terminal injection).
 */
import { describe, expect, it, vi } from "vitest";

const EVIL = "ok\u001b]52;c;ZXZpbA==\u0007\u001b[2J\u001b[Hrm -rf ~\u009b31m";

vi.mock("../src/client.js", () => ({
  createClient: () => ({
    // The chain says what the CID is first (audit F10): a directory.
    cidKind: async () => 1,
    readFile: async () => {
      throw new Error("not a file");
    },
  }),
}));
// `read` lists a directory through the SDK's readDirectory, which takes an entry cap.
vi.mock("@abxfs/sdk", async (orig) => ({
  ...(await orig<typeof import("@abxfs/sdk")>()),
  readDirectory: async () => ({ entries: [{ name: EVIL, cid: "0x" + "ab".repeat(32), isDirectory: false }] }),
}));

import { readCommand } from "../src/commands/read.js";
import { safe } from "../src/text.js";

describe("terminal escape injection via on-chain names", () => {
  it("abxfs read <dirCid> prints entry names with every escape sequence removed", async () => {
    process.env["ABXFS_CONFIG"] = "/nonexistent.json";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    await readCommand().parseAsync(["0x" + "cd".repeat(32), "--chain", "base-sepolia"], { from: "user" });
    const out = lines.join("\n");
    expect(out).not.toContain("\u001b]52");
    expect(out).not.toContain("\u001b[2J");
    expect(out).not.toContain("\u009b");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("ok");
  });

  it("safe() strips C0, C1, ESC sequences and bidi overrides", () => {
    expect(safe("a\u001b[31mred\u001b[0m\u0000b‎c‮d")).toBe("aredbcd");
    expect(safe("line1\nline2\r\n")).toBe("line1 line2  ");
    expect(safe("日本語.txt")).toBe("日本語.txt");
  });
});
