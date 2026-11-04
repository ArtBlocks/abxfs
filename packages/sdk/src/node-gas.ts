/**
 * Shape and gas arithmetic of ABX FS nodes: the CANONICAL PARTITION of items into nodes, and the gas model.
 *
 * Both the packer (`nodes.ts`) and the estimators (`gas.ts`) need the SAME partition, or a plan's predicted transaction
 * count would be a parallel model of what is written. So the partition lives here.
 *
 * ## Content-defined boundaries
 *
 * Every node boundary is decided by the content next to it, never by position (the scheme of content-defined chunking
 * and prolly trees). Filling nodes front to back would make one inserted entry or chunk shift every later node, so an
 * edit near the start of a 50,000-entry directory would rewrite every leaf after it. With content-defined boundaries
 * an edit rewrites the leaf it lands in (rarely also its neighbour) and the branches above it: cost proportional to
 * the edit, not to the object.
 *
 *   - Chunk leaf: ends after a chunk whose hash's top 32 bits are below 2^32 / {@link CHUNK_LEAF_BOUNDARY_ODDS}, once it
 *     holds {@link CHUNK_LEAF_MIN_HASHES}; always at {@link CHUNK_LEAF_MAX_HASHES}. Average about 160 chunks.
 *   - Entry leaf: ends after a record when the leaf's blob is at least {@link ENTRY_LEAF_MIN_BYTES} and the top 32 bits
 *     of `keccak256(name)` are below `recordBytes * 2^32 / ENTRY_LEAF_TARGET_BYTES` (so the expected leaf is the same
 *     size in BYTES whatever the name lengths); always before a record that would pass the 24,575-byte node limit or
 *     the frozen {@link ENTRY_LEAF_GAS_CAP}. Average about 8 KB; a directory under ~4 KB of records is one leaf.
 *     The key is the NAME only, so changing a file's contents never moves a boundary.
 *   - Branch: ends after a child whose node id's top 32 bits are below 2^32 / {@link BRANCH_BOUNDARY_ODDS}, once it has
 *     two children; always at {@link BRANCH_MAX_CHILDREN}. A trailing branch of one child joins the one before it (or,
 *     if that is full, takes one child from it: 127 then 2), because the contracts refuse one-child branches.
 *
 * Every constant in this block is part of CANONICAL PACKING: changing one changes CIDs. `test/nodes.test.ts` and
 * `contracts-core/test/GoldenVectors.t.sol` pin vectors on both sides.
 *
 * ## Gas model
 *
 * A node call's gas is EXECUTION (validating the blob, the calls it makes, calldata, hashing) plus STATE (the node's
 * code, its account and its slot). State is priced by the chain's {@link GasSchedule} (`gas-schedule.ts`): 200 gas per
 * code byte before EIP-8037, 1,530 after it. So the constants below are execution only, {@link nodeStateGas} adds the
 * state for a schedule, and the schedule adds its own execution charges for the node's slot and account.
 *
 * Execution is an upper envelope of `eth_simulateV1` measurements (every call its own transaction, so every account
 * and slot cold) of the current stores on Sepolia (EIP-8037) and Ethereum mainnet (legacy), 2026-10-29: total minus
 * state minus the 21,000 transaction base. EIP-8038 adds execution charges for each new slot and account, which the
 * schedule carries (`newSlotExecution`, `newAccountExecution`); with those, execution measured the same on both chains
 * (the 646-record leaf: 5,876,560 legacy, 5,876,204 on Sepolia less 24,100), except that a directory branch's code
 * reads cost more under EIP-8038, so its constants follow Sepolia. Under EIP-8037:
 *
 *   node                                                      execution   modelled   total legacy   total EIP-8037
 *   646-record chunk leaf (24,549 B, the contract maximum)       5.90M      6.15M        10.86M          43.76M
 *   512-record chunk leaf (the SDK maximum)                      4.68M      4.88M         8.63M          34.75M
 *   323-record entry leaf, 8-byte names                          3.07M      3.26M         5.97M          25.13M
 *   60-record entry leaf, 255-byte names                         6.23M      6.64M         9.78M          33.26M
 *   128-child file branch                                        0.64M      0.69M         1.77M           9.17M
 *   128-child directory branch, level 1, 8-byte names            2.37M      2.49M         3.17M           9.72M
 *   128-child directory branch, level 1, 255-byte names          8.76M      9.14M         9.56M          16.12M
 *   128-child directory branch, level 3, 255-byte names         12.45M     13.00M        12.97M          19.81M
 *
 * A directory branch's ordering check reads the last name under each child and the first name under the next from
 * their code (descending to a leaf at every level) and compares them byte by byte, so its cost follows those EDGE names
 * and its level, not just its child count; the packer passes both. The old flat 30,000 per child under-ran a branch of
 * long names by 2x, and the old entry-leaf model under-ran 255-byte names by 30% (6.9M modelled, 9.8M measured).
 *
 * The frozen packing cost ({@link ENTRY_LEAF_PACKING}, {@link ENTRY_LEAF_GAS_CAP}) is NOT this model and does not bound
 * it: the largest entry leaf packing allows measured 9.8M under legacy pricing (still well inside one transaction).
 */
import { keccak256 } from "viem";

import { LEGACY_GAS_SCHEDULE, stateGas, type GasEstimate, type GasSchedule } from "./gas-schedule.js";

/** SSTORE2 data limit under EIP-170: 24,576 bytes of code minus the STOP prefix. */
export const NODE_MAX_BYTES = 24_575;
/** The contracts' level cap: leaves are level 0, branches 1..3. */
export const NODE_MAX_LEVEL = 3;
/** Most children of one branch (the contracts' `_MAX_BRANCH`). */
export const BRANCH_MAX_CHILDREN = 128;
/** Most chunk records the SDK packs into one leaf (the contracts accept 646): well inside a call. */
export const CHUNK_LEAF_MAX_HASHES = 512;
/** No content-defined boundary before a chunk leaf holds this many records. */
export const CHUNK_LEAF_MIN_HASHES = 32;
/** One chunk in this many ends a leaf (after the minimum). */
export const CHUNK_LEAF_BOUNDARY_ODDS = 128;
/** No content-defined boundary before an entry leaf's blob is this many bytes. */
export const ENTRY_LEAF_MIN_BYTES = 4096;
/** Expected bytes of records between content-defined entry boundaries (after the minimum). */
export const ENTRY_LEAF_TARGET_BYTES = 4096;
/** One child in this many ends a branch (after two). */
export const BRANCH_BOUNDARY_ODDS = 32;
/**
 * Most packing cost one entry leaf may have (see {@link entryLeafPackingCost}): the hard upper bound on an entry leaf,
 * which a content-defined boundary almost always ends first. Part of canonical packing.
 */
export const ENTRY_LEAF_GAS_CAP = 7_000_000;

/**
 * FROZEN. The cost model that decides where one entry leaf ends and the next begins. It started as the gas estimate
 * and is deliberately a SEPARATE copy of it: {@link NODE_GAS} is a tunable estimate (it was re-calibrated against real
 * receipts once already), while these numbers are part of CANONICAL PACKING, so changing one changes the CID of every
 * directory with more than a few hundred entries and forks the content-address space. `test/nodes.test.ts` pins the
 * resulting splits. Never edit these to track a gas measurement.
 */
export const ENTRY_LEAF_PACKING = { base: 75_000, perByte: 205, perRecord: 11_000, perNameByte: 170 } as const;

/** The frozen packing cost of an entry leaf of `count` records with `nameBytes` total name bytes. */
export function entryLeafPackingCost(count: number, nameBytes: number): number {
  return (
    ENTRY_LEAF_PACKING.base +
    ENTRY_LEAF_PACKING.perByte * entryLeafBlobSize(count, nameBytes) +
    ENTRY_LEAF_PACKING.perRecord * count +
    ENTRY_LEAF_PACKING.perNameByte * nameBytes
  );
}

/** EXECUTION gas of the node calls (see "Gas model" above); state is {@link nodeStateGas}. */
export const NODE_GAS = {
  /** Dispatch, the node id hash, the existence check, the CREATE2 placement, the event (legacy pricing; EIP-8038's
   *  extra charges for the node's slot and account come from the schedule). */
  nodeBase: 30_000,
  /** Per blob byte: calldata, hashing it for the id and for CREATE2, copying it into the init code. */
  nodePerByte: 25,
  /** Per chunk record: one cold `ChunkStore.sizeOf` (a cold slot behind a call). */
  chunkLeafPerHash: 8_500,
  /** Per entry: a cold child existence probe, its offset and flag. */
  entryPerRecord: 5_900,
  /** Per name byte: validation and the ordering compare, which read the name a word at a time. */
  entryPerNameByte: 12,
  /** Per child of a file branch: the child's slot and the cumulative count and byte checks. */
  fileBranchPerChild: 4_000,
  /** Per child of a directory branch: the child's slot, and the setup of the two edge-name reads per adjacent pair. */
  dirBranchPerChild: 11_900,
  /** Per level the ordering check descends to an edge name: a node slot and a code read, twice per adjacent pair. */
  dirBranchPerDescent: 6_500,
  /** Per byte of the two edge names each adjacent pair reads from code and compares. */
  dirBranchPerEdgeNameByte: 4,
  /** `FileStore.createFile` apart from its slots: the CID hash, the root check, the event. */
  createFileBase: 15_000,
  /** Per slot `createFile` writes, besides the schedule's per-slot charges: the mime words' calldata and copy. */
  createFilePerSlot: 1_000,
  /** `DirectoryStore.createDirectory`: the root check and the event (its one slot is state). */
  createDirectory: 25_000,
} as const;

/** `0x00 || (chunkId:32 || size:6) x n`. */
export const chunkLeafBlobSize = (hashes: number): number => 1 + 38 * hashes;
/** `level || n:2 || (childId:32 || cumulativeCount:4 [|| cumulativeBytes:6]) x n`; file branches carry bytes. */
export const branchBlobSize = (children: number, withBytes = false): number => 3 + (withBytes ? 42 : 36) * children;
/** `0x00 || count:2 || offset:2 x count || records`, record = `nameLen:1 || name || isDirectory:1 || cid:32`. */
export const entryLeafBlobSize = (count: number, nameBytes: number): number => 3 + 2 * count + 34 * count + nameBytes;

/** State a node creates: its code (`0x00 || blob`), the code's account and the node's slot. */
export function nodeStateGas(blobLength: number, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): number {
  return stateGas({ codeBytes: blobLength + 1, accounts: 1, slots: 1 }, schedule);
}

/**
 * A packed node's estimate under `schedule`, split by dimension. `estimatedGas` on a {@link PackedNode} is the legacy
 * total (what it has always been); its execution part is that minus the legacy state.
 */
export function nodeGasEstimate(node: { blob: Uint8Array; estimatedGas: number }, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): GasEstimate {
  const legacyExecution = Math.max(0, node.estimatedGas - nodeStateGas(node.blob.length, LEGACY_GAS_SCHEDULE));
  return {
    execution: legacyExecution + nodeExtraExecution(schedule),
    state: nodeStateGas(node.blob.length, schedule),
  };
}

/** The schedule's execution charges for a node's slot and account (zero on a legacy chain). */
function nodeExtraExecution(schedule: GasSchedule): number {
  return schedule.newSlotExecution + schedule.newAccountExecution;
}

export function chunkLeafExecution(hashes: number): number {
  return NODE_GAS.nodeBase + NODE_GAS.nodePerByte * chunkLeafBlobSize(hashes) + NODE_GAS.chunkLeafPerHash * hashes;
}

export function entryLeafExecution(count: number, nameBytes: number): number {
  return (
    NODE_GAS.nodeBase +
    NODE_GAS.nodePerByte * entryLeafBlobSize(count, nameBytes) +
    NODE_GAS.entryPerRecord * count +
    NODE_GAS.entryPerNameByte * nameBytes
  );
}

/** What a directory branch's ordering check depends on beyond its child count. */
export interface BranchShape {
  /** The branch's level (1..3): the check descends `level - 1` nodes to reach each edge name. Default 1. */
  level?: number;
  /**
   * Total bytes of the edge names the check compares: for each adjacent pair, the last name under the left child plus
   * the first name under the right one. Default: 64-byte names on both sides of every pair.
   */
  edgeNameBytes?: number;
}

export function branchExecution(children: number, withBytes = false, shape: BranchShape = {}): number {
  const base = NODE_GAS.nodeBase + NODE_GAS.nodePerByte * branchBlobSize(children, withBytes);
  if (withBytes) return base + NODE_GAS.fileBranchPerChild * children;
  const pairs = Math.max(0, children - 1);
  const level = shape.level ?? 1;
  const edge = shape.edgeNameBytes ?? pairs * 2 * 64;
  return (
    base +
    NODE_GAS.dirBranchPerChild * children +
    NODE_GAS.dirBranchPerDescent * 2 * pairs * Math.max(0, level - 1) +
    NODE_GAS.dirBranchPerEdgeNameByte * edge
  );
}

/** Total gas of a chunk leaf under `schedule` (legacy by default). */
export function estimateChunkLeaf(hashes: number, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): number {
  return chunkLeafExecution(hashes) + nodeExtraExecution(schedule) + nodeStateGas(chunkLeafBlobSize(hashes), schedule);
}

/** Total gas of an entry leaf under `schedule` (legacy by default). */
export function estimateEntryLeaf(count: number, nameBytes: number, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): number {
  return entryLeafExecution(count, nameBytes) + nodeExtraExecution(schedule) + nodeStateGas(entryLeafBlobSize(count, nameBytes), schedule);
}

/** Total gas of a branch under `schedule` (legacy by default). `shape` matters for directory branches only. */
export function estimateBranch(
  children: number,
  withBytes = false,
  shape: BranchShape = {},
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): number {
  return branchExecution(children, withBytes, shape) + nodeExtraExecution(schedule) + nodeStateGas(branchBlobSize(children, withBytes), schedule);
}

/** Slots `createFile` writes: the mime string (one slot up to 31 bytes, else a length slot and its words), the root, and the codec and output hash. */
export function createFileSlots(opts: { mimeBytes?: number; hasRoot?: boolean; hasCodec?: boolean } = {}): number {
  const mime = opts.mimeBytes ?? 127;
  return (mime <= 31 ? 1 : 1 + Math.ceil(mime / 32)) + (opts.hasRoot === false ? 0 : 1) + (opts.hasCodec === false ? 0 : 2);
}

/** `FileStore.createFile`, split by dimension. Defaults are the worst case: a 127-byte mime, a root and a codec. */
export function createFileGas(
  opts: { mimeBytes?: number; hasRoot?: boolean; hasCodec?: boolean } = {},
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): GasEstimate {
  const slots = createFileSlots(opts);
  return {
    execution: NODE_GAS.createFileBase + (NODE_GAS.createFilePerSlot + schedule.newSlotExecution) * slots,
    state: stateGas({ slots }, schedule),
  };
}

/** `DirectoryStore.createDirectory`, split by dimension: one slot. */
export function createDirectoryGas(schedule: GasSchedule = LEGACY_GAS_SCHEDULE): GasEstimate {
  return { execution: NODE_GAS.createDirectory, state: stateGas({ slots: 1 }, schedule) };
}

/** The top 32 bits of a 32-byte hex hash (a node id or chunk hash): the boundary key. */
export function hashKey(hex: string): number {
  return parseInt(hex.slice(2, 10), 16) >>> 0;
}

/** The boundary key of an entry: the top 32 bits of `keccak256(name bytes)`. */
export function nameKey(nameBytes: Uint8Array): number {
  return hashKey(keccak256(nameBytes));
}

const TWO_32 = 2 ** 32;

/**
 * How same-level nodes split into branches, given each child's boundary key ({@link hashKey} of its node id), in
 * order. Returns each branch's child count. Needs at least two children.
 */
export function branchGroupSizes(childKeys: readonly number[]): number[] {
  const n = childKeys.length;
  if (n < 2) throw new Error("a branch needs at least two children");
  const threshold = TWO_32 / BRANCH_BOUNDARY_ODDS;
  const sizes: number[] = [];
  let cur = 0;
  for (let i = 0; i < n; i++) {
    cur++;
    if (cur === BRANCH_MAX_CHILDREN || (cur >= 2 && childKeys[i]! < threshold)) {
      sizes.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) sizes.push(cur);
  const last = sizes.length - 1;
  if (sizes[last] === 1 && last > 0) {
    if (sizes[last - 1]! < BRANCH_MAX_CHILDREN) {
      sizes.pop();
      sizes[last - 1]! += 1;
    } else {
      sizes[last - 1] = BRANCH_MAX_CHILDREN - 1;
      sizes[last] = 2;
    }
  }
  return sizes;
}

/**
 * The FEWEST branch levels `leafCount` leaves can need (every branch full). The real count depends on content and is
 * checked on the packed tree; this bound is for refusing early without false refusals.
 */
export function branchLevelsNeeded(leafCount: number): number {
  let n = leafCount;
  let levels = 0;
  while (n > 1) {
    n = Math.ceil(n / BRANCH_MAX_CHILDREN);
    levels++;
  }
  return levels;
}

/**
 * Content-defined partition of entries (each its name byte length and {@link nameKey}, in name order) into leaves.
 * Returns each leaf's record count.
 */
export function partitionEntryLeaves(
  items: ReadonlyArray<{ nameLength: number; key: number }>,
  gasCap = ENTRY_LEAF_GAS_CAP,
): number[] {
  const out: number[] = [];
  let count = 0;
  let nameBytes = 0;
  for (const { nameLength, key } of items) {
    const c = count + 1;
    const b = nameBytes + nameLength;
    if (count > 0 && (entryLeafBlobSize(c, b) > NODE_MAX_BYTES || entryLeafPackingCost(c, b) > gasCap)) {
      out.push(count);
      count = 0;
      nameBytes = 0;
    }
    count++;
    nameBytes += nameLength;
    const recordBytes = 2 + 1 + nameLength + 1 + 32;
    if (
      entryLeafBlobSize(count, nameBytes) >= ENTRY_LEAF_MIN_BYTES &&
      key < Math.floor((recordBytes * TWO_32) / ENTRY_LEAF_TARGET_BYTES)
    ) {
      out.push(count);
      count = 0;
      nameBytes = 0;
    }
  }
  if (count > 0) out.push(count);
  return out;
}

/** Content-defined partition of chunks (each its {@link hashKey}, in order) into leaves. Returns each leaf's count. */
export function partitionChunkLeaves(keys: readonly number[]): number[] {
  const threshold = TWO_32 / CHUNK_LEAF_BOUNDARY_ODDS;
  const out: number[] = [];
  let cur = 0;
  for (const k of keys) {
    cur++;
    if (cur === CHUNK_LEAF_MAX_HASHES || (cur >= CHUNK_LEAF_MIN_HASHES && k < threshold)) {
      out.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) out.push(cur);
  return out;
}

/** Expected chunk-leaf size under {@link partitionChunkLeaves} (for estimates made before hashes exist). */
export const EXPECTED_CHUNK_LEAF = CHUNK_LEAF_MIN_HASHES + CHUNK_LEAF_BOUNDARY_ODDS;
/** Expected branch size under {@link branchGroupSizes} (for estimates). */
export const EXPECTED_BRANCH = 2 + BRANCH_BOUNDARY_ODDS;

/**
 * Estimated gas of the branches above `leafCount` leaves, at the expected branch size. `edgeNameLength` is the name
 * length assumed on each side of a directory branch's adjacent pairs.
 */
function expectedBranchesGas(leafCount: number, withBytes: boolean, schedule: GasSchedule, edgeNameLength = 64): number {
  let n = leafCount;
  let gas = 0;
  let level = 0;
  while (n > 1) {
    level++;
    const groups = Math.max(1, Math.ceil(n / EXPECTED_BRANCH));
    const children = Math.min(BRANCH_MAX_CHILDREN, Math.ceil(n / groups));
    const shape = { level, edgeNameBytes: Math.max(0, children - 1) * 2 * edgeNameLength };
    gas += groups * estimateBranch(children, withBytes, shape, schedule);
    n = groups;
  }
  return gas;
}

/**
 * Estimated gas of all the nodes of a file with `chunkCount` chunks (leaves and branches), not `createFile`. An
 * estimate at the expected leaf and branch sizes: the exact partition needs the chunk hashes.
 */
export function estimateChunkTreeGas(chunkCount: number, schedule: GasSchedule = LEGACY_GAS_SCHEDULE): number {
  const n = Math.max(1, chunkCount);
  const leaves = Math.max(1, Math.ceil(n / EXPECTED_CHUNK_LEAF));
  // Every leaf pays the fixed part (its base, account and slot); every record pays its share wherever it lands.
  const perLeaf = estimateChunkLeaf(0, schedule);
  const perHash = estimateChunkLeaf(1, schedule) - perLeaf;
  return leaves * perLeaf + n * perHash + expectedBranchesGas(leaves, true, schedule);
}

/** Estimated gas of all the nodes of a directory with these entries (name length and key, in name order). */
export function estimateEntryTreeGas(
  items: ReadonlyArray<{ nameLength: number; key: number }>,
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): number {
  const leaves = partitionEntryLeaves(items);
  let gas = 0;
  let at = 0;
  let allNameBytes = 0;
  for (const count of leaves) {
    let nameBytes = 0;
    for (let i = 0; i < count; i++) nameBytes += items[at + i]!.nameLength;
    at += count;
    allNameBytes += nameBytes;
    gas += estimateEntryLeaf(count, nameBytes, schedule);
  }
  const meanName = items.length > 0 ? Math.ceil(allNameBytes / items.length) : 0;
  return gas + expectedBranchesGas(leaves.length, false, schedule, meanName);
}
