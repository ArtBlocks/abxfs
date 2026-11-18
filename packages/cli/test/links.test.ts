/**
 * `printProjectLinks` prints what the org's links renderer renders. In an org with `projectPresentation` the token's
 * `animation_url` comes from the presentation contract instead, so the first line must not claim to be it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbxfsClient } from "@artblocks/abxfs-sdk";

import { printProjectLinks } from "../src/links.js";
import { CONTENT_ADDRESSES } from "./helpers/mock-client.js";

const LIVE = "https://gw.example/g/p/84532/0x00000000000000000000000000000000000000a1/7/latest/";
const PAGE = "https://gw.example/projects/84532/0x00000000000000000000000000000000000000a1/7";
const client = (addresses: Record<string, unknown>) =>
  ({ addresses, readTokenLinks: async () => ({ animationUrl: LIVE, externalUrl: PAGE }) }) as unknown as Pick<AbxfsClient, "readTokenLinks" | "addresses">;

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("printProjectLinks", () => {
  it("labels the renderer's animation_url as the token's own in an org from the original factory", async () => {
    await printProjectLinks(client(CONTENT_ADDRESSES), 7n);
    expect(out[0]).toContain(`live at: ${LIVE} (the token's animation_url)`);
    expect(out[1]).toContain(`${PAGE} (the token's external_url)`);
  });

  it("does not call it the token's animation_url in an org with presentation, and says where that is", async () => {
    await printProjectLinks(client({ ...CONTENT_ADDRESSES, projectPresentation: "0x00000000000000000000000000000000000000e8" }), 7n, { afterWrite: false });
    expect(out[0]).toContain(LIVE);
    expect(out[0]).not.toContain("(the token's animation_url)");
    expect(out[0]).toMatch(/used by orgs from the original factory; this token's animation follows its presentation: abxfs presentation inspect/);
    expect(out[1]).toContain(`${PAGE} (the token's external_url)`);
  });
});
