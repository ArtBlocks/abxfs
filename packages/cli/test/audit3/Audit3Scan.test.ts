import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDirectoryReport } from "../../src/fsscan.js";

const mk = () => mkdtempSync(join(tmpdir(), "a3scan-"));

describe("Audit3 fsscan", () => {
  it("a symlinked ROOT is refused, and the message says where it points", () => {
    const real = mk(); writeFileSync(join(real, "config.yml"), "oauth_token: gho_" + "a".repeat(30));
    const holder = mk(); symlinkSync(real, join(holder, "public"));
    expect(() => scanDirectoryReport(join(holder, "public"))).toThrow(/symlink.*to ".*a3scan-/s);
    // a trailing slash does not follow it either
    expect(() => scanDirectoryReport(join(holder, "public") + "/")).toThrow(/symlink/);
    // the real directory works, and now the gho_ token IS recognised
    expect(scanDirectoryReport(real).secretLike).toEqual(["config.yml"]);
  });
  it("hardlink to a private file inside the tree is read (cannot be detected; accepted)", () => {
    const priv = mk(); writeFileSync(join(priv, "notes.txt"), "pw=hunter2");
    const d = mk(); linkSync(join(priv, "notes.txt"), join(d, "a.txt"));
    expect(scanDirectoryReport(d).files.length).toBe(1);
  });
  it("PERF: 5000 files incl. 64-hex minified JS; .env.example is a template, not a secret", () => {
    const d = mk(); mkdirSync(join(d, "assets"));
    for (let i = 0; i < 5000; i++) writeFileSync(join(d, "assets", `f${i}.js`), `var a="${"0123456789abcdef".repeat(4)}";`.repeat(50));
    writeFileSync(join(d, ".env.example"), "A=1");
    writeFileSync(join(d, ".env"), "A=1");
    const t = performance.now();
    const r = scanDirectoryReport(d, { includeHidden: true });
    expect(performance.now() - t).toBeLessThan(15000);
    expect(r.secretLike).toEqual([".env"]);
  });
  it("class names containing 'task-...' no longer trigger a secret prompt for an innocent site", () => {
    const d = mk(); writeFileSync(join(d, "index.html"), '<div class="task-manager-dashboard-wrapper">hi</div><style>.risk-assessment-framework-panel{}</style>');
    expect(scanDirectoryReport(d).secretLike).toEqual([]);
  });
  it("server.pem.bak is flagged, secrets.md / credentials.html / secret.png are not", () => {
    const d = mk();
    for (const n of ["server.pem.bak", "my-id_rsa", "config.secret", "secrets.md", "credentials.html", "secret.png"]) writeFileSync(join(d, n), "x");
    expect(scanDirectoryReport(d).secretLike).toEqual(["config.secret", "my-id_rsa", "server.pem.bak"]);
  });
  it("wallet.txt is flagged only when it holds a recovery phrase", () => {
    const d = mk();
    writeFileSync(join(d, "wallet.txt"), "abandon ability able about above absent absorb abstract absurd abuse access accident");
    writeFileSync(join(d, "seed.txt"), "Seeds are planted in spring.");
    expect(scanDirectoryReport(d).secretLike).toEqual(["wallet.txt"]);
  });
  it("a key far past 4 KB is caught by the tail sniff", () => {
    const d = mk(); writeFileSync(join(d, "big.txt"), " ".repeat(50_000) + "\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n");
    expect(scanDirectoryReport(d).secretLike).toEqual(["big.txt"]);
  });
});
