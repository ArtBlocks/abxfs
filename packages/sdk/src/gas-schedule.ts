/**
 * What a chain charges for the state an ABX FS write creates, and how a transaction's gas is capped there.
 *
 * Every content write creates state: contract code (the chunk or node, as SSTORE2), one new account per code
 * contract, and new storage slots (a chunk record is three, a node or directory one, a file up to eight). Two price
 * schedules exist:
 *
 *   - **legacy** (every chain before EIP-8037): code 200 gas per byte, a new account 32,000, a new slot 20,000 (22,100
 *     cold). One gas dimension, capped per transaction at 2^24 by EIP-7825 (and by what nodes will simulate).
 *   - **EIP-8037** (Glamsterdam; live on Sepolia since 2026-10-06): state is priced per byte of state created, at
 *     `CPSB` = 1,530 gas: code 1,530 per byte, a new account 183,600 (120 bytes), a new slot 97,920 (64 bytes). State
 *     gas is its own dimension: the 2^24 cap of EIP-7825 applies to EXECUTION gas only, and `tx.gas` may reach 2^32 - 1
 *     to carry the state part (EIP-8037's reservoir). A block's gas used is the larger of its execution and state sums,
 *     and a transaction's `tx.gas` must fit the block's remaining state budget, so the block gas limit bounds a
 *     transaction's TOTAL gas. EIP-7976 raises the calldata floor to 64 gas per byte; the floor must stay under 2^24.
 *
 * Measured on Sepolia (eth_simulateV1, 2026-10-29): a full 24,575-byte chunk is 38.72M (38.08M of it state); the same
 * write is 5.60M on Ethereum mainnet. Execution gas is the same on both apart from a few per-slot and per-account
 * access charges, so the SDK keeps ONE execution model (`node-gas.ts`, `gas.ts`) and prices state per schedule here.
 *
 * Nodes also cap what they will SIMULATE, and the SDK simulates every bundle before sending it (viem then asks
 * `eth_estimateGas` for its gas): geth and reth default to 50M (`--rpc.gascap`). Under EIP-8037 that, not consensus,
 * is what limits a bundle's total gas on most endpoints: a 2-chunk bundle (78M) failed to estimate on 8 of 10
 * Sepolia backends tried. So a bundle's total is kept under {@link DEFAULT_SIMULATION_GAS_CAP} unless the caller
 * knows its node allows more.
 */
import type { Address, PublicClient } from "viem";

export interface GasSchedule {
  /** `"legacy"` (one gas dimension) or `"eip8037"` (state gas is its own dimension). */
  readonly name: "legacy" | "eip8037";
  /** Gas per byte of deployed code. */
  readonly codeDepositPerByte: number;
  /** A new account (what CREATE / CREATE2 charges for the account itself). */
  readonly newAccount: number;
  /** A storage slot written from zero to non-zero (cold). */
  readonly newSlot: number;
  /** EXECUTION gas a new slot costs on top of {@link newSlot} (EIP-8038 charges the write itself as execution). */
  readonly newSlotExecution: number;
  /** EXECUTION gas a new account costs on top of {@link newAccount} (EIP-8038's `CREATE_ACCESS`). */
  readonly newAccountExecution: number;
  /** Whether state gas is a separate dimension that the per-transaction execution cap does not count. */
  readonly stateGasDimension: boolean;
}

export const LEGACY_GAS_SCHEDULE: GasSchedule = {
  name: "legacy",
  codeDepositPerByte: 200,
  newAccount: 32_000,
  newSlot: 22_100,
  newSlotExecution: 0,
  newAccountExecution: 0,
  stateGasDimension: false,
};

/**
 * EIP-8037 at `CPSB` = 1,530 (the value live on Sepolia, and in the EIP at Last Call), with EIP-8038's access charges
 * as Sepolia measured them: a chunk write (three new slots and an account) costs 48k more execution than on a legacy
 * chain, a node (one slot, one account) 24k.
 */
export const EIP8037_GAS_SCHEDULE: GasSchedule = {
  name: "eip8037",
  codeDepositPerByte: 1_530,
  newAccount: 183_600,
  newSlot: 97_920,
  newSlotExecution: 12_100,
  newAccountExecution: 12_000,
  stateGasDimension: true,
};

/** A gas estimate split by dimension. Under the legacy schedule the split is informational: only the total counts. */
export interface GasEstimate {
  execution: number;
  state: number;
}

/** The state gas of creating `codeBytes` of code in `accounts` new accounts and writing `slots` new slots. */
export function stateGas(created: { codeBytes?: number; accounts?: number; slots?: number }, schedule: GasSchedule): number {
  return (
    (created.codeBytes ?? 0) * schedule.codeDepositPerByte +
    (created.accounts ?? 0) * schedule.newAccount +
    (created.slots ?? 0) * schedule.newSlot
  );
}

/** EIP-7825's per-transaction cap: all gas before EIP-8037, execution gas only after it. */
export const TX_GAS_CAP = 16_777_216;

/** What a geth or reth node simulates at most by default (`--rpc.gascap`), whatever the transaction asks for. */
export const DEFAULT_SIMULATION_GAS_CAP = 50_000_000;

/** Calldata floor per byte (EIP-7976 under Glamsterdam; EIP-7623 before it), which must fit {@link TX_GAS_CAP}. */
export function calldataFloorPerByte(schedule: GasSchedule): number {
  return schedule.stateGasDimension ? 64 : 40;
}

/**
 * Chains whose schedule is known when the node cannot be asked (no client, or the probe failed). Anything not listed is
 * assumed legacy. Sepolia upgraded on 2026-10-06; add a chain here when it activates EIP-8037.
 */
const KNOWN_SCHEDULES: Readonly<Record<number, GasSchedule>> = {
  11155111: EIP8037_GAS_SCHEDULE,
};

/** The schedule a chain is known to run, from {@link KNOWN_SCHEDULES}; legacy when unknown. */
export function gasScheduleForChain(chainId: number | undefined): GasSchedule {
  return (chainId !== undefined ? KNOWN_SCHEDULES[chainId] : undefined) ?? LEGACY_GAS_SCHEDULE;
}

/** The keyless CREATE2 deployer, present on every chain ABX FS deploys to: the schedule probe asks it to deploy. */
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/**
 * Above this, a CREATE2 of one byte of code is priced under EIP-8037. Measured 2026-10-29: 54,299 on every legacy chain
 * (Ethereum, Base, Arbitrum and their testnets), 215,293 on Sepolia.
 */
const EIP8037_PROBE_THRESHOLD = 120_000;

const detected = new Map<string, Promise<GasSchedule>>();

/**
 * Ask the node which schedule it runs: `eth_estimateGas` of deploying one byte of code through the keyless CREATE2
 * deployer (a random salt, so no earlier deployment collides). Nothing is sent. Cached per chain for the process. Falls
 * back to {@link gasScheduleForChain} when the node cannot answer (no deployer, a mocked client, an RPC error).
 */
export function detectGasSchedule(publicClient: PublicClient): Promise<GasSchedule> {
  const chainId = publicClient.chain?.id;
  const key = chainId !== undefined ? String(chainId) : "";
  const cached = key ? detected.get(key) : undefined;
  if (cached) return cached;
  const probe = (async (): Promise<GasSchedule> => {
    try {
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      // Init code: PUSH1 1, PUSH1 0, RETURN — one zero byte of runtime code.
      const gas = await publicClient.estimateGas({ to: CREATE2_DEPLOYER, data: `0x${salt}60016000f3` });
      return Number(gas) > EIP8037_PROBE_THRESHOLD ? EIP8037_GAS_SCHEDULE : LEGACY_GAS_SCHEDULE;
    } catch {
      // Not cached: a transient failure should not decide the schedule for the rest of the process.
      if (key) detected.delete(key);
      return gasScheduleForChain(chainId);
    }
  })();
  if (key) detected.set(key, probe);
  return probe;
}

/** `explicit` when given; otherwise the node's answer ({@link detectGasSchedule}). */
export function resolveGasSchedule(publicClient: PublicClient, explicit?: GasSchedule): Promise<GasSchedule> {
  return explicit ? Promise.resolve(explicit) : detectGasSchedule(publicClient);
}

/** Forget cached probes (tests). */
export function clearGasScheduleCache(): void {
  detected.clear();
}
