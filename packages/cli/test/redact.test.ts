import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";

import { redact, redactUrl, registerSecret } from "../src/redact.js";
import { run } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("RPC URLs and keys are scrubbed from what the CLI prints", () => {
  it("redactUrl keeps scheme and host only", () => {
    expect(redactUrl("https://user:pw@rpc.example:8545/v2/SECRETAPIKEY123?k=1")).toBe("https://rpc.example:8545/<redacted>");
  });

  it("a real viem transport error (which embeds the URL) is scrubbed", async () => {
    const client = createPublicClient({ transport: http("http://127.0.0.1:9/v2/SECRETAPIKEY123", { retryCount: 0 }) });
    const err = (await client.getBlockNumber().catch((e: Error) => e)) as Error;
    expect(err.message).toContain("SECRETAPIKEY123"); // the raw message does leak: this is why we scrub
    expect(redact(err.message)).not.toContain("SECRETAPIKEY123");
  });

  it("registered secrets and the configured private key are removed wherever they appear", () => {
    registerSecret("my-pinata-jwt-value");
    process.env["ABXFS_PRIVATE_KEY"] = "0x" + "ab".repeat(32);
    const out = redact(`failed with my-pinata-jwt-value and key ${"0x" + "ab".repeat(32)}`);
    expect(out).not.toContain("my-pinata-jwt-value");
    expect(out).not.toContain("ab".repeat(32));
    delete process.env["ABXFS_PRIVATE_KEY"];
  });

  it("does not eat CIDs (32-byte hex) from ordinary errors", () => {
    const cid = "0x" + "cd".repeat(32);
    expect(redact(`RootNotFound(${cid})`)).toContain(cid);
  });

  it("the entry point prints a scrubbed, control-free error", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void lines.push(a.join(" ")));
    process.env["ABXFS_CONFIG"] = "/nonexistent.json";
    process.env["ABXFS_RPC_URL_84532"] = "http://127.0.0.1:9/v2/SECRETAPIKEY123";
    await run(["node", "abxfs", "read", "0x" + "cd".repeat(32), "--chain", "base-sepolia"]);
    delete process.env["ABXFS_RPC_URL_84532"];
    const out = lines.join("\n");
    expect(out).toMatch(/error/);
    expect(out).not.toContain("SECRETAPIKEY123");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  }, 30_000);
});
