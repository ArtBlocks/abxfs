/**
 * A write lands only on the chain it was planned against.
 *
 * Every ABX FS contract has the same address on every chain, so a write planned against one chain is a valid
 * transaction on another: a wallet client set up for a production network would pay real gas for an upload planned on
 * its testnet.
 * viem refuses to sign while the wallet itself is on a chain other than its wallet client's; this refuses a wallet
 * client set up for a chain other than the one the SDK reads. Between them, a write is signed only for the chain whose
 * state planned it.
 */
import type { PublicClient, WalletClient } from "viem";

export class WrongChainError extends Error {
  constructor(
    readonly readChainId: number,
    readonly walletChainId: number,
  ) {
    super(`the wallet client is on chain ${walletChainId}, but this client reads chain ${readChainId}: nothing was sent`);
    this.name = "WrongChainError";
  }
}

/** Throws {@link WrongChainError} when both clients name a chain and the two differ. */
export function assertWalletChain(
  publicClient: Pick<PublicClient, "chain">,
  walletClient: Pick<WalletClient, "chain">,
): void {
  const read = publicClient.chain?.id;
  const write = walletClient.chain?.id;
  if (read !== undefined && write !== undefined && read !== write) throw new WrongChainError(read, write);
}
