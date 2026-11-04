import { describe, expect, it } from "vitest";
import { isAllowedPublic, validateAllowPublicGlob } from "../src/scan-guard.js";

const accepted = (g: string) => { try { validateAllowPublicGlob(g); return true; } catch { return false; } };

describe("--allow-public refuses globs that approve a class of secrets", () => {
  for (const g of ["*.json", "*key*", "*env*", "*sec*", "*cred*", "*son", "*.pem", "*.key", "**/*.json", "config/**", "*.PEM", "keys/*.pem", "id_*"]) {
    it(`refuses ${g}`, () => {
      expect(accepted(g)).toBe(false);
      expect(isAllowedPublic("a/server.key", [g])).toBe(false);
    });
  }
  it("gives a clear message", () => {
    expect(() => validateAllowPublicGlob("*.json")).toThrow(/whole class of secrets/);
  });
  for (const g of ["*.pub", "keys/*.pub", "dist/*.js", "public-key.txt", ".env.production", "certs/server.pem"]) {
    it(`accepts ${g}`, () => expect(accepted(g)).toBe(true));
  }
  it("an exact secret path still approves exactly that file", () => {
    expect(isAllowedPublic("certs/server.pem", ["certs/server.pem"])).toBe(true);
    expect(isAllowedPublic("certs/other.pem", ["certs/server.pem"])).toBe(false);
  });
});
