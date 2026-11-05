/**
 * Gateway URL parsing and cache policy.
 *
 * These are the rules that decide what a URL addresses and how long it may be cached, so they are
 * worth pinning independently of any chain. The resolution behind them needs an RPC; the parsing does
 * not. They live with the gateway because the gateway is what owns them: the site and the standalone
 * server both run this code.
 */
import { describe, expect, it } from "vitest";
import { asAbxfsCid } from "@abxfs/sdk";

import {
  GatewayError,
  cacheControlFor,
  parseGatewayPath,
  type Addressing,
} from "../src/resolve.js";

const CID = asAbxfsCid(`0x${"ab".repeat(32)}`);
/** The parser folds whatever case the URL carried to lowercase. */
const ORG = "0x00000000000000000000000000000000000000a1";
const ORG_URL = ORG;
const parse = (segments: string[]) => parseGatewayPath(segments);

describe("parseGatewayPath", () => {
  it("parses a CID on its chain", () => {
    const r = parse(["cid", "84532", CID]);
    expect(r.addressing).toEqual({ kind: "cid", rootCid: CID });
    expect(r.subpath).toBe("");
  });

  it("parses a CID with a sub-path", () => {
    const r = parse(["cid", "84532", CID, "lib", "utils.js"]);
    expect(r.subpath).toBe("lib/utils.js");
  });

  it("parses latest, version, and tag selectors", () => {
    expect(parse(["p", "84532", ORG_URL, "7", "latest"]).addressing).toEqual({
      kind: "latest",
      org: ORG,
      tokenId: 7n,
    });
    expect(parse(["p", "84532", ORG_URL, "7", "v", "3"]).addressing).toEqual({
      kind: "version",
      org: ORG,
      tokenId: 7n,
      version: 3,
    });
    expect(parse(["p", "84532", ORG_URL, "7", "tag", "v1.2.3"]).addressing).toEqual({
      kind: "tag",
      org: ORG,
      tokenId: 7n,
      tag: "v1.2.3",
    });
  });

  it("treats a project with no selector as latest", () => {
    // `/g/p/84532/<org>/7` is the shortest thing a person will type or paste.
    expect(parse(["p", "84532", ORG_URL, "7"]).addressing).toEqual({
      kind: "latest",
      org: ORG,
      tokenId: 7n,
    });
  });

  /**
   * Segments arrive percent-encoded and are decoded individually, so `/` stays a separator while a
   * name containing `#`, `?`, or a space round-trips. A name with a literal `/` is not addressable —
   * true of every filesystem.
   */
  it("decodes each sub-path segment independently", () => {
    const r = parse(["cid", "84532", CID, "my%20dir", "a%23b.txt"]);
    expect(r.subpath).toBe("my dir/a#b.txt");
  });

  it("decodes a tag name, and refuses one that smuggles a path separator", () => {
    expect(parse(["p", "84532", ORG_URL, "7", "tag", "v1.2%20rc"]).addressing).toMatchObject({ tag: "v1.2 rc" });
    expect(() => parse(["p", "84532", ORG_URL, "7", "tag", "release%2F2024"])).toThrow(GatewayError);
  });

  it("carries the chain id from the path for project routes", () => {
    expect(parse(["p", "84532", ORG_URL, "7", "latest"]).chainId).toBe(84532);
  });

  /**
   * Two orgs can each have a token 7. The org is part of what a URL addresses, in any case, and the
   * parser must not collapse them.
   */
  it("keeps the same token id in two orgs distinct", () => {
    const other = "0x00000000000000000000000000000000000000b2";
    const a = parse(["p", "84532", ORG_URL, "7", "latest"]).addressing;
    const b = parse(["p", "84532", other, "7", "latest"]).addressing;
    expect(a).not.toEqual(b);
    // And a checksummed or uppercase URL is the same org as a lowercase one.
    expect(parse(["p", "84532", ORG_URL.toUpperCase().replace("0X", "0x"), "7", "latest"]).addressing).toEqual(a);
  });

  describe("rejections", () => {
    const cases: Array<[string, string[]]> = [
      ["unknown route", ["nope", "x"]],
      ["empty path", []],
      ["missing CID", ["cid"]],
      ["a CID with no chain", ["cid", CID]],
      ["a chain with no CID", ["cid", "84532"]],
      ["a non-canonical chain", ["cid", "084532", CID]],
      ["a hex chain", ["cid", "0x14a34", CID]],
      ["malformed CID", ["cid", "84532", "0xdeadbeef"]],
      ["non-numeric token id", ["p", "84532", ORG_URL, "seven", "latest"]],
      ["unknown selector", ["p", "84532", ORG_URL, "7", "head"]],
      ["version zero", ["p", "84532", ORG_URL, "7", "v", "0"]],
      ["non-numeric version", ["p", "84532", ORG_URL, "7", "v", "abc"]],
      ["missing tag name", ["p", "84532", ORG_URL, "7", "tag"]],
      ["bad chain id", ["p", "abc", ORG_URL, "7", "latest"]],
      // The old two-segment shape. A bare token id names a different project in every org, so it
      // must be refused rather than guessed at.
      ["a token id where the org belongs", ["p", "84532", "7", "latest"]],
      ["an org name instead of an address", ["p", "84532", "acme", "7", "latest"]],
      ["a truncated address", ["p", "84532", "0x1234", "7", "latest"]],
      ["no org at all", ["p", "84532"]],
      // The audit's filter bypass: spellings Number() accepts and a decimal regex does not. One
      // strict parser means they are refused here, not served while the filter sees nothing.
      ["a signed chain id", ["p", "+84532", ORG_URL, "7", "latest"]],
      ["a hex chain id", ["p", "0x14a34", ORG_URL, "7", "latest"]],
      ["a float chain id", ["p", "84532.0", ORG_URL, "7", "latest"]],
      ["an exponent chain id", ["p", "8.4532e4", ORG_URL, "7", "latest"]],
      ["a zero-padded chain id", ["p", "084532", ORG_URL, "7", "latest"]],
      ["a zero-padded token id", ["p", "84532", ORG_URL, "0007", "latest"]],
      ["a signed token id", ["p", "84532", ORG_URL, "+7", "latest"]],
      ["a zero-padded version", ["p", "84532", ORG_URL, "7", "v", "01"]],
      ["a chain id of zero", ["p", "0", ORG_URL, "7", "latest"]],
      ["a 64-hex root with no 0x", ["cid", "84532", "ab".repeat(32)]],
      ["a sub-path of dot-dot", ["cid", "84532", CID, ".."]],
      ["a sub-path with an encoded dot-dot", ["cid", "84532", CID, "%2e%2e"]],
      ["a sub-path with an encoded slash", ["cid", "84532", CID, "a%2f..%2fb"]],
      ["a sub-path with a backslash", ["cid", "84532", CID, "a%5cb"]],
      ["a sub-path with a NUL", ["cid", "84532", CID, "a%00b"]],
      ["a sub-path with a single dot", ["cid", "84532", CID, "."]],
      ["a malformed percent-escape", ["cid", "84532", CID, "%E0%A4%A"]],
    ];

    for (const [label, segments] of cases) {
      it(`rejects ${label}`, () => {
        expect(() => parseGatewayPath(segments)).toThrow(GatewayError);
      });
    }

    it("reports a 400 rather than a 500 for a malformed request", () => {
      // A bad URL is the caller's error. Returning 500 would make it look like ours, and would get
      // retried by clients that back off on 5xx.
      try {
        parse(["p", "84532", ORG_URL, "7", "v", "0"]);
        throw new Error("expected a throw");
      } catch (err) {
        expect((err as GatewayError).status).toBe(400);
      }
    });
  });
});

describe("cacheControlFor", () => {
  /**
   * The distinction that matters: whether a URL can ever address different bytes. Getting this wrong
   * in the immutable direction serves stale content forever; getting it wrong the other way puts the
   * chain-rebuild path on every request and gives up the CDN entirely.
   */
  it("marks a ROOT immutable, and nothing else", () => {
    expect(cacheControlFor({ kind: "cid", rootCid: CID })).toContain("immutable");
    expect(cacheControlFor({ kind: "cid", rootCid: CID })).toContain("max-age=31536000");
  });

  /**
   * A project's root is only known after resolving, i.e. behind the CDN, so a block on that root could
   * not reach an already-cached project URL. A short s-maxage bounds that window; a pinned version is
   * no exception.
   */
  it("never marks a project URL immutable, pinned version included, and keeps s-maxage short", () => {
    const project: Addressing[] = [
      { kind: "version", org: ORG, tokenId: 1n, version: 2 },
      { kind: "latest", org: ORG, tokenId: 1n },
      { kind: "tag", org: ORG, tokenId: 1n, tag: "stable" },
    ];
    for (const addressing of project) {
      const value = cacheControlFor(addressing);
      expect(value).not.toContain("immutable");
      expect(value).toMatch(/s-maxage=60\b/);
    }
  });


  it("keeps mutable pointers short-lived with stale-while-revalidate", () => {
    const mutable: Addressing[] = [
      { kind: "latest", org: ORG, tokenId: 1n },
      { kind: "tag", org: ORG, tokenId: 1n, tag: "stable" },
    ];
    for (const addressing of mutable) {
      const value = cacheControlFor(addressing);
      expect(value).not.toContain("immutable");
      expect(value).toContain("stale-while-revalidate");
    }
  });
});


describe("a /cid request names its chain", () => {
  /** A CID names content, not where it is stored: the URL says which chain to read, so nothing guesses. */
  it("reads the chain from the URL", () => {
    expect(parse(["cid", "8453", CID]).chainId).toBe(8453);
    expect(parse(["cid", "84532", CID]).chainId).toBe(84532);
  });
});
