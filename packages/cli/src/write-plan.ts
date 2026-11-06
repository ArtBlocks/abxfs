/**
 * What a paid write is about to do, said BEFORE it is done, and a confirmation for it.
 *
 * Every command that sends a transaction builds a {@link WritePlan} and calls {@link confirmWrite} before its first
 * write: the chain, the org, how many transactions, the estimated gas, the most it can cost at the fee ceiling, and
 * what becomes permanent. Then the account's balance is checked (an empty account is refused before anything is
 * signed), and the write goes ahead only on a typed `yes` on a terminal, or with `--yes`. Without a terminal and
 * without `--yes` it refuses: a script must say so explicitly. `--dry-run` never gets here.
 */
import kleur from "kleur";
import { formatEther, formatGwei, type Address, type Hex } from "viem";
import { GAS_ESTIMATES, gasScheduleForChain, iOrgFactoryAbi, type AbxfsClient } from "@artblocks/abxfs-sdk";

import { chainDisplayName, isArbitrumChain, isOpStackChain, maxFeeCapWei } from "./chains.js";
import { confirmTyped } from "./prompt.js";
import { safe } from "./text.js";

export interface WriteStep {
  /** What the transaction(s) do, e.g. "upload the content" or "publish it as a new version". */
  what: string;
  txs: number;
  /** Estimated gas for all of them together. */
  gas: number;
  /** `txs` and `gas` are upper bounds (content already on chain is skipped), so the line says "up to". */
  upTo?: boolean;
  /**
   * `gas` follows this chain's gas schedule: the content model (which prices EIP-8037's state apart) or the node's own
   * estimate. Unset for the legacy-priced project and org figures ({@link WRITE_GAS}).
   */
  scheduled?: boolean;
}

export interface WritePlan {
  /** One line: what the command is about to do. */
  action: string;
  chainId: number;
  /** The org it acts in, as printed (`"Name" 0x…`), or the org it will create. Omitted when no org is involved. */
  org?: string;
  steps: WriteStep[];
  /** What cannot be undone once sent. An empty list is printed as "nothing". */
  permanent: string[];
  /** Printed after the plan, in yellow. */
  warnings?: string[];
}

/**
 * Gas for the project- and org-layer writes, for the PREVIEW only (each transaction is still estimated by the node
 * when it is sent): the SDK's own figures, measured on the Base Sepolia fork (`GasProfileFork.t.sol`), except
 * `createOrg`, which the node estimates for the chain's own gas schedule.
 */
export const WRITE_GAS = {
  mint: GAS_ESTIMATES.projectCreate,
  publish: GAS_ESTIMATES.projectPublishVersion,
  setName: GAS_ESTIMATES.projectSetName,
  setTag: GAS_ESTIMATES.projectSetTag,
  removeTag: GAS_ESTIMATES.projectRemoveTag,
  /** `abxfs.view` is a String PostParam like the name (an SSTORE2 blob), and up to 512 bytes: its own, larger figure. */
  setView: GAS_ESTIMATES.projectSetView,
  setOpen: GAS_ESTIMATES.orgSetOpen,
  transferAdmin: GAS_ESTIMATES.orgTransferAdmin,
  /** An ERC-721 transfer through the enumeration hook (owner indexes on both sides). */
  transfer: GAS_ESTIMATES.projectTransfer,
  acceptAdmin: GAS_ESTIMATES.orgAcceptAdmin,
  /** Used only when the node cannot estimate `createOrg`: the per-transaction cap, which it must fit under. */
  createOrgCeiling: 2 ** 24,
} as const;

/** `"Name" 0x…` for an org, with the name passed through `safe()`; the address alone if the name cannot be read. */
export async function describeOrg(client: Pick<AbxfsClient, "readOrg">, org: Address): Promise<string> {
  try {
    const o = await client.readOrg(org);
    if (o) return `"${safe(o.name)}" ${org}`;
    return `${org} (not an org this chain's factory created)`;
  } catch (e) {
    return `${org} (its name could not be read: ${safe((e as Error).message.split("\n")[0])})`;
  }
}

/**
 * The node's gas estimate for `createOrg`, or {@link WRITE_GAS.createOrgCeiling} with a note when it cannot give one
 * (the preview must not be blocked by an estimate). Display only: the transaction is estimated again when sent.
 */
export async function estimateCreateOrgGas(
  client: Pick<AbxfsClient, "publicClient" | "walletClient" | "registry">,
  args: { name: string; description: string; salt?: Hex },
): Promise<{ gas: number; estimated: boolean }> {
  const factory = client.registry?.orgFactory;
  const account = client.walletClient?.account;
  if (!factory || !account || typeof client.publicClient?.estimateContractGas !== "function") {
    return { gas: WRITE_GAS.createOrgCeiling, estimated: false };
  }
  try {
    const gas = await client.publicClient.estimateContractGas({
      address: factory,
      abi: iOrgFactoryAbi,
      functionName: "createOrg",
      args: [args.name, args.description, args.salt ?? (`0x${"00".repeat(32)}` as Hex)],
      account,
    });
    return { gas: Number(gas), estimated: true };
  } catch {
    return { gas: WRITE_GAS.createOrgCeiling, estimated: false };
  }
}

const n = (x: number) => x.toLocaleString("en-US");

/** About two significant figures of ETH: an estimate, not a quote. */
const approxEth = (wei: bigint) => {
  const eth = Number(formatEther(wei));
  return eth === 0 ? "0" : eth.toPrecision(2).replace(/\.?0+(e|$)/, "$1");
};

/**
 * The lines {@link confirmWrite} prints, without the balance check or the prompt. `gasPrice`, the node's current
 * price when it gave one, adds the likely cost: the max cost is a ceiling at the fee cap, often thousands of times more.
 */
export function describeWritePlan(plan: WritePlan, gasPrice?: bigint): string[] {
  const txs = plan.steps.reduce((a, s) => a + s.txs, 0);
  const gas = plan.steps.reduce((a, s) => a + s.gas, 0);
  const upTo = plan.steps.some((s) => s.upTo);
  const cap = maxFeeCapWei(plan.chainId);
  const maxCost = BigInt(gas) * cap;
  const lines: string[] = [];
  lines.push(`${kleur.cyan("→")} ${plan.action}`);
  lines.push(`  chain:      ${chainDisplayName(plan.chainId)}`);
  if (plan.org) lines.push(`  org:        ${plan.org}`);
  lines.push(
    `  sends:      ${upTo ? "up to " : ""}${txs} transaction${txs === 1 ? "" : "s"}, ~${n(gas)} gas estimated` +
      (upTo ? kleur.gray(" (content already on chain is skipped)") : ""),
  );
  for (const s of plan.steps) {
    lines.push(kleur.gray(`                ${s.upTo ? "up to " : ""}${s.txs} × ${s.what}`.padEnd(64) + ` ~${n(s.gas)} gas`));
  }
  if (gasPrice !== undefined && gasPrice > 0n) {
    lines.push(
      `  est. cost:  ~${approxEth(BigInt(gas) * gasPrice)} ETH` + kleur.gray(` (at the current gas price, ${formatGwei(gasPrice)} gwei)`),
    );
  }
  lines.push(
    `  max cost:   ${formatEther(maxCost)} ETH` +
      kleur.gray(` (the estimate at the ${formatGwei(cap)} gwei fee ceiling, ABXFS_MAX_FEE_GWEI: what it could cost if fees spiked)`),
  );
  if (isOpStackChain(plan.chainId)) {
    // Charged per byte of each transaction at the L1's price, outside the gas the fee ceiling caps.
    lines.push(kleur.gray("              not included: this chain's L1 data fee, charged on top for each transaction's calldata"));
  } else if (isArbitrumChain(plan.chainId)) {
    // Arbitrum folds the same charge into gas: extra gas units at this chain's price, which the estimates above omit.
    lines.push(
      kleur.gray("              not included: this chain's L1 component, charged as extra gas on each transaction for its calldata"),
    );
  }
  if (gasScheduleForChain(plan.chainId).name === "eip8037" && plan.steps.some((s) => !s.scheduled)) {
    // The SDK's project and org figures were measured on legacy chains; EIP-8037 prices new state far higher.
    lines.push(
      kleur.gray(
        "              the project and org figures are legacy-priced: under EIP-8037 (this chain) state costs more, so a long name or view costs more than shown",
      ),
    );
  }
  if (plan.permanent.length === 0) {
    lines.push(`  permanent:  nothing ${kleur.gray("(this can be changed or undone later)")}`);
  } else {
    lines.push(`  permanent:  ${plan.permanent[0]}`);
    for (const p of plan.permanent.slice(1)) lines.push(`              ${p}`);
  }
  for (const w of plan.warnings ?? []) lines.push(kleur.yellow(`  ! ${w}`));
  return lines;
}

/**
 * Print the plan, check the account can pay at all, and ask. Returns false when the answer is no (the caller stops,
 * having sent nothing); throws without a terminal unless `yes`, and when the account holds no ETH.
 */
export async function confirmWrite(
  client: Pick<AbxfsClient, "publicClient" | "walletClient">,
  plan: WritePlan,
  opts: { yes?: boolean | undefined },
): Promise<boolean> {
  let gasPrice: bigint | undefined;
  try {
    // Display only, so a node that cannot say leaves the line out rather than stopping the write.
    if (typeof client.publicClient.getGasPrice === "function") gasPrice = await client.publicClient.getGasPrice();
  } catch {
    gasPrice = undefined;
  }
  for (const line of describeWritePlan(plan, gasPrice)) console.log(line);

  const txs = plan.steps.reduce((a, s) => a + s.txs, 0);
  const gas = plan.steps.reduce((a, s) => a + s.gas, 0);
  const account = client.walletClient?.account?.address;
  if (!account) throw new Error("no account to write with — set ABXFS_PRIVATE_KEY");
  const balance = await client.publicClient.getBalance({ address: account });
  if (balance === 0n) {
    throw new Error(`account ${account} has no ETH on ${chainDisplayName(plan.chainId)}, so it cannot pay for any transaction. Nothing was sent.`);
  }
  const maxCost = BigInt(gas) * maxFeeCapWei(plan.chainId);
  if (balance < maxCost) {
    console.log(
      kleur.yellow(
        `  ! account ${account} holds ${formatEther(balance)} ETH, less than the max cost above. That is enough if fees stay low; ` +
          "if it runs out part way, fund it and run the same command again (what is already on chain is skipped).",
      ),
    );
  }

  const what = `${plan.steps.some((s) => s.upTo) ? "up to " : ""}${txs} transaction${txs === 1 ? "" : "s"}`;
  if (opts.yes) {
    console.log(kleur.gray(`  --yes: sending ${what} without asking`));
    return true;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `refusing to send ${what} without a confirmation: there is no terminal to ask on. Pass --yes to send them` +
        " (check the plan above first; --dry-run, where a command has it, previews without sending).",
    );
  }
  const ok = await confirmTyped(`Send ${what}?`, { flag: "--yes" });
  if (!ok) console.log(kleur.gray("aborted: nothing was sent"));
  return ok;
}
