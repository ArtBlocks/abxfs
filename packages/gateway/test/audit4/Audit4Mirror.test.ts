import { mkdtemp, readFile, writeFile, symlink, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cursorPathFor, fileCursor, readCursorFile } from "../../src/mirror.js";

const G = (h: string) => ({ orgFactory: "0x" + "f".repeat(40), projectHook: h, lens: "0x" + "1".repeat(40) }) as never;
const H1 = "0x1111111122222222222222222222222222222222";
const H2 = "0xaaaaaaaa33333333333333333333333333333333";

describe("AUDIT4 mirror cursors", () => {
  it("tampered values: huge/negative/string/NaN-ish/Infinity are read as what?", async () => {
    const d = await mkdtemp(join(tmpdir(), "a4-"));
    const out: Record<string, unknown> = {};
    for (const [name, body] of Object.entries({ neg: '{"next":-5}', str: '{"next":"7"}', inf: '{"next":1e999}', frac: '{"next":3.9}', big: '{"next":9007199254740993}', arr: '{"next":[1]}', trunc: '{"next":12' })) {
      const p = join(d, name + ".json");
      await writeFile(p, body);
      try { out[name] = (await readCursorFile(p))?.next; } catch (e) { out[name] = "THROWS " + (e as Error).name; }
    }
    console.log("CURSOR-TAMPER", JSON.stringify(out, (_k, v) => (v === Infinity ? "Infinity" : v)));
  });

  it("symlinked cursor: save replaces the link, not its target", async () => {
    const d = await mkdtemp(join(tmpdir(), "a4-"));
    const target = join(d, "target.json");
    await writeFile(target, '{"next":5}');
    const link = join(d, "link.json");
    await symlink(target, link);
    await fileCursor(link).save(9, 10);
    console.log("SYMLINK", "target still:", (await readFile(target, "utf8")).trim(), "| link is symlink:", (await lstat(link)).isSymbolicLink());
  });

  it("two processes interleaving saves can move the cursor BACKWARDS (replay only)", async () => {
    const d = await mkdtemp(join(tmpdir(), "a4-"));
    const p = join(d, "c.json");
    const a = fileCursor(p, { hook: H1 }), b = fileCursor(p, { hook: H1 });
    await a.save(100, 200); await b.save(50, 200);
    expect(await a.load()).toBe(50);
  });

  it("path traversal in base is the operator's; the hook suffix is hex only", () => {
    expect(cursorPathFor("../../etc/x.json", { projectHook: H1 })).toBe("../../etc/x.11111111.json");
    expect(cursorPathFor("./d/", { projectHook: H1 })).toBe("./d/.11111111.json");
  });

  it("same hook on two chains with a shared custom --cursor base: the hook check does NOT include the chain", async () => {
    const d = await mkdtemp(join(tmpdir(), "a4-"));
    const p = cursorPathFor(join(d, "shared.json"), { projectHook: H1 });
    await fileCursor(p, { hook: H1 }).save(40, 50); // chain A
    expect(await fileCursor(p, { hook: H1 }).load()).toBe(40); // chain B with identical hook address follows A's index
  });
});
