/**
 * AUDIT4 (cross-cutting): every non-canonical spelling of a project host that the live content origin was probed
 * with (curl against a production build) must stay refused by the one parser, because a second spelling is a
 * filter bypass. Regression guard, no FINDINGs.
 */
import { describe, expect, it } from "vitest";

import { parseContentHost } from "../../src/content-host.js";

const ORG = "91fb3003e63773e60b1bfc22f634dd43194adbca";
const BASE = "abxfs.app";

describe("AUDIT4X content host spellings", () => {
  it("accepts exactly the canonical forms", () => {
    expect(parseContentHost(`84532-${ORG}-0.${BASE}`, BASE)).toMatchObject({ kind: "project" });
    expect(parseContentHost(`84532-${ORG}-0-v1.${BASE}`, BASE)).toMatchObject({ kind: "project" });
  });

  it("refuses leading zeros, 0x, trailing dots, wrong labels, nested subdomains and foreign bases", () => {
    for (const host of [
      `84532-${ORG}-00.${BASE}`,
      `84532-${ORG}-0-v01.${BASE}`,
      `84532-${ORG}-0-v0.${BASE}`,
      `84532-0x${ORG}-0.${BASE}`,
      `084532-${ORG}-0.${BASE}`,
      `84532-${ORG}-0.${BASE}.`,
      `x.84532-${ORG}-0.${BASE}`,
      `84532-${ORG}-0.${BASE}.evil.example`,
      `84532-${ORG}-0.evil.example`,
      `84532-${ORG.slice(0, 39)}-0.${BASE}`,
      `+84532-${ORG}-0.${BASE}`,
      `84532-${ORG}-0.${BASE}:80@evil.example`,
    ]) {
      expect(parseContentHost(host, BASE), host).toBeNull();
    }
  });
});
