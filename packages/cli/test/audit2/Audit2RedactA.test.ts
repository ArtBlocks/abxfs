/** Audit round 2, pass A: error scrubbing. "GAP:" = weakness present. */
import { afterEach, describe, expect, it } from "vitest";
import { redact, redactUrl, registerSecret } from "../../src/redact.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
const KEY = "0x" + "ab".repeat(31) + "cd";

describe("redact", () => {
  it("URL userinfo, path, query and fragment are cut (http, https, ws, wss)", () => {
    for (const u of ["https://u:p@h.io/v2/KEY?a=KEY#KEY", "wss://h.io/KEY", "http://h.io:8545/KEY"]) {
      expect(redact(`fail ${u} boom`)).not.toContain("KEY");
    }
  });
  it("the configured private key is removed by value", () => {
    process.env["ABXFS_PRIVATE_KEY"] = KEY;
    expect(redact(`x ${KEY} y`)).not.toContain(KEY);
  });
  it("the key is removed in every spelling: upper/lower case, with or without 0x (fixed)", () => {
    process.env["ABXFS_PRIVATE_KEY"] = KEY;
    expect(redact(KEY.toUpperCase().replace("0X", "0x"))).not.toMatch(/ABABAB/i);
    expect(redact(KEY.slice(2))).not.toContain("abab");
    expect(redact(KEY.slice(2).toUpperCase())).not.toContain("ABAB");
  });
  it("schemeless and non-http URLs lose their API key (fixed)", () => {
    expect(redact("request to rpc.example.com/v2/SECRETAPIKEY failed")).not.toContain("SECRETAPIKEY");
    expect(redact("ipc:///var/run/SECRETAPIKEY.ipc")).not.toContain("SECRETAPIKEY");
    expect(redact("ftp://h.io/SECRETAPIKEY")).not.toContain("SECRETAPIKEY");
    expect(redact("request to rpc.example.com/v2/SECRETAPIKEY failed")).toContain("rpc.example.com");
  });
  it("credential-named environment variables are registered (fixed)", () => {
    process.env["ALCHEMY_API_KEY"] = "ALCHEMYKEYVALUE";
    process.env["ETHERSCAN_API_KEY"] = "ETHERSCANVALUE1";
    expect(redact("key ALCHEMYKEYVALUE and ETHERSCANVALUE1")).not.toMatch(/ALCHEMYKEYVALUE|ETHERSCANVALUE1/);
  });
  it("ACCEPTED: secrets shorter than 6 chars are never registered (redacting them would shred ordinary output)", () => {
    registerSecret("abc12");
    expect(redact("token abc12")).toContain("abc12");
  });
  it("redactUrl on garbage never throws", () => {
    expect(redactUrl("not a url")).toBe("<url redacted>");
  });
  it("a URL whose host contains control characters is cut before printing (and index.ts then strips controls)", () => {
    expect(redact("https://h.io\x1b[31m/KEY")).not.toContain("KEY");
  });
});
