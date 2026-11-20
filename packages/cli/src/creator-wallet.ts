import { resolve } from "node:path";
import {
  ABX_SERVICES_API_KEY_VAR,
  CreatorSponsorshipBudgetError,
  openSponsoredSession,
  readCreatorAccountToken,
  sponsoredWalletAddress,
  type SponsoredSession,
} from "@artblocks/abx-creator-wallet";
import { AbxfsClient } from "@artblocks/abxfs-sdk";
import { createWalletClient, custom, encodeFunctionData, type Abi, type WalletClient } from "viem";

import { createClient } from "./client.js";
import type { ChainConfig } from "./config.js";
import { CliRefusal, registerSecret } from "./redact.js";

export const CREATOR_PILOT_CHAIN = "base-sepolia";

export function accountEnvPath(): string {
  return resolve(".env");
}

export function creatorToken(): string | undefined {
  const token = readCreatorAccountToken(process.env, accountEnvPath());
  registerSecret(token);
  return token;
}

export interface UploadWallet {
  client: AbxfsClient;
  close(): Promise<void>;
}

/** The native provider sees the same creator wallet as ABX. Open its grant lazily after FS review. */
export async function creatorUploadWallet(chain: ChainConfig): Promise<UploadWallet> {
  if (chain.chainId !== 84532) throw new CliRefusal("The creator-wallet upload pilot runs on Base Sepolia.");
  const token = creatorToken();
  if (!token) throw new CliRefusal("Sign in with abxfs auth login to use the creator wallet.");
  // Keep the account credential scoped to the first-party provider.
  const env = { [ABX_SERVICES_API_KEY_VAR]: token };

  const read = createClient(chain);
  const address = await sponsoredWalletAddress(CREATOR_PILOT_CHAIN, { env, requireSponsorshipBudget: true });
  if (await read.publicClient.getChainId() !== chain.chainId) throw new CliRefusal("The FS RPC is on the wrong chain.");
  let session: Promise<SponsoredSession> | undefined;
  let closed = false;
  const walletClient = createWalletClient({
    account: address,
    chain: read.publicClient.chain,
    transport: custom({ async request() {
      throw new CliRefusal("This creator-wallet client supports FS contract writes only.");
    } }, { retryCount: 0 }),
  });
  const writeContract: WalletClient["writeContract"] = async (request) => {
    const sender = typeof request.account === "string" ? request.account : request.account?.address;
    if (closed || (sender && sender.toLowerCase() !== address.toLowerCase()) ||
        (request.chain && request.chain.id !== chain.chainId) || (request.value ?? 0n) !== 0n) {
      throw new CliRefusal("The FS transaction must match the reviewed creator wallet, chain, and zero-value call.");
    }
    const data = encodeFunctionData({
      abi: request.abi as Abi,
      functionName: request.functionName as string,
      args: request.args as readonly unknown[] | undefined,
    });
    session ??= openSponsoredSession(CREATOR_PILOT_CHAIN, {
      env,
      recoveryCommand: "abxfs auth operation",
      requireSponsorshipBudget: true,
    });
    try {
      const signer = await session;
      if (signer.address.toLowerCase() !== address.toLowerCase()) {
        throw new CliRefusal("The creator wallet changed after review. Review the upload again.");
      }
      const sent = await signer.send({
        op: "abxfs-upload",
        to: request.address,
        data,
        value: "0x0",
        chainId: chain.chainId,
        summary: "Store ABX FS content or publish the reviewed project",
        fields: {},
      });
      return sent.txHash;
    } catch (error) {
      if (error instanceof CreatorSponsorshipBudgetError) throw error;
      const message = error instanceof Error ? error.message : "Creator-wallet operation failed.";
      throw new CliRefusal(message);
    }
  };

  // Pass refusals straight back to FS. A viem transaction error without revert data can be treated
  // as a gas-estimation failure and trigger a bundle split, which is unsafe for an unknown submit.
  return {
    client: new AbxfsClient({ publicClient: read.publicClient, addresses: read.addresses,
      walletClient: { ...walletClient, writeContract } as WalletClient }),
    async close() {
      closed = true;
      const opened = await session?.catch(() => undefined);
      opened?.close();
    },
  };
}
