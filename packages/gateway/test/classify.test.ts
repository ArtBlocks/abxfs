/**
 * One strict parse decides what a URL names. These pin the verdicts middleware relies on: a path is
 * canonical (and yields subjects), or it is `invalid` and refused, or it is not a governed tree at all.
 */
import { describe, expect, it } from "vitest";

import { classifyPath, parseSubject, projectSubjectParts, subjectsForPath } from "../src/subjects.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const ROOT = `0x${"ab".repeat(32)}`;

describe("classifyPath", () => {
  it("names a project and its org, or a root, or an org", () => {
    expect(classifyPath(`/g/p/84532/${ORG}/7/latest/x`)).toEqual({ kind: "subjects", subjects: [`project:84532:${ORG}:7`, `org:84532:${ORG}`] });
    expect(classifyPath(`/projects/84532/${ORG}/7/files/a.html`)).toMatchObject({ kind: "subjects", subjects: [`project:84532:${ORG}:7`, `org:84532:${ORG}`] });
    expect(classifyPath(`/g/cid/84532/${ROOT}/index.html`)).toEqual({ kind: "subjects", subjects: [`root:${ROOT}`] });
    expect(classifyPath(`/orgs/84532/${ORG}`)).toEqual({ kind: "subjects", subjects: [`org:84532:${ORG}`] });
  });

  it("lowercases addresses and roots, whatever case the URL carried", () => {
    const up = ORG.toUpperCase().replace("0X", "0x");
    expect(subjectsForPath(`/g/p/84532/${up}/7/latest/`)[1]).toBe(`org:84532:${ORG}`);
    expect(subjectsForPath(`/g/cid/84532/${ROOT.toUpperCase().replace("0X", "0x")}/`)).toEqual([`root:${ROOT}`]);
  });

  it("is `invalid` for every spelling a looser parser would accept", () => {
    for (const chain of ["+84532", "0x14a34", "84532.0", "8.4532e4", "084532", "0", "-1", "1e3", "٨٤٥٣٢"]) {
      expect(classifyPath(`/g/p/${chain}/${ORG}/1/latest/`).kind, chain).toBe("invalid");
      expect(classifyPath(`/projects/${chain}/${ORG}/1`).kind, chain).toBe("invalid");
      expect(classifyPath(`/orgs/${chain}/${ORG}`).kind, chain).toBe("invalid");
      expect(classifyPath(`/g/cid/${chain}/${ROOT}/`).kind, chain).toBe("invalid");
      expect(classifyPath(`/g/cid/${chain}/${ROOT}/`).kind, chain).toBe("invalid");
    }
    for (const token of ["01", "+1", "1.0", "0x1", "-0"]) {
      expect(classifyPath(`/projects/84532/${ORG}/${token}`).kind, token).toBe("invalid");
    }
    expect(classifyPath(`/projects/84532/0x1234/1`).kind).toBe("invalid");
    expect(classifyPath(`/g//p/84532/${ORG}/1/latest/`).kind).toBe("invalid");
    expect(classifyPath(`/g/cid/84532/0xabc`).kind).toBe("invalid");
    expect(classifyPath(`/g/cid/${ROOT}/`).kind).toBe("invalid"); // no chain
  });

  it("leaves other trees alone, and the new-project page", () => {
    for (const p of ["/", "/projects", "/projects/new", "/api/status", "/about", "/policy", "/_next/static/a.js"]) {
      expect(classifyPath(p).kind, p).toBe("none");
    }
  });
});

describe("subject strictness", () => {
  it("accepts only canonical subject strings", () => {
    expect(parseSubject(`PROJECT:84532:${ORG.toUpperCase().replace("0X", "0x")}:1`)).toBe(`project:84532:${ORG}:1`);
    for (const s of [`project:084532:${ORG}:1`, `project:84532:${ORG}:01`, `project:+84532:${ORG}:1`, `org:0:${ORG}`, `org:84532:${ORG.slice(0, 20)}`, `root:${ROOT.slice(0, 40)}`]) {
      expect(parseSubject(s), s).toBeNull();
    }
  });

  it("round-trips project parts and refuses ids past 2^53", () => {
    expect(projectSubjectParts(`project:84532:${ORG}:7`)).toEqual({ chainId: 84532, org: ORG, tokenId: 7 });
    expect(projectSubjectParts(`project:84532:${ORG}:99999999999999999999`)).toBeNull();
  });
});
