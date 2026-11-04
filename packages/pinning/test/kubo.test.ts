/**
 * Optional: against a real Kubo binary, when one is on PATH (skipped otherwise). In a throwaway offline repo it checks
 * that `ipfs dag import` accepts the CAR and pins its root, and that `ipfs add -r` of the same tree on disk (an empty
 * directory and an empty file included) gives the same root: the derivation and the CAR agree with IPFS itself.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AbxfsCid, AbxfsClient } from "@abxfs/sdk";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;
const FILES = new Map<string, Uint8Array>([
  [c(100), new TextEncoder().encode("<html>kubo</html>")],
  [c(101), new Uint8Array(0)],
  [c(102), Uint8Array.from({ length: 300 * 1024 }, (_, i) => (Math.imul(i, 2654435761) >>> 24) & 0xff)],
]);

vi.mock("@abxfs/sdk", async (orig) => ({
  ...(await orig<typeof import("@abxfs/sdk")>()),
  readFile: async (_pc: unknown, _a: unknown, cid: string) => ({ bytes: FILES.get(cid)! }),
}));

import { deriveCar } from "../src/pin.js";

function kuboInstalled(): boolean {
  try {
    return spawnSync("ipfs", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const SHOULD_SKIP = !kuboInstalled();
if (SHOULD_SKIP) console.warn("kubo check skipped: no `ipfs` binary on PATH");

describe.skipIf(SHOULD_SKIP)("kubo agrees with the CAR", () => {
  const tmp = mkdtempSync(join(tmpdir(), "abxfs-kubo-"));
  const env = { ...process.env, IPFS_PATH: join(tmp, "repo") };
  const ipfs = (...args: string[]) => execFileSync("ipfs", args, { env, encoding: "utf8" }).trim();

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("imports and pins the CAR's root, which equals `ipfs add -r` of the same tree", async () => {
    const dirs = new Map<string, Array<{ name: string; cid: AbxfsCid; isDirectory: boolean }>>([
      [
        c(0),
        [
          { name: "index.html", cid: c(100), isDirectory: false },
          { name: "empty.txt", cid: c(101), isDirectory: false },
          { name: "big.bin", cid: c(102), isDirectory: false },
          { name: "empty", cid: c(1), isDirectory: true },
        ],
      ],
      [c(1), []],
    ]);
    const client = {
      addresses: {
        chunkStore: "0x0000000000000000000000000000000000000c57",
        directoryStore: "0x0000000000000000000000000000000000000d57",
        fileStore: "0x0000000000000000000000000000000000000f1e",
      },
      publicClient: {
        async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid] }) {
          const entries = dirs.get(args[0])!;
          return functionName === "entryCount" ? BigInt(entries.length) : entries;
        },
      },
    } as unknown as AbxfsClient;
    const derived = await deriveCar({ client, root: c(0), kind: "directory" });

    ipfs("init", "--profile=test");
    const carPath = join(tmp, "tree.car");
    writeFileSync(carPath, new Uint8Array(await derived.car.arrayBuffer()));
    const imported = JSON.parse(ipfs("dag", "import", "--pin-roots", "--offline", "--enc=json", carPath)) as {
      Root: { Cid: { "/": string }; PinErrorMsg: string };
    };
    expect(imported.Root.Cid["/"]).toBe(derived.root);
    expect(imported.Root.PinErrorMsg).toBe("");
    expect(ipfs("pin", "ls", "--offline", "--type=recursive", derived.root)).toContain(derived.root);

    const tree = join(tmp, "tree");
    mkdirSync(join(tree, "empty"), { recursive: true });
    writeFileSync(join(tree, "index.html"), FILES.get(c(100))!);
    writeFileSync(join(tree, "empty.txt"), FILES.get(c(101))!);
    writeFileSync(join(tree, "big.bin"), FILES.get(c(102))!);
    expect(ipfs("add", "-r", "-Q", "--offline", "--only-hash", "--cid-version=1", tree)).toBe(derived.root);
  }, 120_000);
});
