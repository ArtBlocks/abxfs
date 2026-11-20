import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CreatorSponsorshipBudgetError,
  openSponsoredSession,
  sponsoredWalletAddress,
} from "@artblocks/abx-creator-wallet";
import { createClient } from "../src/client.js";
import { creatorUploadWallet } from "../src/creator-wallet.js";

vi.mock("@artblocks/abx-creator-wallet", async (load) => ({
  ...await load<typeof import("@artblocks/abx-creator-wallet")>(),
  openSponsoredSession: vi.fn(),
  sponsoredWalletAddress: vi.fn(),
  readCreatorAccountToken: () => "mock-account-token",
}));
vi.mock("../src/client.js", () => ({ createClient: vi.fn() }));

const address = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const txHash = `0x${"33".repeat(32)}` as const;
const chain = { chainId: baseSepolia.id, rpcUrl: "https://rpc.example.test" };
const abi = parseAbi(["function multicall(bytes[] data)"]);
const request = { address: target, functionName: "multicall", args: [["0x1234"]], abi } as const;
const read = { chain: baseSepolia, getChainId: async () => baseSepolia.id };

beforeEach(() => {
  vi.mocked(createClient).mockReturnValue({ publicClient: read, addresses: {} } as never);
  vi.mocked(sponsoredWalletAddress).mockResolvedValue(address);
});
afterEach(() => vi.clearAllMocks());

test("uses the same approved wallet and opens one session for multiple reviewed upload stages", async () => {
  const send = vi.fn().mockResolvedValue({ txHash });
  const close = vi.fn();
  vi.mocked(openSponsoredSession).mockResolvedValue({ address, send, close });
  const wallet = await creatorUploadWallet(chain);
  expect(wallet.client.walletClient?.account?.address).toBe(address);
  expect(openSponsoredSession).not.toHaveBeenCalled();

  const signer = wallet.client.walletClient!;
  expect(await signer.writeContract({ ...request, account: signer.account!, chain: baseSepolia })).toBe(txHash);
  expect(await signer.writeContract({ ...request, account: signer.account!, chain: baseSepolia })).toBe(txHash);

  expect(openSponsoredSession).toHaveBeenCalledTimes(1);
  expect(openSponsoredSession).toHaveBeenCalledWith("base-sepolia", expect.objectContaining({
    requireSponsorshipBudget: true, recoveryCommand: "abxfs auth operation",
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    to: target,
    data: encodeFunctionData(request),
    chainId: baseSepolia.id,
    value: "0x0",
  }));
  await wallet.close();
  expect(close).toHaveBeenCalledTimes(1);
});

test("returns a sponsorship refusal without wrapping it as a gas failure or retrying the write", async () => {
  const denial = new CreatorSponsorshipBudgetError(10_000, null);
  const send = vi.fn().mockRejectedValue(denial);
  vi.mocked(openSponsoredSession).mockResolvedValue({ address, send, close: vi.fn() });
  const wallet = await creatorUploadWallet(chain);
  const signer = wallet.client.walletClient!;
  await expect(signer.writeContract({ ...request, account: signer.account!, chain: baseSepolia })).rejects.toBe(denial);
  expect(send).toHaveBeenCalledTimes(1);
  await wallet.close();
});
