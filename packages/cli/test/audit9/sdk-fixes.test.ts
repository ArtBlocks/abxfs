/**
 * The CLI side of the SDK audit fixes:
 *
 *   - A8: declining a request in the wallet is a cancellation, not a failure, and the CLI says so. Decided by type and
 *     EIP-1193 code, never by the message text.
 *   - RS-M1: `verify` and `pin` fall back to a local derivation only for a codec the chain cannot decode, never for a
 *     directory IPFS would shard.
 */
import { BaseError, UserRejectedRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CodecNotSupportedOnChainError, DirectoryNeedsShardingError, type AbxfsCid, type AbxfsClient } from "@abxfs/sdk";

import { describeCliError } from "../../src/index.js";
import { deriveIpfsCid } from "../../src/commands/pin.js";

describe("verify and pin never derive locally for a directory IPFS would shard (RS-M1)", () => {
  const root = `0x${"32".repeat(32)}` as AbxfsCid;
  const client = (onChain: () => Promise<string>) => {
    const local = vi.fn(async () => "bafy-local");
    return {
      c: { addresses: { ipfsCidResolver: "0x00000000000000000000000000000000000000e1" }, verifyOnChainIpfsCid: onChain, verifyLocalIpfsCid: local } as unknown as AbxfsClient,
      local,
    };
  };
  it("the resolver's refusal is reported, by type, and nothing is derived in its place", async () => {
    const { c, local } = client(async () => {
      throw new DirectoryNeedsShardingError(root, 262_191);
    });
    await expect(deriveIpfsCid(c, root)).rejects.toBeInstanceOf(DirectoryNeedsShardingError);
    expect(local).not.toHaveBeenCalled();
  });
  it("a codec the chain cannot decode still falls back to the local derivation", async () => {
    const { c, local } = client(async () => {
      throw new CodecNotSupportedOnChainError(root, "0x677a6970");
    });
    await expect(deriveIpfsCid(c, root)).resolves.toEqual({ cid: "bafy-local", where: "locally derived" });
    expect(local).toHaveBeenCalledOnce();
  });
});

describe("a wallet rejection reads as a cancellation", () => {
  it("UserRejectedRequestError anywhere in the cause chain, or code 4001", () => {
    const wrapped = new BaseError("The contract function \"multicall\" failed", { cause: new UserRejectedRequestError(new Error("denied")) });
    expect(describeCliError(wrapped)).toMatchObject({ label: "cancelled", message: expect.stringMatching(/rejected in the wallet/) });
    expect(describeCliError({ message: "x", cause: { code: 4001 } }).label).toBe("cancelled");
  });

  it("anything else is an error, scrubbed as before; a message that merely says 'rejected' is not a cancellation", () => {
    expect(describeCliError(new Error("execution reverted: SameRoot"))).toEqual({ label: "error", message: "execution reverted: SameRoot" });
    expect(describeCliError(new Error("user rejected the request")).label).toBe("error");
  });
});
