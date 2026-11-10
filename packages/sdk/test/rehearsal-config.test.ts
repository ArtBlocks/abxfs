import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_DEPLOYMENTS, requireCanonicalAddresses } from "../src/canonical.js";
import { rehearsalAddresses, rehearsalChain } from "./helpers/rehearsal-config.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function input(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-rehearsal-config-"));
  dirs.push(dir);
  const file = join(dir, "addresses.json"); writeFileSync(file, JSON.stringify(value)); return file;
}
const addr = (digit: string) => `0x${digit.repeat(40)}`;
describe("live rehearsal configuration without signing or RPC", () => {
  it("includes every registry chain, including both Robinhood networks", () => {
    for (const chain of Object.keys(CANONICAL_DEPLOYMENTS).map(Number)) expect(rehearsalChain(chain)?.id).toBe(chain);
    expect(rehearsalChain(4663)?.testnet).toBeFalsy();
    expect(rehearsalChain(46630)?.testnet).toBe(true);
    expect(rehearsalChain(137)).toBeUndefined();
  });
  it("uses an explicit candidate bundle without changing canonical deployment records", () => {
    const before = CANONICAL_DEPLOYMENTS[46630]!.addresses;
    const candidate = { ...requireCanonicalAddresses(84532), contentReader: addr("a"), projectPresentation: addr("b") };
    expect(rehearsalAddresses(46630, input(candidate))).toEqual(candidate);
    expect(CANONICAL_DEPLOYMENTS[46630]!.addresses).toBe(before);
    expect(rehearsalAddresses(46630)).toBe(before);
  });
  it("retains canonical defaults and refuses incomplete/malformed candidate inputs", () => {
    expect(rehearsalAddresses(84532)).toEqual(requireCanonicalAddresses(84532));
    expect(() => rehearsalAddresses(46630, input({}))).toThrow(/chunkStore/);
    expect(() => rehearsalAddresses(46630, input({ ...requireCanonicalAddresses(84532), contentReader: undefined, projectPresentation: addr("a") }))).toThrow(/both/);
    expect(() => rehearsalAddresses(46630, input({ ...requireCanonicalAddresses(84532), orgFactory: "0x00" }))).toThrow(/orgFactory/);
  });
});
