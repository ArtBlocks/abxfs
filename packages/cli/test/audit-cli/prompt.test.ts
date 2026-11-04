/**
 * `confirmTyped`, the one prompt every irreversible write goes through: a typed "yes" on a terminal, a refusal
 * naming the opt-out flag without one. Unit-tested with a stand-in readline, and end to end on a real pseudo-terminal
 * (through python3's `pty`, skipped where there is none).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => ({ next: "yes", asked: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => (answers.asked.push(q), answers.next),
    close: () => undefined,
  }),
}));

import { confirmTyped } from "../../src/prompt.js";

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  answers.asked.length = 0;
});

describe("confirmTyped", () => {
  it("without a terminal it refuses, naming the flag that answers for scripts", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(confirmTyped("Send it?", { flag: "--yes" })).rejects.toThrow(/without a TTY to confirm on — pass --yes/);
    expect(answers.asked).toEqual([]);
  });

  it.each([
    ["yes", true],
    [" YES ", true],
    ["y", false],
    ["no", false],
    ["", false],
    ["yes please", false],
  ])("on a terminal, %j is %s", async (typed, ok) => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    answers.next = typed;
    expect(await confirmTyped("Send it?", { flag: "--yes" })).toBe(ok);
    expect(answers.asked).toEqual(['Send it? (type "yes") ']);
  });

  it("asks for a custom word when given one", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    answers.next = "transfer";
    expect(await confirmTyped("Really?", { flag: "--yes", expected: "transfer" })).toBe(true);
    expect(answers.asked[0]).toContain('(type "transfer")');
  });
});

const PROMPT_DIST = resolve(__dirname, "../../dist/prompt.js");
const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

/** Run `confirmTyped` from the built CLI on a real pseudo-terminal, type `answer` once the prompt shows. */
function onPty(answer: string): string {
  const script = `
import os, pty, sys, select, time
node, dist, answer = sys.argv[1], sys.argv[2], sys.argv[3]
js = "import(process.argv[1]).then(async (m) => { const ok = await m.confirmTyped('Send it?', { flag: '--yes' }); console.log('ANSWER=' + ok); process.exit(0); })"
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, "-e", js, dist])
out = b""
sent = False
deadline = time.time() + 15
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and b'(type "yes")' in out:
        os.write(fd, (answer + "\\n").encode())
        sent = True
    if b"ANSWER=" in out and out.rstrip().endswith((b"true", b"false")):
        break
os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
`;
  const r = spawnSync("python3", ["-c", script, process.execPath, PROMPT_DIST, answer], { encoding: "utf8", timeout: 20_000 });
  return r.stdout;
}

describe.skipIf(!hasPty || !existsSync(PROMPT_DIST))("confirmTyped on a real terminal", () => {
  it("a typed yes confirms", () => {
    expect(onPty("yes")).toMatch(/Send it\? \(type "yes"\)[\s\S]*ANSWER=true/);
  });
  it("anything else does not", () => {
    expect(onPty("no")).toMatch(/ANSWER=false/);
  });
});
