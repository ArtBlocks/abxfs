/**
 * What to do when a mint (or an org creation, which also mints) was SENT but its receipt did not arrive in time.
 *
 * Running the command again is exactly wrong: `upload --name` or `org mint` would mint a second, empty project, and
 * `org create` a second org. So the CLI asks the chain what became of the transaction it already sent
 * (`recoverMint` / `recoverCreateOrg`), for a while, and carries on with the project that transaction made. When the
 * transaction is still pending after that, it stops with the hash, the explorer link and the command that publishes
 * into that project once it confirms, never one that sends the mint again.
 */
import kleur from "kleur";
import type { Address, Hex } from "viem";
import { isReceiptTimeout, type RecoveredWrite } from "@artblocks/abxfs-sdk";

import { safeExplorerUrl } from "./redact.js";
import { txHash } from "./text.js";

/** How long to keep asking after a timeout. Mutable for tests. */
export const RECOVERY_POLL = { attempts: 6, delayMs: 5_000 };

/**
 * A write that was sent and is still pending (or whose outcome the chain does not say). When the job is finished by a
 * command (`upload` publishing into the project the mint makes), the command rides here as a field, like a timed-out
 * transaction's `explorerUrl`, and `formatCliError` prints it on a line of its own through `safe()` only: run through
 * `redact()` with the message, a path or a glob shaped like `host.tld/…` (`mysite.com/build`) became `<redacted>`.
 */
export class PendingWriteError extends Error {
  /** The exact command that finishes the job once the transaction confirms, or undefined. */
  readonly recoveryCommand: string | undefined;
  constructor(message: string, recoveryCommand?: string) {
    super(message);
    this.name = "PendingWriteError";
    this.recoveryCommand = recoveryCommand;
  }
}

async function poll(recover: () => Promise<RecoveredWrite>): Promise<RecoveredWrite> {
  let last: RecoveredWrite = { state: "pending" };
  for (let i = 0; i < RECOVERY_POLL.attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, RECOVERY_POLL.delayMs));
    try {
      last = await recover();
    } catch (e) {
      // Anything can be thrown: a rejection that is not an Error, or one with no message, still reads as "unknown"
      // (reading `.message` off it once threw here, and lost the hash and the instruction with it).
      const first = typeof (e as Error | undefined)?.message === "string" ? (e as Error).message.split("\n")[0] : "";
      last = { state: "unknown", reason: first || "the chain could not be read" };
    }
    if (last.state !== "pending") return last;
  }
  return last;
}

/**
 * Print the explorer link on its own line (error text is scrubbed of URL paths, which would cut it to the host) and
 * return what the error should say about it.
 */
function explorerLine(err: unknown): string {
  const url = safeExplorerUrl((err as { explorerUrl?: unknown }).explorerUrl);
  if (!url) return "";
  console.log(kleur.yellow(`  explorer: ${url}`));
  return " Its explorer link is printed above.";
}

/**
 * Run `send` (a mint, or `createOrg`); when its receipt times out, recover the result from chain state instead.
 *
 * `what` names the write ("the mint"), `recover` reads chain state for a hash, and `whenConfirmed` is the instruction
 * that finishes the job once a still-pending transaction confirms; `command`, when the job is finished by one, is that
 * exact command, carried on the error ({@link PendingWriteError}) and printed on its own line. Neither may ever send
 * this write again.
 */
export async function withMintRecovery<T>(args: {
  what: string;
  send: (onSent: (hash: Hex) => void) => Promise<T>;
  recover: (hash: Hex) => Promise<RecoveredWrite>;
  /** Turn a recovered result into the same shape `send` returns. */
  fromRecovered: (r: { org: Address; tokenId: bigint }, hash: Hex) => T;
  whenConfirmed: string;
  command?: string;
}): Promise<T> {
  let sent: Hex | undefined;
  try {
    return await args.send((h) => (sent = h));
  } catch (err) {
    if (!isReceiptTimeout(err)) throw err;
    const hash = sent ?? ((err as { hash?: Hex }).hash as Hex | undefined);
    if (!hash) throw err;
    console.log(
      kleur.yellow(`! ${args.what} was sent (${txHash(hash)}) but no receipt arrived in time. Reading the chain instead of sending it again…`),
    );
    const where = explorerLine(err);
    const r = await poll(() => args.recover(hash));
    if (r.state === "mined") {
      console.log(kleur.green("✓"), `${args.what} confirmed late: project #${r.tokenId} in ${r.org}`);
      return args.fromRecovered(r, hash);
    }
    if (r.state === "reverted") {
      throw new Error(`${args.what} (${txHash(hash)}) reverted on chain: nothing was minted, so running the same command again is safe.${where}`);
    }
    const why = r.state === "unknown" ? `the chain does not say what it did (${r.reason})` : "it is still pending";
    throw new PendingWriteError(
      `${args.what} (${txHash(hash)}) was sent, and ${why}.${where} Do NOT run the same command again: it would send a ` +
        `second one. ${args.whenConfirmed}`,
      args.command,
    );
  }
}
