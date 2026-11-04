/**
 * Audit 4 (MED-3): content is written before ownership is checked. A publish whose LAST step would revert
 * (not the owner, the head moved, the token does not exist) must be refused BEFORE the first content write.
 * Also: batched existence probes (HIGH-1) keep their order, group by store and degrade to single reads.
 */
import { describe, expect, it, vi } from "vitest";

import { applyNewProject, executeDraftPublish, executeNewProjectPublish, type AppliedDraft } from "../../src/draft.js";
import { probeExistence, PROBE_BATCH } from "../../src/multicall.js";
import { assertCanPublish } from "../../src/project.js";
import { updateProject } from "../../src/update.js";
import { asAbxfsCid } from "../../src/types.js";

const ME = "0x00000000000000000000000000000000000a11ce" as const;
const OTHER = "0x00000000000000000000000000000000000b0b00" as const;
const COLLECTION = "0x00000000000000000000000000000000000000a1" as const;
const HOOK = "0x00000000000000000000000000000000000000a2" as const;
const project = { collection: COLLECTION, hook: HOOK };
const unset = ["0x" + "00".repeat(32), false, false];
const head = (cid: string) => [cid, false, true];
const CID1 = ("0x" + "11".repeat(32)) as `0x${string}`;

function client(opts: { owner?: string | "revert"; head?: unknown[]; noMulticall?: boolean }) {
  const calls: string[] = [];
  const c = {
    calls,
    multicall: async () => {
      calls.push("multicall");
      if (opts.noMulticall) throw new Error("chain does not support multicall3");
      return [
        opts.owner === "revert" ? { status: "failure", error: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) } : { status: "success", result: opts.owner ?? ME },
        { status: "success", result: opts.head ?? unset },
      ];
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === "ownerOf") {
        if (opts.owner === "revert") throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
        return opts.owner ?? ME;
      }
      return opts.head ?? unset;
    },
    simulateContract: vi.fn(async () => {
      calls.push("simulate");
      return { request: {}, result: [] };
    }),
    waitForTransactionReceipt: vi.fn(),
  };
  return c;
}
const wallet = (address = ME) => ({ account: { address }, writeContract: vi.fn(async () => "0x" + "ee".repeat(32)) });

describe("assertCanPublish", () => {
  it("passes for the owner of an unpublished token", async () => {
    expect(await assertCanPublish(client({}) as never, project, 1n, ME, { expectedHead: null })).toMatchObject({ owner: ME, head: null });
  });
  it("is case-insensitive about the signer", async () => {
    await expect(assertCanPublish(client({ owner: ME.toUpperCase().replace("0X", "0x") }) as never, project, 1n, ME)).resolves.toBeDefined();
  });
  it("refuses a signer that does not hold the token, naming both", async () => {
    await expect(assertCanPublish(client({ owner: OTHER }) as never, project, 1n, ME)).rejects.toThrow(/does not own project #1.*held by 0x0000000000000000000000000000000000b0b00|Nothing was written/s);
  });
  it("refuses a token that does not exist", async () => {
    await expect(assertCanPublish(client({ owner: "revert" }) as never, project, 9n, ME)).rejects.toThrow(/does not exist/);
  });
  it("a first publish refuses a project that already has content; an update refuses a head that moved", async () => {
    await expect(assertCanPublish(client({ head: head(CID1) }) as never, project, 1n, ME, { expectedHead: null })).rejects.toThrow(/already has content/);
    await expect(assertCanPublish(client({ head: head(CID1) }) as never, project, 1n, ME, { expectedHead: asAbxfsCid(`0x${"22".repeat(32)}`) })).rejects.toThrow(/changed since/);
    await expect(assertCanPublish(client({}) as never, project, 1n, ME, { expectedHead: asAbxfsCid(CID1) })).rejects.toThrow(/changed since/);
    await expect(assertCanPublish(client({ head: head(CID1) }) as never, project, 1n, ME, { expectedHead: asAbxfsCid(CID1) })).resolves.toBeDefined();
  });
  it("one multicall; with no Multicall3 on the chain it falls back to two plain reads", async () => {
    const a = client({});
    await assertCanPublish(a as never, project, 1n, ME);
    expect(a.calls).toEqual(["multicall"]);
    const b = client({ noMulticall: true });
    await assertCanPublish(b as never, project, 1n, ME);
    expect(b.calls).toEqual(["multicall", "ownerOf", "tokenParam"]);
  });
  it("no signer is refused", async () => {
    await expect(assertCanPublish(client({}) as never, project, 1n, undefined)).rejects.toThrow(/no account/);
  });
});

describe("the publish executors refuse BEFORE the first content write", () => {
  const files = [{ path: "index.html", bytes: new TextEncoder().encode("<p>hi"), mimeType: "text/html" }];
  const addresses = { chunkStore: "0x00000000000000000000000000000000000c0c01", fileStore: "0x00000000000000000000000000000000000c0c02", directoryStore: "0x00000000000000000000000000000000000c0c03", sstore2Backend: "0x00000000000000000000000000000000000c0c04", fastLzBackend: "0x00000000000000000000000000000000000c0c05" } as never;

  async function applied(): Promise<AppliedDraft> {
    return applyNewProject({} as never, addresses, files);
  }

  it("first publish by a non-owner: no read of the stores, no simulation, no transaction", async () => {
    const c = client({ owner: OTHER });
    const w = wallet();
    await expect(executeNewProjectPublish({ publicClient: c as never, walletClient: w as never }, addresses, project, 1n, "n", await applied())).rejects.toThrow(/does not own/);
    expect(c.simulateContract).not.toHaveBeenCalled();
    expect(w.writeContract).not.toHaveBeenCalled();
    expect(c.calls).toEqual(["multicall"]); // the ownership read, and nothing else
  });
  it("first publish into a project that already has content is refused up front", async () => {
    const c = client({ head: head(CID1) });
    const w = wallet();
    await expect(executeNewProjectPublish({ publicClient: c as never, walletClient: w as never }, addresses, project, 1n, "n", await applied())).rejects.toThrow(/already has content/);
    expect(w.writeContract).not.toHaveBeenCalled();
  });
  it("an update whose head moved is refused before any content write; a non-owner too", async () => {
    const a = await applied();
    const w = wallet();
    await expect(executeDraftPublish({ publicClient: client({ head: head(CID1) }) as never, walletClient: w as never }, addresses, project, 1n, a, { expectedHead: asAbxfsCid(`0x${"22".repeat(32)}`) })).rejects.toThrow(/changed since/);
    await expect(executeDraftPublish({ publicClient: client({ owner: OTHER }) as never, walletClient: w as never }, addresses, project, 1n, a)).rejects.toThrow(/does not own/);
    expect(w.writeContract).not.toHaveBeenCalled();
  });
  it("updateProject (the CLI's update) checks ownership before it uploads anything", async () => {
    const c = {
      ...client({ owner: OTHER }),
      // `cidKind` probes: pretend the existing root is a directory
      readContract: async ({ functionName }: { functionName: string }) => (functionName === "directoryExists" ? true : false),
    };
    const w = wallet();
    await expect(
      updateProject({ publicClient: c as never, walletClient: w as never }, addresses, { project, tokenId: 1n, existingRootCid: asAbxfsCid(CID1), newContent: files }),
    ).rejects.toThrow();
    expect(w.writeContract).not.toHaveBeenCalled();
  });
});

describe("probeExistence", () => {
  const ABI = [{ type: "function", name: "exists", stateMutability: "view", inputs: [{ name: "h", type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;
  const STORE = "0x00000000000000000000000000000000000c0c01" as const;
  const h = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;

  it("answers in order through ONE call per 150 probes", async () => {
    const simulate = vi.fn(async ({ args }: { args: [string[]] }) => ({
      // each inner call's returndata: ABI-encoded bool, true for odd hashes
      result: args[0].map((data) => ((BigInt("0x" + data.slice(10)) % 2n === 1n ? "0x" + "00".repeat(31) + "01" : "0x" + "00".repeat(32)))),
    }));
    const targets = Array.from({ length: 320 }, (_, i) => ({ address: STORE, abi: ABI, fn: "exists", arg: h(i) }));
    const out = await probeExistence({ simulateContract: simulate } as never, targets);
    expect(simulate).toHaveBeenCalledTimes(Math.ceil(320 / PROBE_BATCH));
    expect(out).toEqual(Array.from({ length: 320 }, (_, i) => i % 2 === 1));
  });
  it("groups by store and function, and keeps each answer at its own index", async () => {
    const simulate = vi.fn(async ({ address, args }: { address: string; args: [string[]] }) => ({
      result: args[0].map(() => (address === STORE ? "0x" + "00".repeat(31) + "01" : "0x" + "00".repeat(32))),
    }));
    const other = "0x00000000000000000000000000000000000c0c02" as const;
    const out = await probeExistence({ simulateContract: simulate } as never, [
      { address: STORE, abi: ABI, fn: "exists", arg: h(1) },
      { address: other, abi: ABI, fn: "exists", arg: h(2) },
      { address: STORE, abi: ABI, fn: "exists", arg: h(3) },
    ]);
    expect(out).toEqual([true, false, true]);
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it("a store that cannot multicall degrades to single reads; a rate limit is rethrown, not fanned out", async () => {
    const read = vi.fn(async () => true);
    const out = await probeExistence(
      { simulateContract: async () => { throw new Error("execution reverted"); }, readContract: read } as never,
      [1, 2, 3].map((i) => ({ address: STORE, abi: ABI, fn: "exists", arg: h(i) })),
    );
    expect(out).toEqual([true, true, true]);
    expect(read).toHaveBeenCalledTimes(3);
    const limited = Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
    const read2 = vi.fn();
    await expect(
      probeExistence({ simulateContract: async () => { throw limited; }, readContract: read2 } as never, [{ address: STORE, abi: ABI, fn: "exists", arg: h(1) }]),
    ).rejects.toThrow(/429/);
    expect(read2).not.toHaveBeenCalled();
  });
  it("no probes, no calls", async () => {
    const simulate = vi.fn();
    expect(await probeExistence({ simulateContract: simulate } as never, [])).toEqual([]);
    expect(simulate).not.toHaveBeenCalled();
  });
});
