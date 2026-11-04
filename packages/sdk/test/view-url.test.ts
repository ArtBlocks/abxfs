/**
 * `isUsableViewUrl` mirrors what `ProjectLinks` will emit. A value it accepts that the contract
 * refuses would be saved and then silently ignored, so the cases here are the contract test's cases.
 */
import { describe, expect, it } from "vitest";

import { CLEARED_PARAM_VALUE, MAX_VIEW_URL_BYTES, isUsableViewUrl, setViewUrl } from "../src/project.js";

describe("isUsableViewUrl", () => {
  it("accepts an https URL as is, including query and fragment", () => {
    expect(isUsableViewUrl("https://my-site.example/")).toBe(true);
    expect(isUsableViewUrl("https://my-site.example/app?x=1;y=2#top")).toBe(true);
  });

  it("refuses everything the contract refuses", () => {
    for (const bad of [
      "http://insecure.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "HTTPS://upper.example",
      "https://",
      'https://a.example/"onload="x',
      "https://a.example/\\x",
      "https://a.example/<script>",
      "https://a.example/ space",
      "https://a.example/`x",
      // `'` and `&` are refused too, in lockstep with the on-chain validator in ProjectLinks.
      "https://a.example/?a=1&b=2",
      "https://a.example/it's",
      // So are `( ) [ ] { } | ^`: a Markdown link or a CSS `url()` ends at them, and RFC 3986 forbids `{ } | ^`.
      "https://a.example/wiki/Foo_(bar)",
      "https://[::1]/",
      "https://a.example/{x}",
      "https://a.example/a|b",
      "https://a.example/a^b",
      "ftp://a.example",
      "",
      "https://exämple.test/",
    ]) {
      expect(isUsableViewUrl(bad), bad).toBe(false);
    }
  });

  it("has the same 512-byte cap as the hook", () => {
    const at = "https://a.example/" + "a".repeat(MAX_VIEW_URL_BYTES - 18);
    expect(at.length).toBe(MAX_VIEW_URL_BYTES);
    expect(isUsableViewUrl(at)).toBe(true);
    expect(isUsableViewUrl(at + "a")).toBe(false);
  });
});

describe("setViewUrl", () => {
  const capture = () => {
    const calls: unknown[][] = [];
    const wallet = {
      account: { address: "0x00000000000000000000000000000000000000a1" },
      chain: undefined,
      async writeContract(args: { functionName: string; args: unknown[] }) {
        calls.push([args.functionName, ...args.args]);
        return "0xabc";
      },
    };
    return { calls, wallet: wallet as never };
  };
  const contracts = { collection: "0x00000000000000000000000000000000000000c1", hook: "0x00000000000000000000000000000000000000c2" } as never;

  it("writes the URL itself, untouched", async () => {
    const { calls, wallet } = capture();
    await setViewUrl(wallet, contracts, 3n, "https://my-site.example/");
    const hex = calls[0]![3] as string;
    expect(Buffer.from(hex.slice(2), "hex").toString()).toBe("https://my-site.example/");
  });

  /** ABX refuses an empty value and a token owner cannot call clearTokenParam, so "clear" is a sentinel. */
  it("clears by writing the sentinel, never an empty value", async () => {
    const { calls, wallet } = capture();
    await setViewUrl(wallet, contracts, 3n, "");
    expect(calls[0]![0]).toBe("configureTokenParamData");
    expect(Buffer.from((calls[0]![3] as string).slice(2), "hex").toString()).toBe(CLEARED_PARAM_VALUE);
  });

  it("refuses an unusable URL before sending anything", async () => {
    const { calls, wallet } = capture();
    await expect(setViewUrl(wallet, contracts, 3n, "http://insecure.example")).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });
});
