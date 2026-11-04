/** Round 3: validation before any write, and receipt timeouts that never invite a blind retry. */
import { describe, expect, it, vi } from "vitest";
import { WaitForTransactionReceiptTimeoutError, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { AbxfsClient } from "../src/abxfs.js";
import { assertValidPublishInputs } from "../src/validate.js";
import { TransactionTimeoutError, waitForSuccessfulReceipt } from "../src/receipts.js";
import type { AbxfsCid, ContractAddresses } from "../src/index.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const addresses: ContractAddresses = {
  sstore2Backend: a(1), fastLzBackend: a(8), chunkStore: a(2), fileStore: a(3), directoryStore: a(4),
  orgFactory: a(5), projectHook: a(6),
};
const ORG = a(7);
const CID = ("0x" + "11".repeat(32)) as AbxfsCid;
const HASH = ("0x" + "ab".repeat(32)) as Hex;

function spies() {
  const pub = {
    readContract: vi.fn(async () => { throw new Error("READ TOUCHED"); }),
    multicall: vi.fn(async () => { throw new Error("READ TOUCHED"); }),
    simulateContract: vi.fn(async () => { throw new Error("SIM TOUCHED"); }),
    waitForTransactionReceipt: vi.fn(),
    estimateGas: vi.fn(),
  };
  const wallet = {
    account: { address: a(9) },
    writeContract: vi.fn(async () => { throw new Error("WRITE TOUCHED"); }),
    sendTransaction: vi.fn(async () => { throw new Error("WRITE TOUCHED"); }),
  };
  const client = new AbxfsClient({ publicClient: pub as unknown as PublicClient, walletClient: wallet as unknown as WalletClient, addresses, org: ORG });
  return { pub, wallet, client };
}
const nothingSent = (s: ReturnType<typeof spies>) => {
  expect(s.wallet.writeContract).not.toHaveBeenCalled();
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  expect(s.pub.readContract).not.toHaveBeenCalled(); // not even a read: the check is first
  expect(s.pub.simulateContract).not.toHaveBeenCalled();
};

describe("a bad tag or name sends nothing and reads nothing", () => {
  const files = [{ path: "index.html", bytes: new Uint8Array([1]), mimeType: "text/html" }];
  it("publishNewProject: bad tag, bad name, reserved tag", async () => {
    for (const bad of [{ tag: "Bad Tag", name: "ok" }, { tag: "latest", name: "ok" }, { tag: "v1", name: "x".repeat(200) }, { tag: "v1", name: "a\u0007b" }]) {
      const s = spies();
      await expect(s.client.publishNewProject({ tokenId: 1n, files, ...bad })).rejects.toThrow(/Nothing was sent/);
      nothingSent(s);
    }
  });
  it("planNewProject, publishUpdate, publishAndTag, update, setProjectName", async () => {
    let s = spies();
    await expect(s.client.planNewProject(files, { tag: "UP", name: "ok" })).rejects.toThrow(/invalid tag/);
    nothingSent(s);
    s = spies();
    await expect(s.client.publishUpdate({ tokenId: 1n, baseRootCid: CID, ops: [], tag: "UP" })).rejects.toThrow(/invalid tag/);
    nothingSent(s);
    s = spies();
    expect(() => s.client.publishAndTag(1n, CID, { tag: "has space" })).toThrow(/invalid tag/);
    nothingSent(s);
    s = spies();
    await expect(s.client.update({ project: { collection: ORG, hook: a(6) }, tokenId: 1n, existingRootCid: CID, newContent: files, tag: "UP" })).rejects.toThrow(/invalid tag/);
    nothingSent(s);
    s = spies();
    expect(() => s.client.setProjectName(1n, "x".repeat(300))).toThrow(/invalid project name/);
    nothingSent(s);
  });
  it("valid inputs pass the guard; empty means 'not supplied'", () => {
    expect(() => assertValidPublishInputs({ tag: "v1.2.3-rc.1", name: "My Cool Art" })).not.toThrow();
    expect(() => assertValidPublishInputs({})).not.toThrow();
    expect(() => assertValidPublishInputs({ tag: "", name: "" })).not.toThrow();
  });
});

describe("receipt timeouts", () => {
  const timeout = () => new WaitForTransactionReceiptTimeoutError({ hash: HASH });
  it("become a TransactionTimeoutError that says it may still confirm, with the hash and an explorer link", async () => {
    const client = { chain: { blockExplorers: { default: { url: "https://sepolia.basescan.org/" } } }, waitForTransactionReceipt: async () => { throw timeout(); } };
    const err = (await waitForSuccessfulReceipt(client as never, HASH, "mint").catch((e: unknown) => e)) as TransactionTimeoutError;
    expect(err).toBeInstanceOf(TransactionTimeoutError);
    expect(err.message).toMatch(/may still confirm/);
    expect(err.message).toContain(HASH);
    expect(err.message).toMatch(/Do not resend/);
    expect(err.hash).toBe(HASH);
    expect(err.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${HASH}`);
    expect(err.message).toContain(`https://sepolia.basescan.org/tx/${HASH}`);
  });
  it("without a known explorer it still names the hash", async () => {
    const client = { waitForTransactionReceipt: async () => { throw timeout(); } };
    const err = (await waitForSuccessfulReceipt(client as never, HASH).catch((e: unknown) => e)) as TransactionTimeoutError;
    expect(err).toBeInstanceOf(TransactionTimeoutError);
    expect(err.explorerUrl).toBeUndefined();
    expect(err.message).toContain(HASH);
  });
  it("a revert is still a revert, and other errors pass through untouched", async () => {
    await expect(waitForSuccessfulReceipt({ waitForTransactionReceipt: async () => ({ status: "reverted" }) } as never, HASH, "x")).rejects.toThrow(/reverted/);
    await expect(waitForSuccessfulReceipt({ waitForTransactionReceipt: async () => { throw new Error("boom"); } } as never, HASH)).rejects.toThrow("boom");
  });
  it("the wait is attempted once: a timeout is never retried here (a retried mint makes a second empty project)", async () => {
    const waitFn = vi.fn(async () => { throw timeout(); });
    await waitForSuccessfulReceipt({ waitForTransactionReceipt: waitFn } as never, HASH, "mint").catch(() => undefined);
    expect(waitFn).toHaveBeenCalledTimes(1);
  });
});

describe("display sanitizer", () => {
  it("strips the variation selectors supplement and normalises every Unicode space separator", async () => {
    const { stripTerminalControl, displayPath, sanitizeDisplayName } = await import("../src/display.js");
    expect(stripTerminalControl("a\u{e0100}b\u{e01ef}c")).toBe("abc");
    for (const sp of [" ", " ", " ", " ", " ", " ", " ", "　"]) {
      expect(stripTerminalControl(`a${sp}b`), JSON.stringify(sp)).toBe("a b");
    }
    expect(displayPath("my file.txt")).toBe("my file.txt");
    expect(sanitizeDisplayName("a\u{e0100} b")).toBe("a b");
  });
});
