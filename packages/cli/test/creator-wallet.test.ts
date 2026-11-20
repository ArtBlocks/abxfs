import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CreatorSponsorshipBudgetError,
  openSponsoredSession,
  sponsoredWalletAddress,
  type SponsoredSession,
} from "@artblocks/abx-creator-wallet";
import { AbxfsClient } from "@artblocks/abxfs-sdk";
import { ANVIL_POLLING_MS, startAnvilWithAbxfs } from "../../sdk/test/helpers/anvil.js";
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

test("resumes an on-chain upload after the creator-wallet sponsorship budget denies a stage", async () => {
  const anvil = await startAnvilWithAbxfs({ anvilArgs: ["--chain-id", String(baseSepolia.id)] });
  try {
    const localTestnet = defineChain({
      id: baseSepolia.id,
      name: "Local Base Sepolia",
      nativeCurrency: baseSepolia.nativeCurrency,
      rpcUrls: { default: { http: [anvil.rpcUrl] } },
    });
    const connection = { chain: localTestnet, transport: http(), pollingInterval: ANVIL_POLLING_MS };
    const publicClient = createPublicClient(connection);
    const walletClient = createWalletClient({ ...connection, account: anvil.account });
    vi.mocked(createClient).mockReturnValue(new AbxfsClient({ publicClient, addresses: anvil.addresses }));
    vi.mocked(sponsoredWalletAddress).mockResolvedValue(anvil.account.address);

    const denial = new CreatorSponsorshipBudgetError(10_000, null);
    const relay: SponsoredSession["send"] = async (tx) => {
      const txHash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash, receipt, paymentMode: "sponsored" };
    };
    const firstSend = vi.fn(relay).mockImplementationOnce(relay).mockRejectedValue(denial);
    const resumeSend = vi.fn(relay);
    const close = vi.fn();
    vi.mocked(openSponsoredSession)
      .mockResolvedValueOnce({ address: anvil.account.address, send: firstSend, close })
      .mockResolvedValueOnce({ address: anvil.account.address, send: resumeSend, close });

    const bytes = new TextEncoder().encode("<h1>Creator wallet upload resumed</h1>");
    const file = { path: "pilot.html", bytes, mimeType: "text/html" };
    const opts = { maxBundleGas: 1 };
    const localChain = { ...chain, rpcUrl: anvil.rpcUrl };
    const first = await creatorUploadWallet(localChain);
    const reviewed = await first.client.uploadFile(file, { ...opts, dryRun: true });
    expect(openSponsoredSession).not.toHaveBeenCalled();
    try {
      await expect(first.client.uploadFile(file, opts)).rejects.toBe(denial);
    } finally {
      await first.close();
    }
    expect(firstSend).toHaveBeenCalledTimes(2);
    expect((await firstSend.mock.results[0]!.value).receipt.status).toBe("success");

    const resumed = await creatorUploadWallet(localChain);
    try {
      const result = await resumed.client.uploadFile(file, opts);
      expect(result.rootCid).toBe(reviewed.rootCid);
      expect(result.txHashes.length).toBeGreaterThan(0);
      expect(resumeSend).toHaveBeenCalledTimes(result.txHashes.length);
      const [{ to, data }] = firstSend.mock.calls[0]!;
      expect(resumeSend).not.toHaveBeenCalledWith(expect.objectContaining({ to, data }));
      expect((await resumed.client.readFile(result.rootCid)).bytes).toEqual(bytes);
      expect((await resumed.client.uploadFile(file, opts)).txHashes).toEqual([]);
      expect(resumeSend).toHaveBeenCalledTimes(result.txHashes.length);
    } finally {
      await resumed.close();
    }
    expect(openSponsoredSession).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    await anvil.stop();
  }
});
