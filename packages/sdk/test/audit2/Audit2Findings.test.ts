import { describe, expect, it } from "vitest";
import { externalUrlProblem, isUsableViewUrl, stripTerminalControl, recipientProblem, contentOrigin } from "../../src/index.js";

// Round-2 findings B1-B5, now fixed: each test asserts the SAFE behaviour.
describe("Audit2 B findings (fixed)", () => {
  it("B1 trailing-dot / escaped-dot local names are refused by externalUrlProblem", () => {
    for (const u of ["https://localhost./", "https://foo.localhost./", "https://localhost%2e/", "https://foo.local./", "https://metadata.google.internal./", "https://a.internal/", "https://LOCALHOST/"]) {
      expect(externalUrlProblem(u), u).not.toBeNull();
    }
    // isUsableViewUrl mirrors the CONTRACT's rule only (it cannot know DNS); setViewUrl adds externalUrlProblem.
    expect(isUsableViewUrl("https://localhost./")).toBe(true);
  });
  it("B2 NAT64 / 6to4 / SIIT / site-local / documentation IPv6 forms are refused", () => {
    for (const u of [
      "https://[64:ff9b::7f00:1]/", "https://[2002:7f00:1::]/", "https://[::ffff:0:7f00:1]/", "https://[fec0::1]/",
      "https://[2001:db8::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:a00:1]/", "https://[::127.0.0.1]/", "https://[::7f00:1]/",
      "https://[0:0:0:0:0:0:0:1]/", "https://[fd00::1]/", "https://[fe80::1]/",
    ]) {
      expect(externalUrlProblem(u), u).not.toBeNull();
    }
  });
  it("B2b decimal / octal / hex IPv4 literals are refused", () => {
    for (const u of ["https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://%31%32%37.0.0.1/", "https://127.0.0.1./"]) {
      expect(externalUrlProblem(u), u).not.toBeNull();
    }
  });
  it("B2c ordinary public hosts still pass", () => {
    for (const u of ["https://example.com/", "https://sub.example.com:8443/x?y=1", "https://[2606:4700:4700::1111]/", "https://1.1.1.1/", "https://xn--e1afmkfd.xn--p1ai/"]) {
      expect(externalUrlProblem(u), u).toBeNull();
    }
  });
  it("B3 terminal strip removes the invisible/spoofing characters", () => {
    for (const c of ["\u2800", "\u{e0041}", "\u{e007f}", "\u{1d173}", "\u{1d17a}", "\ufff9", "\ufffa", "\ufffb", "\u0600", "\u0605"]) {
      expect(stripTerminalControl("a" + c + "b"), JSON.stringify(c)).toBe("ab");
    }
  });
  it("B3b: ordinary non-ASCII letters are kept; NBSP/ideographic space become a plain space (round 3)", () => {
    expect(stripTerminalControl("日本語\u00a0x")).toBe("日本語 x");
  });
  it("B4 precompiles and the all-ones address are refused as recipients", () => {
    for (let i = 1; i <= 10; i++) {
      expect(recipientProblem("0x" + i.toString(16).padStart(40, "0")), String(i)).not.toBeNull();
    }
    expect(recipientProblem("0xffffffffffffffffffffffffffffffffffffffff")).not.toBeNull();
    expect(recipientProblem("0x" + "0".repeat(38) + "0b")).toBeNull(); // 0x0b is not a precompile
  });
  it("B5 contentOrigin validates baseHost and scheme", () => {
    const t = { chainId: 1, org: "0x" + "a".repeat(40), tokenId: 1 };
    expect(() => contentOrigin(t, "evil.com/x#")).toThrow(/not a valid content host/);
    expect(() => contentOrigin(t, "evil.com", "javascript" as never)).toThrow(/scheme/);
    expect(() => contentOrigin(t, "a@b.com")).toThrow();
    expect(contentOrigin(t, "content.example")).toMatch(/^https:\/\/1-a{40}-1\.content\.example$/);
    expect(contentOrigin(t, "localhost:3002", "http")).toMatch(/^http:\/\/.*\.localhost:3002$/);
  });
});
