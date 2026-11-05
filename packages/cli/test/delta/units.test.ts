/**
 * Branches the delta audit found untested in the CLI's small modules: the write plan (`describeOrg`, the createOrg
 * estimate's fallback, no account, the balance warning), mint recovery, numeric parsing, chain names, and the entry
 * point's "cancelled:".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError } from "viem";
import { TransactionTimeoutError as SdkTimeout } from "@artblocks/abxfs-sdk";

import { parsePositiveInt, parseTokenId } from "../../src/args.js";
import { chainDisplayName } from "../../src/chains.js";
import { describeCliError } from "../../src/index.js";
import { RECOVERY_POLL, withMintRecovery } from "../../src/recover.js";
import { confirmWrite, describeOrg, estimateCreateOrgGas, WRITE_GAS } from "../../src/write-plan.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const ACCOUNT = "0x00000000000000000000000000000000000a11ce";
const HASH = ("0x" + "12".repeat(32)) as `0x${string}`;

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  RECOVERY_POLL.attempts = 2;
  RECOVERY_POLL.delayMs = 1;
});
afterEach(() => vi.restoreAllMocks());

describe("describeOrg", () => {
  it("names an org by its name", async () => {
    expect(await describeOrg({ readOrg: async () => ({ name: "Studio" }) } as never, ORG)).toBe(`"Studio" ${ORG}`);
  });
  it("says when the factory did not create the address", async () => {
    expect(await describeOrg({ readOrg: async () => null } as never, ORG)).toBe(`${ORG} (not an org this chain's factory created)`);
  });
  it("says when the name could not be read, with the first line of why", async () => {
    const label = await describeOrg({ readOrg: async () => Promise.reject(new Error("HTTP request failed.\nURL: …")) } as never, ORG);
    expect(label).toBe(`${ORG} (its name could not be read: HTTP request failed.)`);
  });
});

describe("estimateCreateOrgGas", () => {
  const base = { registry: { orgFactory: ORG }, walletClient: { account: { address: ACCOUNT } } };
  it("the node's estimate when it gives one", async () => {
    const est = await estimateCreateOrgGas({ ...base, publicClient: { estimateContractGas: async () => 1_234_567n } } as never, { name: "x", description: "" });
    expect(est).toEqual({ gas: 1_234_567, estimated: true });
  });
  it("the per-transaction cap (2^24), marked not estimated, when the node refuses", async () => {
    const est = await estimateCreateOrgGas({ ...base, publicClient: { estimateContractGas: async () => Promise.reject(new Error("nope")) } } as never, { name: "x", description: "" });
    expect(est).toEqual({ gas: WRITE_GAS.createOrgCeiling, estimated: false });
    expect(WRITE_GAS.createOrgCeiling).toBe(2 ** 24);
  });
  it("the cap without a factory, without an account, or without an estimator", async () => {
    const pc = { estimateContractGas: async () => 1n };
    for (const c of [
      { ...base, registry: {}, publicClient: pc },
      { ...base, walletClient: undefined, publicClient: pc },
      { ...base, publicClient: {} },
    ]) {
      expect(await estimateCreateOrgGas(c as never, { name: "x", description: "" })).toEqual({ gas: 2 ** 24, estimated: false });
    }
  });
});

describe("confirmWrite", () => {
  const plan = { action: "do it", chainId: 84532, steps: [{ what: "a write", txs: 1, gas: 1_000_000 }], permanent: [] };
  it("refuses with no account to write with", async () => {
    await expect(confirmWrite({ publicClient: {}, walletClient: undefined } as never, plan, { yes: true })).rejects.toThrow(/no account to write with — set ABXFS_PRIVATE_KEY/);
  });
  it("warns when the balance is below the max cost, and goes on (fees are usually far lower)", async () => {
    const ok = await confirmWrite(
      { publicClient: { getBalance: async () => 1_000n }, walletClient: { account: { address: ACCOUNT } } } as never,
      plan,
      { yes: true },
    );
    expect(ok).toBe(true);
    expect(out.join("\n")).toMatch(/account 0x0+a11ce holds 0\.000000000000001 ETH, less than the max cost above/);
    expect(out.join("\n")).toMatch(/permanent:\s+nothing/);
  });
});

describe("withMintRecovery", () => {
  const timeout = () => new SdkTimeout(HASH, "mint");
  const args = <T,>(over: Partial<Parameters<typeof withMintRecovery<T>>[0]>) => ({
    what: "the mint",
    send: async () => Promise.reject(timeout()),
    recover: async () => ({ state: "pending" as const }),
    fromRecovered: (r: { org: string; tokenId: bigint }) => r as never as T,
    whenConfirmed: "Then run X.",
    ...over,
  });

  it("an error that is not a receipt timeout is thrown as it is (nothing is recovered)", async () => {
    let asked = 0;
    const e = new Error("execution reverted: NotAllowed");
    await expect(withMintRecovery(args({ send: async () => Promise.reject(e), recover: async () => (asked++, { state: "pending" }) }))).rejects.toBe(e);
    expect(asked).toBe(0);
  });

  it("a timeout with no hash at all (never sent) is thrown as it is", async () => {
    // a receipt timeout carrying no hash, and `onSent` never fired: there is nothing to look up
    const noHash = Object.assign(new SdkTimeout(HASH, "mint"), { hash: undefined });
    await expect(withMintRecovery(args({ send: async () => Promise.reject(noHash) }))).rejects.toBe(noHash);
  });

  it("a chain that cannot say what happened is reported as such, with the instruction and never a re-send", async () => {
    await expect(
      withMintRecovery(args({ send: async (onSent) => (onSent(HASH), Promise.reject(timeout())), recover: async () => Promise.reject(new Error("rpc down\nmore")) })),
    ).rejects.toThrow(/the mint \(0x1212…?.*\) was sent, and the chain does not say what it did \(rpc down\)\. Do NOT run the same command again.*Then run X\./s);
  });

  it("a recovery that fails with no message, or with something that is not an Error, reads as unknown too", async () => {
    for (const thrown of [new Error(""), "a string", undefined, Object.assign(new Error("x"), { message: undefined })]) {
      await expect(withMintRecovery(args({ recover: async () => Promise.reject(thrown) })), String(thrown)).rejects.toThrow(
        /the chain does not say what it did \(the chain could not be read\)\..*Do NOT run the same command again/s,
      );
    }
  });
});

describe("numbers on the command line", () => {
  it("a project id of 2^256 or more is refused, naming the flag", () => {
    expect(() => parseTokenId("--project-id", (2n ** 256n).toString())).toThrow(/--project-id is too large to be a project id/);
    expect(parseTokenId("--project-id", (2n ** 256n - 1n).toString())).toBe(2n ** 256n - 1n);
  });
  it("a positive integer past 2^53 is refused, naming the flag", () => {
    expect(() => parsePositiveInt("--max-bundle-gas", "9007199254740993")).toThrow(/--max-bundle-gas is too large/);
    expect(parsePositiveInt("--max-bundle-gas", "9007199254740991")).toBe(9007199254740991);
  });
});

describe("chain names", () => {
  it("a chain viem knows by its name; any other by its id", () => {
    expect(chainDisplayName(84532)).toBe("Base Sepolia (chain 84532)");
    expect(chainDisplayName(987654321)).toBe("chain 987654321");
  });
});

describe("the entry point's labels", () => {
  it("a wallet rejection is 'cancelled', with no viem stack", () => {
    const d = describeCliError(new UserRejectedRequestError(new Error("User denied")));
    expect(d.label).toBe("cancelled");
    expect(d.message).toMatch(/rejected in the wallet\. Nothing more was sent/);
  });
  it("an EIP-1193 4001 anywhere in the cause chain is too", () => {
    expect(describeCliError(Object.assign(new Error("outer"), { cause: { code: 4001 } })).label).toBe("cancelled");
  });
  it("run() prints 'cancelled:' for it and exits 1", async () => {
    vi.resetModules();
    vi.doMock("../../src/commands/read.js", async () => {
      const { Command } = await import("commander");
      return {
        readCommand: () =>
          new Command("read").argument("[x]").action(async () => {
            throw new UserRejectedRequestError(new Error("User denied"));
          }),
      };
    });
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
    const { run } = await import("../../src/index.js");
    await run(["node", "abxfs", "read", "x"]);
    expect(lines.join("\n")).toMatch(/cancelled:.*rejected in the wallet/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    vi.doUnmock("../../src/commands/read.js");
  });
});
