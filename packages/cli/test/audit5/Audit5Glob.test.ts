import { describe, expect, it } from "vitest";
import { isAllowedPublic, validateAllowPublicGlob, globToRegExp } from "../../src/scan-guard.js";

const ok = (g: string) => { try { validateAllowPublicGlob(g); return true; } catch { return false; } };
const allow = (p: string, ...g: string[]) => isAllowedPublic(p, g);

describe("Audit5 --allow-public matcher", () => {
  it("match-all globs refused", () => {
    const refused = ["*", "**", "**/*", "?*", "*.*", "**/.*", ".*", "./*", "*/*", "**/**", "?", "??", "*?*?", "[!x]*", "{*,x}", "*/", "/", ".", "..", "*.", "**/*.*", "*-", "*_", "-", "_*", "*-*", "-*-", "*_*"]; 
    const accepted = refused.filter(ok);
    expect(accepted).toEqual([]);
    // The near-match-all ones the audit found are all refused:
    for (const g of ["*_*", "*-*", "*a*", "*1*", "?e*", "*.e", "*e", "*ab*", "**/*_*", "dir/*-*", "a?*"]) expect(ok(g), g).toBe(false);
  });
  it("legitimate patterns still validate", () => {
    for (const g of ["*.pub", ".env", ".env.production", "keys/*.pub", "*abc*", "service-account-prod.json", "a/b/c.txt", "./deploy.key"]) expect(ok(g), g).toBe(true);
  });
  it("the refusal lists what the pattern would have approved in this upload", () => {
    const files = ["a_b.txt", "src/c_d.js", "README.md", "id_rsa", "private_key.pem"];
    let msg = "";
    try { validateAllowPublicGlob("*_*", files); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/would approve 4 of 5 file\(s\)/);
    expect(msg).toContain("a_b.txt");
    expect(msg).toContain("private_key.pem");
    expect(msg).not.toContain("README.md");
  });
  it("the near-match-all patterns approve nothing at isAllowedPublic either", () => {
    for (const g of ["*_*", "*-*", "*a*", "?e*", "*.e"]) for (const p of ["id_rsa", "service-account-prod.json", "private_key.pem"]) expect(isAllowedPublic(p, [g])).toBe(false);
  });
  it("what approves what", () => {
    const rows: Array<[string, string]> = [["*.env", ".env"], ["*.env", "prod.env"], [".env", "a/b/.env"], [".env", ".env.local"], ["*.pub", "a/b/id_rsa.pub"], ["keys/*.pub", "keys/a.pub"], ["keys/*.pub", "x/keys/a.pub"], ["keys/*.pub", "keys/sub/a.pub"], ["keys/**/*.pub", "keys/a.pub"], ["**/*.pem", "a.pem"], ["*.pem", "a.PEM"], ["*.pem", "A.pem"], ["a[bc].pem", "ab.pem"], ["a[bc].pem", "a[bc].pem"], ["{a,b}.pem", "a.pem"], ["{a,b}.pem", "{a,b}.pem"], ["a\\.pem", "a.pem"], ["a\\.pem", "a\\.pem"], ["é.pem", "é.pem"], ["é.pem", "é.pem"], ["keys\\a.pem", "keys/a.pem"], ["../a.pem", "a.pem"], ["/abs/a.pem", "abs/a.pem"], ["/abs/a.pem", "/abs/a.pem"], ["a.pem", "dir\\a.pem"], ["*.pem", "dir\\a.pem"], ["a?pem", "a/pem"], ["id_rsa*", "id_rsa.pub"], ["a.pem", ".a.pem"], ["*a.pem", ".a.pem"], ["**/a.pem", ".git/a.pem"], ["*.pem", "x.pem/"], ["*.pem", "x.pem\n"], ["*.pem", "x.pem\u0000y"], ["x.pem", "x.pem "]];
    for (const [g, p] of rows) console.log(`glob ${JSON.stringify(g)} path ${JSON.stringify(p)} => valid=${ok(g)} allowed=${allow(p, g)}`);
  });
  it("timing: 8 stars x 5000 char path, 256 char pattern", () => {
    const g = "*a".repeat(8) + "b".repeat(200);
    const t = performance.now(); for (let i = 0; i < 50; i++) globToRegExp(g).test("a".repeat(5000)); console.log("glob worst ms/50:", (performance.now() - t).toFixed(0));
    const t2 = performance.now(); isAllowedPublic("a/".repeat(2000) + "x", ["**/*a**/*a**/*a**/*a**/*a**/*a**/*a**/*b"]); console.log("dstar ms:", (performance.now() - t2).toFixed(0));
    expect(performance.now() - t2).toBeLessThan(3000);
  });
  it("? and ** crossing", () => {
    expect(allow("a/b", "a?b")).toBe(false);
    expect(allow("a/b.pem", "a**.pem")).toBe(true);
  });
});
