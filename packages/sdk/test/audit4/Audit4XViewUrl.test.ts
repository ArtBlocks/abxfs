/**
 * AUDIT4 (cross-cutting): what a project owner can put in a token's `animation_url` / `external_url`.
 * The frozen renderer accepts userinfo, so `isUsableViewUrl` (its mirror) still says yes: the CLIENT is the
 * only guard, and `viewUrlProblem` / `setViewUrl` now refuse it. Accepted items stay marked.
 */
import { describe, expect, it, vi } from "vitest";

import { hasLookalikeHost, isUsableViewUrl, setViewUrl, urlHost, viewUrlProblem } from "../../src/index.js";

describe("AUDIT4X abxfs.view validator", () => {
  it("still refuses the injection and scheme cases (regression guard)", () => {
    for (const bad of ["javascript:alert(1)", "http://insecure.example/", "https://a b.example/", "https://x.example/'><script>", "https://x.example/\"", "data:text/html,x", "HTTPS://x.example/"]) {
      expect(isUsableViewUrl(bad), bad).toBe(false);
      expect(viewUrlProblem(bad), bad).not.toBeNull();
    }
  });

  it("ACCEPTED: isUsableViewUrl mirrors the frozen renderer, which accepts userinfo", () => {
    expect(isUsableViewUrl("https://opensea.io@evil.example/")).toBe(true);
    expect(isUsableViewUrl("https://user:pw@example.org/")).toBe(true);
  });

  it("FIXED: viewUrlProblem and setViewUrl refuse userinfo, so the link can never read as another site", async () => {
    for (const url of ["https://opensea.io@evil.example/", "https://user:pw@example.org/", "https://a@b.example/x", "https://x.example@y.example/"]) {
      expect(viewUrlProblem(url), url).toMatch(/credentials/);
    }
    const writeContract = vi.fn();
    const wallet = { account: { address: "0x00000000000000000000000000000000000a11ce" }, writeContract } as never;
    const contracts = { collection: "0x00000000000000000000000000000000000000a1", hook: "0x00000000000000000000000000000000000000a2" } as never;
    await expect(setViewUrl(wallet, contracts, 1n, "https://opensea.io@evil.example/")).rejects.toThrow(/credentials/);
    expect(writeContract).not.toHaveBeenCalled();
    expect(viewUrlProblem("https://my-site.example/path?x=1")).toBeNull();
  });

  it("FIXED: a lookalike punycode host is detected so a client can ask before saving; a bare IP and private hosts are refused", () => {
    expect(hasLookalikeHost("https://xn--pple-43d.example/")).toBe(true);
    expect(hasLookalikeHost("https://sub.xn--80ak6aa92e.com/")).toBe(true);
    expect(hasLookalikeHost("https://apple.example/")).toBe(false);
    expect(urlHost("https://Sub.Example.COM:8443/x")).toBe("sub.example.com");
    expect(urlHost("http://example.com/")).toBeNull();
    expect(viewUrlProblem("https://203.0.113.9/")).not.toBeNull(); // TEST-NET-3: not a public host
    expect(viewUrlProblem("https://10.0.0.1/")).toMatch(/private/);
  });

  it("ACCEPTED (info): a host-only 200 character label and a lookalike punycode host are 'usable' to the renderer", () => {
    expect(isUsableViewUrl("https://" + "a".repeat(200) + ".example/")).toBe(true);
    expect(isUsableViewUrl("https://xn--pple-43d.example/")).toBe(true);
    expect(viewUrlProblem("https://xn--pple-43d.example/")).toBeNull(); // the caller confirms
  });
});
