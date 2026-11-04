/**
 * Filters decide what a gateway refuses, from the URL alone. What matters is that they fail the right
 * way: an allowlist must not wave through what it cannot classify, and a list file that cannot be
 * re-read must keep the last good policy rather than dropping to "everything" or "nothing".
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allOf,
  allowlistFilter,
  denylistFilter,
  fileFilter,
  orgAllowlistFilter,
  orgAllowlistFromArg,
  parseListFile,
  parseOrgList,
} from "../src/filters.js";
import { orgSubject, projectSubject, rootSubject, subjectsForPath } from "../src/subjects.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";
const ROOT = `0x${"ab".repeat(32)}`;
const ctx = (path: string) => ({ subjects: subjectsForPath(path) });

describe("denylistFilter", () => {
  it("refuses a request that names a listed project, org or root", async () => {
    const f = denylistFilter([projectSubject(84532, ORG, 2), orgSubject(84532, OTHER), rootSubject(ROOT)]);
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toMatchObject({ allow: false });
    expect(await f(ctx(`/g/p/84532/${OTHER}/9/latest/`))).toMatchObject({ allow: false }); // via its org
    expect(await f(ctx(`/g/cid/${ROOT}/index.html`))).toMatchObject({ allow: false });
  });

  it("serves everything else, and the same token id in another org", async () => {
    const f = denylistFilter([projectSubject(84532, ORG, 2)]);
    expect(await f(ctx(`/g/p/84532/${ORG}/3/latest/`))).toEqual({ allow: true });
    expect(await f(ctx(`/g/p/84532/${OTHER}/2/latest/`))).toEqual({ allow: true });
  });

  /** An uppercase or checksummed spelling is the same org; if it were a different string, retyping the
   *  address would walk around the list. */
  it("matches every spelling of an address", async () => {
    const f = denylistFilter([orgSubject(84532, ORG)]);
    expect(await f(ctx(`/g/p/84532/${ORG.toUpperCase().replace("0X", "0x")}/1/latest/`))).toMatchObject({ allow: false });
  });

  it("with an empty list refuses nothing, which is the protocol's own position", async () => {
    const f = denylistFilter([]);
    expect(await f(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
  });

  it("ignores entries that are not subjects instead of failing", async () => {
    const f = denylistFilter(["not a subject", "project:1:2", projectSubject(84532, ORG, 2)]);
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toMatchObject({ allow: false });
  });
});

describe("allowlistFilter", () => {
  it("serves only what the list names, and an org admits every project under it", async () => {
    const f = allowlistFilter([orgSubject(84532, ORG)]);
    expect(await f(ctx(`/g/p/84532/${ORG}/7/latest/`))).toEqual({ allow: true });
    expect(await f(ctx(`/g/p/84532/${OTHER}/7/latest/`))).toMatchObject({ allow: false });
  });

  it("does not admit an org's raw-CID URLs: those name a root, not an org", async () => {
    const f = allowlistFilter([orgSubject(84532, ORG)]);
    expect(await f(ctx(`/g/cid/${ROOT}/`))).toMatchObject({ allow: false });
    expect(await allowlistFilter([rootSubject(ROOT)])(ctx(`/g/cid/${ROOT}/`))).toEqual({ allow: true });
  });

  /** The point of an allowlist: what it cannot classify is refused, not waved through. */
  it("refuses a request that names nothing recognisable", async () => {
    const f = allowlistFilter([orgSubject(84532, ORG)]);
    expect(await f({ subjects: [] })).toMatchObject({ allow: false });
  });
});

describe("allOf", () => {
  it("requires every filter, and keeps the first refusal's reason", async () => {
    const f = allOf(allowlistFilter([orgSubject(84532, ORG)]), denylistFilter([projectSubject(84532, ORG, 2)]));
    expect(await f(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toEqual({ allow: false, reason: "denylisted" });
    expect(await f(ctx(`/g/p/84532/${OTHER}/1/latest/`))).toEqual({ allow: false, reason: "not allowlisted" });
  });
});

describe("parseListFile", () => {
  it("reads one subject per line, with comments and blank lines", () => {
    const bad: string[] = [];
    const list = parseListFile(
      `# a comment\n\n${projectSubject(84532, ORG, 2)}   # trailing note\n  ${orgSubject(84532, OTHER)}\r\nnope\n`,
      (line) => bad.push(line),
    );
    expect(list).toEqual([projectSubject(84532, ORG, 2), orgSubject(84532, OTHER)]);
    expect(bad).toEqual(["nope"]);
  });
});

describe("fileFilter", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abxfs-gw-"));
    path = join(dir, "list.txt");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bump = (seconds: number) => {
    const t = new Date(Date.now() + seconds * 1000);
    utimesSync(path, t, t);
  };

  it("applies the file, then follows an edit with no restart", async () => {
    writeFileSync(path, `${projectSubject(84532, ORG, 2)}\n`);
    const f = fileFilter(path, "deny", { refreshMs: 0 });
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toMatchObject({ allow: false });
    expect(await f(ctx(`/g/p/84532/${ORG}/3/latest/`))).toEqual({ allow: true });

    writeFileSync(path, `${projectSubject(84532, ORG, 3)}\n`);
    bump(5);
    expect(await f(ctx(`/g/p/84532/${ORG}/3/latest/`))).toMatchObject({ allow: false });
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toEqual({ allow: true });
  });

  /** A gateway told to apply a policy that cannot load it must not quietly serve without one. */
  it("refuses to start without its file", () => {
    expect(() => fileFilter(join(dir, "missing.txt"), "deny")).toThrow();
  });

  /** A transient disk error must not turn a deny list into "everything is allowed". */
  it("keeps the last good list when a re-read fails", async () => {
    writeFileSync(path, `${projectSubject(84532, ORG, 2)}\n`);
    const errors: unknown[] = [];
    const f = fileFilter(path, "deny", { refreshMs: 0, onError: (e) => errors.push(e) });
    rmSync(path);
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toMatchObject({ allow: false });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports an invalid line and carries on with the rest", async () => {
    writeFileSync(path, `garbage\n${projectSubject(84532, ORG, 2)}\n`);
    const bad: string[] = [];
    const f = fileFilter(path, "deny", { onInvalid: (l) => bad.push(l) });
    expect(bad).toEqual(["garbage"]);
    expect(await f(ctx(`/g/p/84532/${ORG}/2/latest/`))).toMatchObject({ allow: false });
  });
});

describe("orgAllowlistFilter", () => {
  it("serves a listed org's projects on any chain, and nothing else", async () => {
    const f = orgAllowlistFilter([ORG]);
    expect(await f(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
    expect(await f(ctx(`/g/p/8453/${ORG}/7/v/2/a.css`))).toEqual({ allow: true });
    expect(await f(ctx(`/g/p/84532/${OTHER}/1/latest/`))).toMatchObject({ allow: false });
  });

  it("matches every spelling of the address", async () => {
    const f = orgAllowlistFilter([ORG.toUpperCase().replace("0X", "0x")]);
    expect(await f(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
  });

  /** A raw root names content, not an org: an orgs-only gateway has nothing to check it against. */
  it("refuses a bare CID URL, and what it cannot classify", async () => {
    const f = orgAllowlistFilter([ORG]);
    expect(await f(ctx(`/g/cid/${ROOT}/index.html`))).toMatchObject({ allow: false });
    expect(await f({ subjects: [] })).toMatchObject({ allow: false });
  });

  it("with an empty list serves nothing, rather than everything", async () => {
    expect(await orgAllowlistFilter([])(ctx(`/g/p/84532/${ORG}/1/latest/`))).toMatchObject({ allow: false });
  });

  it("ignores entries that are not addresses", async () => {
    const f = orgAllowlistFilter(["nope", ORG]);
    expect(await f(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
  });
});

describe("--allow-orgs argument", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "orgs-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a list of addresses, a single address, or a file", async () => {
    expect(await orgAllowlistFromArg(`${ORG},${OTHER}`)(ctx(`/g/p/84532/${OTHER}/1/latest/`))).toEqual({ allow: true });
    expect(await orgAllowlistFromArg(ORG)(ctx(`/g/p/84532/${ORG}/1/latest/`))).toEqual({ allow: true });
    const file = join(dir, "orgs.txt");
    writeFileSync(file, `# my orgs\n${ORG}\norg:84532:${OTHER}   # also this\nnot-an-address\n`);
    const bad: string[] = [];
    const f = orgAllowlistFromArg(file, { onInvalid: (l) => bad.push(l) });
    expect(await f(ctx(`/g/p/84532/${OTHER}/1/latest/`))).toEqual({ allow: true });
    expect(bad).toEqual(["not-an-address"]);
  });

  it("fails loudly on a typo in an inline list, instead of serving less than you asked for", () => {
    expect(() => orgAllowlistFromArg(`${ORG},0x123`)).toThrow(/not an address/);
  });

  it("parses a file with comments and blank lines", () => {
    expect(parseOrgList(`\n# x\n${ORG} # trailing\n`)).toEqual([ORG]);
  });
});
