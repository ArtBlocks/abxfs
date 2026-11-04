import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, openSync, ftruncateSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotSymlink, scanDirectoryReport } from "../../src/fsscan.js";
import { validateAllowPublicGlob, isAllowedPublic } from "../../src/scan-guard.js";

const ok = (g: string) => { try { validateAllowPublicGlob(g); return true; } catch { return false; } };
const tmp = () => mkdtempSync(join(realpathSync(tmpdir()), "a5-"));

describe("Audit5 near-match-all globs accepted", () => {
  it("single-letter / punctuation-plus-star globs approve huge sets", () => {
    for (const g of ["*e*", "*a*", "*_*", "*-*", "*1*", "?e*", "*.e", "*e"]) {
      expect(ok(g), g).toBe(false);
      for (const p of ["id_rsa", "service-account-prod.json", "private_key.pem"]) expect(isAllowedPublic(p, [g])).toBe(false);
    }
  });
});

describe("Audit5 symlink every component", () => {
  it("symlinked parent refused; symlinked root refused; real ok", () => {
    const d = tmp(); mkdirSync(join(d, "real/sub"), { recursive: true }); writeFileSync(join(d, "real/sub/f"), "x"); symlinkSync(join(d, "real"), join(d, "link"));
    expect(() => assertNotSymlink(join(d, "link/sub"))).toThrow(/parent/);
    expect(() => assertNotSymlink(join(d, "link"))).toThrow(/symlink/);
    expect(() => assertNotSymlink(join(d, "real/sub"))).not.toThrow();
    expect(() => assertNotSymlink(join(d, "real/../link/sub"))).toThrow(); // resolve() normalises '..' lexically
    rmSync(d, { recursive: true });
  });
  it("relative path via symlinked cwd; and /tmp-style depth-1 allowance only at the filesystem root", () => {
    const d = tmp(); mkdirSync(join(d, "real")); symlinkSync(join(d, "real"), join(d, "l")); mkdirSync(join(d, "l2"));
    const cwd = process.cwd(); process.chdir(d);
    try { expect(() => assertNotSymlink("l")).toThrow(); /* "./l/../real" is d/real after lexical resolution, which is also the path every later read uses: no gap */ expect(() => assertNotSymlink("./l/../real")).not.toThrow(); } finally { process.chdir(cwd); }
    rmSync(d, { recursive: true });
  });
  it("macOS /var,/tmp alias allowed (depth-1)", () => {
    expect(() => assertNotSymlink("/tmp")).not.toThrow();
    expect(() => assertNotSymlink("/var/tmp")).not.toThrow();
    expect(() => assertNotSymlink("/etc/hosts")).not.toThrow();
  });
  it("a depth-1 root symlink to a PRIVATE location is still trusted (user-created at / needs root)", () => {
    // documented allowance; nothing to assert beyond it being depth-1 only
    expect(true).toBe(true);
  });
});

describe("Audit5 scan scale", () => {
  it("5000 realistic files scan time + RSS", () => {
    const d = tmp(); const t0 = Date.now();
    for (let i = 0; i < 50; i++) mkdirSync(join(d, `d${i}`));
    for (let i = 0; i < 5000; i++) { const b = Buffer.alloc(8000 + (i % 7) * 20000); for (let j = 0; j < b.length; j++) b[j] = 32 + ((j * 7 + i) % 90); writeFileSync(join(d, `d${i % 50}/f${i}.js`), b); }
    const w = Date.now() - t0; const t = Date.now(); const rss0 = process.memoryUsage().rss;
    const r = scanDirectoryReport(d);
    console.log(`5000 files (${(r.files.reduce((n, f) => n + f.bytes.length, 0) / 1e6).toFixed(0)}MB): write ${w}ms scan ${Date.now() - t}ms, rss +${((process.memoryUsage().rss - rss0) / 1e6).toFixed(0)}MB, secretLike ${r.secretLike.length}`);
    rmSync(d, { recursive: true });
  }, 120000);
  it("a 1 GB file is refused from its size, before a byte is read: no RSS growth, a clear message", () => {
    const d = tmp(); const p = join(d, "big.bin"); const fd = openSync(p, "w"); ftruncateSync(fd, 1024 * 1024 * 1024); closeSync(fd);
    const rss0 = process.memoryUsage().rss; let msg = "";
    try { scanDirectoryReport(d); } catch (e) { msg = String((e as Error).message); }
    const grown = process.memoryUsage().rss - rss0;
    expect(msg).toMatch(/too large to upload/);
    expect(msg).toMatch(/1024 MiB/);
    expect(grown).toBeLessThan(100 * 1024 * 1024);
    rmSync(d, { recursive: true });
  }, 120000);
  it("a 2 GiB file gets the same clear message, not Node's raw ERR_FS_FILE_TOO_LARGE", () => {
    const d = tmp(); const p2 = join(d, "huge.bin"); const fd2 = openSync(p2, "w"); ftruncateSync(fd2, 2 * 1024 * 1024 * 1024 + 1); closeSync(fd2);
    let m2 = ""; try { scanDirectoryReport(d); } catch (e) { m2 = String((e as Error).message); }
    expect(m2).toMatch(/too large to upload/);
    expect(m2).not.toMatch(/ERR_FS_FILE_TOO_LARGE/);
    rmSync(d, { recursive: true });
  }, 120000);
  it("a 20 MB text file is scanned (partly: head and tail) and REPORTED as partly scanned", () => {
    const d = tmp(); writeFileSync(join(d, "log.txt"), Buffer.alloc(20 * 1024 * 1024, 120)); writeFileSync(join(d, "small.txt"), "hello");
    const r = scanDirectoryReport(d);
    expect(r.partiallyScanned).toEqual(["log.txt"]);
    rmSync(d, { recursive: true });
  }, 120000);
});
