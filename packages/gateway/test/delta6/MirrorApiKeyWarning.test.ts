/**
 * Delta audit round 6, I-1: the mirror printed its `--api-key` warning and THEN a refusal `runMirrorGenerations` makes
 * (a chain whose content layer is deployed and whose factory is not yet, or a generation with no lens). The warning now
 * rides `onStart`, which runs once every check has passed, so a refusal is the only line the bin prints.
 *
 * The bin runs in process, from `src`, against an SDK registry with each chain's content layer and no org layer.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MirrorGenerationsStats } from "../../src/mirror.js";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CONTENT = { chunkStore: at(0xc001), sstore2Backend: at(0xc002), fastLzBackend: at(0xc003), fileStore: at(0xc004), directoryStore: at(0xc005) };

let lines: string[] = [];
const argv = process.argv;

beforeEach(() => {
  vi.resetModules();
  lines = [];
  // The bin reads these as flag defaults: an operator's own environment must not decide what this test sees.
  for (const name of ["ABXFS_CHAIN", "ABXFS_DENYLIST", "ABXFS_ALLOWLIST", "ABXFS_ALLOW_ORGS", "PINATA_JWT"]) vi.stubEnv(name, "");
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.doMock("@abxfs/sdk", async (orig) => {
    const sdk = (await orig()) as typeof import("@abxfs/sdk");
    const deployments = Object.fromEntries(Object.values(sdk.CANONICAL_DEPLOYMENTS).map((d) => [d.chainId, { ...d, addresses: CONTENT }]));
    return { ...sdk, CANONICAL_DEPLOYMENTS: deployments, resolveCanonicalDeployment: (id: number) => deployments[id] };
  });
  process.argv = ["node", "mirror.js", "--chain", "base-sepolia", "--once", "--api-key", "k", "--provider", "local"];
});
afterEach(() => {
  process.argv = argv;
  vi.doUnmock("@abxfs/sdk");
  vi.doUnmock("../../src/mirror.js");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("a chain with no org layer yet: the refusal is the only line, with no --api-key warning before it", async () => {
  await expect(import("../../src/bin/mirror.js")).rejects.toThrow(/exit 2/);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[mirror\] NOT STARTED: chain 84532 has no org layer deployed/);
});

it("once it starts, --api-key is warned about, first", async () => {
  vi.doMock("../../src/mirror.js", async (orig) => ({
    ...((await orig()) as object),
    runMirrorGenerations: async (o: { onStart?: () => void }): Promise<MirrorGenerationsStats> => {
      o.onStart?.();
      return { pinned: 0, skipped: 0, next: 0, failures: [], generations: [] };
    },
  }));
  await import("../../src/bin/mirror.js");
  expect(lines[0]).toMatch(/^\[mirror\] WARNING: --api-key puts a secret on the command line/);
  expect(lines.at(-1)).toMatch(/^\[mirror\] stopped: 0 pinned/);
});
