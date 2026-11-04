import { describe, expect, it } from "vitest";
import { isUsableViewUrl, viewUrlProblem } from "../../src/project.js";
import { hasLookalikeHost, urlHost } from "../../src/url-safety.js";

describe("Audit5 viewUrlProblem", () => {
  const refused = [
    "https://opensea.io@evil.example/",
    "https://opensea.io:443@evil.example/",
    "https://user:pw@evil.example/",
    "https://@evil.example/",
    "https://opensea.io%40evil.example/",
    "https://evil.example\\@opensea.io/",
    "HTTPS://opensea.io@evil.example/",
    "https://opensea.io@evil.example",
    "http://example.com/",
    "https://127.0.0.1/",
    "https://localhost/",
    "https://[::1]/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://169.254.169.254/",
    "https://evil.example/a b",
  ];
  for (const u of refused) it(`refuses ${JSON.stringify(u)}`, () => expect(viewUrlProblem(u), u).not.toBeNull());
  it("never accepts what isUsableViewUrl refuses (UI stricter than contract mirror, never looser)", () => {
    const samples = [...refused, "https://a.example/ok", "https://a.example/?q=1&x=2", "https://a.example/\"", "https://é.example/", "https://xn--pple-43d.example/", "ftp://a.example/", "https://a.example/" + "a".repeat(600)];
    for (const u of samples) if (!isUsableViewUrl(u)) expect(viewUrlProblem(u), u).not.toBeNull();
  });
  it("userinfo-looking text in path/query/fragment is still allowed", () => {
    expect(viewUrlProblem("https://a.example/@x")).toBeNull();
    expect(viewUrlProblem("https://a.example/?u=a@b")).toBeNull();
    expect(viewUrlProblem("https://a.example/#a@b")).toBeNull();
  });
  it("lookalike detection: xn-- in any label, any case", () => {
    expect(hasLookalikeHost("https://xn--pple-43d.example/")).toBe(true);
    expect(hasLookalikeHost("https://XN--PPLE-43D.example/")).toBe(true);
    expect(hasLookalikeHost("https://www.xn--pple-43d.example/")).toBe(true);
    expect(hasLookalikeHost("https://a.example.xn--p1ai/")).toBe(true);
    expect(hasLookalikeHost("https://apple.example/")).toBe(false);
    expect(urlHost("https://A.Example:8443/x")).toBe("a.example");
  });
  it("non-xn lookalikes pass silently (documented gap)", () => {
    expect(hasLookalikeHost("https://opensea.io.evil.example/")).toBe(false);
    expect(hasLookalikeHost("https://0pensea.io/")).toBe(false);
    expect(viewUrlProblem("https://0pensea.io/")).toBeNull();
  });
});
