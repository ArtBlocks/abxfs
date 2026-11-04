/**
 * The CLI must run when started the way npm starts it.
 *
 * `node_modules/.bin/abxfs` and a global install are both SYMLINKS to `dist/index.js`. The entry-point
 * check once compared the symlink's path to the real file's, concluded the module had merely been
 * imported, and exited 0 having printed nothing at all — so a published CLI would have installed
 * cleanly and then silently done nothing. Nothing in the repo caught it, because inside the repo the
 * CLI is run by its direct path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const DIST = resolve(__dirname, "../dist/index.js");

describe.skipIf(!existsSync(DIST))("entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-bin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (bin: string) => execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });

  it("prints help when run by its direct path", () => {
    expect(run(DIST)).toMatch(/Usage: abxfs/);
  });

  it("prints help when run through a symlink, as npm and a global install do", () => {
    const link = join(dir, "abxfs");
    symlinkSync(DIST, link);
    expect(run(link)).toMatch(/Usage: abxfs/);
  });

  it("lists the org commands, so a stale build is not mistaken for a working one", () => {
    expect(run(DIST)).toMatch(/\borg\b/);
  });
});
