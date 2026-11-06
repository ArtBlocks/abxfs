/**
 * `readTokenLinks`: a token's `animation_url` and `external_url` are read from the renderer its metadata uses
 * (`OrgMeta.links()`), never composed here, so they are exactly what a marketplace shows.
 */
import { describe, expect, it } from "vitest";
import { stringToHex, type Address, type PublicClient } from "viem";

import { readTokenLinks } from "../src/project.js";

const ORG_META = "0x0000000000000000000000000000000000000a11" as Address;
const LINKS = "0x0000000000000000000000000000000000000b22" as Address;
const ORG = "0x082992cec5af459b8cc3314e4178d30d3addab58" as Address;

/** A client whose `OrgMeta` names `LINKS`, and whose renderer answers each field with `rendered[field]`. */
function client(rendered: Record<string, string>) {
  const calls: { reads: unknown[]; renders: unknown[] } = { reads: [], renders: [] };
  const c = {
    async readContract(req: { address: Address; functionName: string }) {
      calls.reads.push(req);
      expect(req).toMatchObject({ address: ORG_META, functionName: "links" });
      return LINKS;
    },
    async multicall(req: { allowFailure: boolean; contracts: { address: Address; functionName: string; args: readonly [Address, bigint, `0x${string}`] }[] }) {
      expect(req.allowFailure).toBe(false);
      return req.contracts.map((call) => {
        calls.renders.push(call);
        const field = Object.keys(rendered).find((f) => stringToHex(f, { size: 32 }) === call.args[2]);
        return ["text/plain", stringToHex(rendered[field!]!)];
      });
    },
  } as unknown as PublicClient;
  return { c, calls };
}

describe("readTokenLinks", () => {
  it("returns what the org's links renderer renders for each field", async () => {
    const { c, calls } = client({
      animation_url: `https://gateway.example/g/p/84532/${ORG}/7/latest/`,
      external_url: `https://gateway.example/projects/84532/${ORG}/7`,
    });
    expect(await readTokenLinks(c, ORG_META, ORG, 7n)).toEqual({
      animationUrl: `https://gateway.example/g/p/84532/${ORG}/7/latest/`,
      externalUrl: `https://gateway.example/projects/84532/${ORG}/7`,
    });
    expect(calls.reads).toHaveLength(1);
    expect(calls.renders).toEqual([
      expect.objectContaining({ address: LINKS, functionName: "render", args: [ORG, 7n, stringToHex("animation_url", { size: 32 })] }),
      expect.objectContaining({ address: LINKS, functionName: "render", args: [ORG, 7n, stringToHex("external_url", { size: 32 })] }),
    ]);
  });

  it("returns an owner's abxfs.view as is, since the renderer does", async () => {
    const { c } = client({ animation_url: "https://my-site.example/", external_url: "https://my-site.example/" });
    expect(await readTokenLinks(c, ORG_META, ORG, 1n)).toEqual({
      animationUrl: "https://my-site.example/",
      externalUrl: "https://my-site.example/",
    });
  });
});
