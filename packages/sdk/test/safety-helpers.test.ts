import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { assertSafeRecipient, recipientProblem } from "../src/address-safety.js";
import { sanitizeDisplayName, stripTerminalControl } from "../src/display.js";
import { externalUrlProblem, isSafeExternalUrl } from "../src/url-safety.js";
import { setPreferredGateway } from "../src/project.js";

const GOOD = getAddress("0x00000000000000000000000000000000000a11ce");

describe("recipientProblem / assertSafeRecipient", () => {
  it("accepts lowercase, uppercase-hex and correctly checksummed addresses", () => {
    expect(recipientProblem(GOOD.toLowerCase())).toBeNull();
    expect(recipientProblem(GOOD)).toBeNull();
    expect(assertSafeRecipient(GOOD.toLowerCase())).toBe(GOOD);
  });

  it("rejects a mixed-case address with a wrong checksum", () => {
    const wrong = GOOD.slice(0, 20) + (GOOD[20] === GOOD[20]!.toUpperCase() ? GOOD[20]!.toLowerCase() : GOOD[20]!.toUpperCase()) + GOOD.slice(21);
    if (wrong !== GOOD) expect(recipientProblem(wrong)).toMatch(/checksum/);
    const flipped = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
    expect(recipientProblem(flipped)).toMatch(/checksum/);
  });

  it("rejects malformed, zero, burn and forbidden addresses", () => {
    expect(recipientProblem("0x1234")).toMatch(/40 hex/);
    expect(recipientProblem("0x" + "0".repeat(40))).toMatch(/zero/);
    expect(recipientProblem("0x000000000000000000000000000000000000dEaD")).toMatch(/burn/);
    expect(recipientProblem("0x000000000000000000000000000000000000dead")).toMatch(/burn/);
    expect(recipientProblem(GOOD, { forbid: [GOOD.toLowerCase()] })).toMatch(/lock/);
    expect(() => assertSafeRecipient("nope", { what: "transfer target" })).toThrow(/invalid transfer target/);
  });
});

describe("sanitizeDisplayName", () => {
  it("strips bidi, zero-width and control characters and collapses whitespace", () => {
    expect(sanitizeDisplayName("‮evil‬ name")).toBe("evil name");
    expect(sanitizeDisplayName("a​b⁠c")).toBe("abc");
    expect(sanitizeDisplayName("  two\n\t  words ")).toBe("two words");
    expect(sanitizeDisplayName("\u001b[31mred\u001b[0m")).toBe("[31mred[0m");
  });
  it("drops non-ASCII, bounds length, and never throws on non-strings", () => {
    expect(sanitizeDisplayName("pаypal")).toBe("pypal"); // Cyrillic a removed, not shown as 'a'
    expect(sanitizeDisplayName("x".repeat(500), 10)).toHaveLength(10);
    expect(sanitizeDisplayName(undefined)).toBe("");
  });
});

describe("stripTerminalControl", () => {
  it("removes ANSI CSI/OSC sequences and C0/C1 controls", () => {
    expect(stripTerminalControl("\u001b[2J\u001b[Hhello")).toBe("hello");
    expect(stripTerminalControl("a\u001b]0;pwned title\u0007b")).toBe("ab");
    expect(stripTerminalControl("x\u009b31my")).toBe("xy");
    expect(stripTerminalControl("line1\nline2\r\u0008\u007f")).toBe("line1 line2 ");
  });
  it("keeps ordinary non-ASCII text but removes bidi overrides", () => {
    expect(stripTerminalControl("テスト.txt")).toBe("テスト.txt");
    expect(stripTerminalControl("a‮b")).toBe("ab");
  });
});

describe("externalUrlProblem", () => {
  it("accepts ordinary https gateways", () => {
    for (const ok of ["https://ipfs.io/ipfs/", "https://gateway.example.com/base", "https://8.8.8.8/x"]) {
      expect(isSafeExternalUrl(ok), ok).toBe(true);
    }
  });
  it("rejects http, credentials, localhost, private/loopback/link-local/ULA literals, odd forms", () => {
    for (const bad of [
      "http://example.com/",
      "https://user:pw@example.com/",
      "https://user@example.com/",
      "https://localhost/",
      "https://foo.localhost/",
      "https://127.0.0.1/",
      "https://2130706433/", // decimal loopback, normalised by URL
      "https://0x7f.1/",
      "https://10.1.2.3/",
      "https://172.16.0.1/",
      "https://192.168.1.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/",
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://intranet/",
      "https://printer.local/",
      "https://a.example/\u0000x",
      "https://a.example/ x",
      "javascript:alert(1)",
      "",
      "https://" + "a".repeat(600) + ".example/",
    ]) {
      expect(isSafeExternalUrl(bad), bad).toBe(false);
    }
    expect(externalUrlProblem("http://a.example")).toMatch(/https/);
  });
  it("setPreferredGateway refuses an unsafe URL before sending, and clears with an empty string", async () => {
    const sent: unknown[] = [];
    const wallet = { account: { address: GOOD }, writeContract: async (a: unknown) => (sent.push(a), "0x1") } as never;
    const contracts = { collection: GOOD, hook: GOOD } as never;
    await expect(setPreferredGateway(wallet, contracts, 1n, "http://169.254.169.254/")).rejects.toThrow(/refusing/);
    expect(sent).toHaveLength(0);
    await setPreferredGateway(wallet, contracts, 1n, "https://ipfs.io/ipfs/");
    await setPreferredGateway(wallet, contracts, 1n, "");
    expect(sent).toHaveLength(2);
  });
});
