/**
 * Read flow: load files and directories from chain. Everything is paged: nothing here asks a contract for a whole
 * large object, and a page is at most {@link PAGE_MAX} items.
 *
 * Trust model: a reader trusts the RPC it reads through, as any dapp does. The contracts check what an honest node
 * returns: `ChunkStore.read(id)` checks the backend's bytes against the chunk's record on every call (for an
 * EVM-readable backend), so an honest node cannot return other bytes without a revert. A file's codec output is
 * checked here against its `outputHash`, which catches a decoder that disagrees with the writer's.
 *
 * A chunk whose backend the EVM cannot read raises {@link ChunkUnavailableError}, carrying that backend's own
 * `retrieval()` description (best effort, untrusted): the bytes are elsewhere, and only a reader that knows the
 * backend's scheme can fetch them.
 */
import {
  BaseError,
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  getContractError,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { chunkStoreAbi, directoryStoreAbi, storageBackendAbi } from "./abi.js";
import { decodeEntryName, entryNameBytesLenient, isWellFormedText } from "./names.js";
import { isChunkReadGasRefusal, isRevertFailure, isTransportFailure, multicallReadHomogeneous, resultLimitOf } from "./multicall.js";
import { contentStores, fileStoreCallAbi, type ContentStores } from "./stores.js";
import { codecName, getFileCodec } from "./compression.js";
import { keccak256Hex, ZERO_HASH } from "./cid.js";
import type { AbxfsCid, ContractAddresses, Directory, DirectoryEntry, FileCodec } from "./types.js";
import { concatBytes, fromHex, mapInSlices, toHex } from "./util.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_INFLATE_BYTES,
  DEFAULT_MAX_NODES,
  LimitExceededError,
  TraversalBudget,
  descend,
  type Ancestry,
  type TraversalLimits,
} from "./limits.js";

/** Most items one page read asks for (a 100-entry `getEntries` is about 1.5M gas, well under any `eth_call` cap). */
export const PAGE_MAX = 100;
/** Pages fetched at once when reading a whole list. */
const PAGE_CONCURRENCY = 4;
/** The most chunks one `eth_call` (a multicall of `ChunkStore.read`) carries, whatever they cost. */
export const MAX_CHUNKS_PER_CALL = 64;
/**
 * The most estimated gas one chunk-read `eth_call` may plan to use: half of the 50M geth and reth simulate by default
 * (`--rpc.gascap`), so an estimate that is off by half still fits. A slice is sized from the chunks' records.
 */
export const READ_CALL_GAS_BUDGET = 25_000_000;

/**
 * What `ChunkStore.read` costs, from a chunk's record (backend and data size), measured on anvil 2026-10-29 (eth_call
 * gas of single reads and of multicalls of 1 to 64): a raw chunk about 30k plus 5 a byte (155k for a full one); a
 * FastLZ chunk is inflated on every read and its stream is not on the record, so it is counted at the worst stream
 * measured (a low-entropy chunk, 120 gas a data byte; text is ~40, a full chunk of real JS ~1.0M). A multicall's
 * results accumulate in one frame, so memory adds 3 gas a word plus words^2 / 512 over the whole slice (64 full raw
 * chunks: 14.4M measured, 16.2M estimated).
 */
const READ_GAS = { base: 30_000, rawPerByte: 6, fastLzPerByte: 125 } as const;

/** The largest chunk a backend holds (data bytes): what a chunk is assumed to be when its record is unknown. */
const MAX_CHUNK_BYTES = 24_575;

/** A full FastLZ chunk at the worst stream: the costliest chunk an honest file holds. */
const WORST_CHUNK_READ_GAS = READ_GAS.base + READ_GAS.fastLzPerByte * MAX_CHUNK_BYTES;

/**
 * A chunk's estimated read gas. A chunk on the address book's raw backend is priced as raw; every other one, the
 * FastLZ backend and any backend outside the address book alike, at FastLZ's worst stream. A backend anyone deployed
 * may cost more than that (or revert): a call it makes too costly is halved like any other, within the read's call
 * budget ({@link defaultMaxChunkReadCalls}). It is never priced past the budget on its own, which would read each such
 * chunk in a call of its own (16,384 sequential calls for a file of that many). A chunk whose record could not be read
 * is priced as the costliest chunk there is, a full FastLZ one at the worst stream: it may be one.
 */
function chunkReadGas(record: ChunkRecord | undefined, addresses: ContractAddresses): number {
  if (!record) return WORST_CHUNK_READ_GAS;
  const b = record.backend.toLowerCase();
  if (addresses.sstore2Backend && b === addresses.sstore2Backend.toLowerCase()) return READ_GAS.base + READ_GAS.rawPerByte * record.size;
  return READ_GAS.base + READ_GAS.fastLzPerByte * record.size;
}

function sliceMemoryGas(bytes: number): number {
  const words = Math.ceil(bytes / 32);
  return 3 * words + Math.floor((words * words) / 512);
}

/** How many of the costliest chunks (a full FastLZ chunk at the worst stream) fit one call of `budget` gas. */
function worstChunksPerCall(budget: number): number {
  let n = 1;
  while ((n + 1) * WORST_CHUNK_READ_GAS + sliceMemoryGas((n + 1) * MAX_CHUNK_BYTES) <= budget) n++;
  return n;
}

/**
 * How many chunks fit one call within budget even if every one is the costliest kind (a full FastLZ chunk at the worst
 * stream): a read of no more than this needs no records (a ranged read of a few chunks stays one call). 8.
 */
const BLIND_READ_CHUNKS = worstChunksPerCall(READ_CALL_GAS_BUDGET);

/**
 * The same at half of {@link READ_CALL_GAS_BUDGET}, where a read re-plans once a node has refused a planned call for
 * gas (4).
 * Half the budget is 12.5M, under the 2^24 (16,777,216) some public nodes simulate per `eth_call`: Ethereum Sepolia's
 * publicnode measured 16,762,214, which refuses 8 full FastLZ chunks of CSV, hex or DNA (18-21M) and reads 4.
 */
const HALVED_READ_CHUNKS = worstChunksPerCall(READ_CALL_GAS_BUDGET / 2);

/** Records read per `eth_call` when planning a read: a few slots each, so a page is cheap. */
const RECORDS_PER_CALL = 256;

/**
 * The default cap on the `eth_call`s one {@link readChunkSlices} of `n` chunks may make:
 * `ceil(n / 4) + ceil(n / 256) + 8`. That is a call per {@link HALVED_READ_CHUNKS} chunks (what the costliest honest
 * content needs, every chunk a full FastLZ one at the worst stream, on a node that simulates half of
 * {@link READ_CALL_GAS_BUDGET}: a read re-plans at half the gas once a node refuses a planned call for gas), a call
 * per page of records, and 8 more for a first try and the refusals before the re-plan. A node that simulates 2^24 gas
 * per `eth_call` reads any honest file within it, and so does one that returns at most 100,000 bytes from a call
 * (Erigon's default `--rpc.returndata.limit`: four full chunks), because the read plans within the limit it names.
 *
 * A backend whose calls keep failing, or a node that keeps refusing, cannot turn one read into thousands of sequential
 * calls: past the cap the read throws {@link LimitExceededError} (`limit: "calls"`), 262 calls for a file of 1,000
 * chunks. A reader that expects a node to refuse more (one that simulates less than about 12.5M gas per `eth_call`)
 * passes its own `maxCalls`.
 */
export function defaultMaxChunkReadCalls(n: number): number {
  return Math.ceil(n / HALVED_READ_CHUNKS) + Math.ceil(n / RECORDS_PER_CALL) + 8;
}

/** `maxCalls` as a caller passed it: a positive integer, or `Infinity` for no cap. Anything else is a RangeError. */
function checkMaxCalls(value: number | undefined): void {
  if (value === undefined || value === Infinity || (Number.isSafeInteger(value) && value >= 1)) return;
  throw new RangeError(`maxCalls must be a positive integer or Infinity (got ${value})`);
}

/** A chunk's record as `ChunkStore.recordOf` returns it (the parts a reader plans with). */
interface ChunkRecord {
  backend: Address;
  size: number;
}
/** Default cap on the chunks of one file read into memory. */
export const DEFAULT_MAX_CHUNKS = 200_000;
/**
 * Default cap on the entries {@link readDirectory} reads into memory (the same as a traversal's node cap). The count is
 * checked before any page is planned: a directory is permissionless, and a hostile RPC can claim any count.
 */
export const DEFAULT_MAX_ENTRIES = DEFAULT_MAX_NODES;

/**
 * `abi` with every `string` OUTPUT of `functions` typed `bytes`. The two are encoded identically, so the results are the
 * same bytes; only decoding differs, and viem decodes a `string` with a default `TextDecoder`, which drops a leading
 * U+FEFF and turns invalid UTF-8 into U+FFFD. Inputs are left alone: a parameter's type is part of the function
 * selector. Derived from the mirror rather than copied, so it cannot drift from it (and the mirror itself stays exactly
 * what `forge inspect` says).
 */
function withBytesOutputs(abi: Abi, functions: readonly string[]): Abi {
  type Param = { type: string; components?: readonly Param[] };
  const swap = (p: Param): Param => ({
    ...p,
    type: p.type === "string" ? "bytes" : p.type === "string[]" ? "bytes[]" : p.type,
    ...(p.components ? { components: p.components.map(swap) } : {}),
  });
  return abi.map((item) =>
    item.type === "function" && functions.includes(item.name) ? { ...item, outputs: item.outputs.map((p) => swap(p as Param)) } : item,
  ) as Abi;
}

/** `DirectoryStore` with entry names decoded as bytes: every listing goes through this, so no name is decoded lossily. */
const directoryStoreBytesAbi = withBytesOutputs(directoryStoreAbi as unknown as Abi, ["getEntries", "getEntry"]);

/**
 * A name's bytes as the bytes ABI returns them (0x-hex). A client that hands back text instead (a `readContract` test
 * double written against the mirror's `string` type) is taken at its word, as that text's form.
 */
function nameBytesOf(raw: unknown): Uint8Array {
  const s = String(raw);
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(s) ? fromHex(s) : entryNameBytesLenient(s);
}

/** A path's bytes for `resolvePath`: each `/`-separated segment as its name bytes (`names.ts`). */
function pathBytes(path: string): Uint8Array {
  const slash = new Uint8Array([0x2f]);
  return concatBytes(...path.split("/").flatMap((seg, i) => (i === 0 ? [entryNameBytesLenient(seg)] : [slash, entryNameBytesLenient(seg)])));
}

/**
 * Call a `DirectoryStore` view `(bytes32, string)` with the string as raw BYTES. viem encodes a `string` argument as
 * UTF-8 of a JS string, which cannot hold a name that is not UTF-8; well-formed text without a `\xHH` escape is sent
 * through `readContract` as before (it encodes to the same bytes). Otherwise the calldata is the function's real selector with
 * the bytes ABI-encoded in the string's place (identical encoding), and a failure is wrapped as `readContract` wraps
 * one, so a revert reads as a revert.
 */
async function readDirectoryView(
  publicClient: PublicClient,
  address: Address,
  functionName: "lookup" | "resolvePath",
  cid: AbxfsCid,
  text: string,
  bytes: Uint8Array,
): Promise<readonly [AbxfsCid, boolean]> {
  if (!text.includes("\\") && isWellFormedText(text)) {
    return (await publicClient.readContract({ address, abi: directoryStoreAbi, functionName, args: [cid, text] })) as readonly [AbxfsCid, boolean];
  }
  const item = directoryStoreAbi.find((x) => x.type === "function" && x.name === functionName)!;
  const data = concatHex([toFunctionSelector(item as AbiFunction), encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [cid, toHex(bytes)])]);
  try {
    const { data: out } = await publicClient.call({ to: address, data });
    return decodeFunctionResult({ abi: directoryStoreAbi, functionName, data: out ?? "0x" }) as readonly [AbxfsCid, boolean];
  } catch (err) {
    throw getContractError(err as BaseError, { abi: directoryStoreAbi as unknown as Abi, address, args: [cid, toHex(bytes)], functionName });
  }
}

const ZERO = ZERO_HASH.toLowerCase();

// ─── Errors ────────────────────────────────────────────────────────────────────

/**
 * A file's decoded content does not hash to the `outputHash` in its record (and its CID). A lying RPC, or a reader
 * whose decoder disagrees with the writer's: either way the bytes are refused.
 */
export class OutputHashMismatchError extends Error {
  readonly cid: AbxfsCid;
  readonly expectedHash: AbxfsCid;
  readonly actualHash: AbxfsCid;

  constructor(args: { cid: AbxfsCid; expectedHash: AbxfsCid; actualHash: AbxfsCid }) {
    super(
      `output-hash verification failed for file ${args.cid}: expected keccak256(decoded content) == ` +
        `${args.expectedHash}, got ${args.actualHash}. The RPC may be fabricating bytes, or this reader's decoder ` +
        "disagrees with the writer's.",
    );
    this.name = "OutputHashMismatchError";
    this.cid = args.cid;
    this.expectedHash = args.expectedHash;
    this.actualHash = args.actualHash;
  }
}

/**
 * A chunk's backend cannot serve its bytes on chain: its read reverted, and the backend does not say it is EVM-readable
 * (it names another scheme, or none). `scheme` and `instructions` are the backend's own `retrieval()` answer: best
 * effort and untrusted, empty when it gave none.
 */
export class ChunkUnavailableError extends Error {
  readonly chunkId: AbxfsCid;
  readonly backend: Address;
  readonly scheme: string;
  readonly instructions: string;

  constructor(args: { chunkId: AbxfsCid; backend: Address; scheme: string; instructions: string }) {
    super(
      `chunk ${args.chunkId} cannot be read on chain from backend ${args.backend}` +
        (args.scheme ? ` (scheme "${args.scheme}")` : "") +
        (args.instructions ? `. The backend says: ${args.instructions}` : ". The backend gives no retrieval instructions."),
    );
    this.name = "ChunkUnavailableError";
    this.chunkId = args.chunkId;
    this.backend = args.backend;
    this.scheme = args.scheme;
    this.instructions = args.instructions;
  }
}

/** The backend's `retrieval()` answer, best effort: never throws. */
export async function backendRetrieval(
  publicClient: PublicClient,
  backend: Address,
): Promise<{ scheme: string; instructions: string }> {
  try {
    const [scheme, instructions] = (await publicClient.readContract({
      address: backend,
      abi: storageBackendAbi,
      functionName: "retrieval",
    })) as readonly [`0x${string}`, string];
    let token = "";
    try {
      token = codecName(scheme) ?? "";
    } catch {
      token = "";
    }
    return { scheme: token, instructions: String(instructions).slice(0, 500) };
  } catch {
    return { scheme: "", instructions: "" };
  }
}

// ─── Files ─────────────────────────────────────────────────────────────────────

export interface FileInfo {
  /** The root chunk node; zero for the empty file. */
  root: `0x${string}`;
  rootLevel: number;
  chunkCount: number;
  /** Total bytes of the joined chunk data (before any file codec is decoded). */
  size: number;
  mimeType: string;
  codec: FileCodec;
  outputHash: AbxfsCid;
}

export async function getFileInfo(publicClient: PublicClient, addresses: ContractAddresses, cid: AbxfsCid): Promise<FileInfo> {
  const info = (await publicClient.readContract({
    address: contentStores(addresses).fileStore,
    abi: fileStoreCallAbi,
    functionName: "getFileInfo",
    args: [cid],
  })) as {
    root: `0x${string}`;
    rootLevel: number;
    chunkCount: bigint;
    size: bigint;
    mimeType: string;
    codec: FileCodec;
    outputHash: AbxfsCid;
  };
  return {
    root: info.root,
    rootLevel: Number(info.rootLevel),
    chunkCount: Number(info.chunkCount),
    size: Number(info.size),
    mimeType: info.mimeType,
    codec: info.codec,
    outputHash: info.outputHash,
  };
}

/** The chunk holding byte `offset` of a file's data: its index, the offset of its first byte, its id and size. One call. */
export async function locateByte(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  offset: number,
): Promise<{ index: number; chunkStart: number; chunkId: AbxfsCid; chunkSize: number }> {
  const [index, chunkStart, id, chunkSize] = (await publicClient.readContract({
    address: contentStores(addresses).fileStore,
    abi: fileStoreCallAbi,
    functionName: "locateByte",
    args: [cid, BigInt(offset)],
  })) as readonly [bigint, bigint, AbxfsCid, bigint];
  return { index: Number(index), chunkStart: Number(chunkStart), chunkId: id, chunkSize: Number(chunkSize) };
}

function pageRanges(start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = start; s < end; s += PAGE_MAX) out.push([s, Math.min(s + PAGE_MAX, end)]);
  return out;
}

/** Chunk ids in `[start, start + count)`, `count` clamped to {@link PAGE_MAX} and to the file's length. */
export async function getChunkIdsPage(
  publicClient: PublicClient,
  stores: ContentStores,
  cid: AbxfsCid,
  start: number,
  count: number,
  total: number,
): Promise<AbxfsCid[]> {
  if (start >= total || count <= 0) return [];
  const end = Math.min(start + Math.min(count, PAGE_MAX), total);
  const ids = (await publicClient.readContract({
    address: stores.fileStore,
    abi: fileStoreCallAbi,
    functionName: "getChunkIds",
    args: [cid, BigInt(start), BigInt(end)],
  })) as readonly AbxfsCid[];
  return [...ids];
}

/** Every chunk id of a file, in order, read in pages of {@link PAGE_MAX}. */
export async function readChunkIds(
  publicClient: PublicClient,
  stores: ContentStores,
  cid: AbxfsCid,
  chunkCount: number,
  opts: { maxChunks?: number } = {},
): Promise<AbxfsCid[]> {
  const max = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  if (chunkCount > max) throw new LimitExceededError("nodes", max, `file ${cid} (${chunkCount} chunks)`);
  const pages = await mapInSlices(
    pageRanges(0, chunkCount),
    async ([s, e]) => {
      const got = await getChunkIdsPage(publicClient, stores, cid, s, e - s, chunkCount);
      if (got.length !== e - s) throw new Error(`file ${cid}: asked for chunk ids [${s}, ${e}) and got ${got.length}`);
      return got;
    },
    PAGE_CONCURRENCY,
  );
  return pages.flat();
}

export interface ReadFileResult {
  cid: AbxfsCid;
  mimeType: string;
  /** The file codec label (zero for none). */
  codec: FileCodec;
  chunkIds: AbxfsCid[];
  /** `keccak256(content)` when a codec is set; zero otherwise. */
  outputHash: AbxfsCid;
  /** The file's content: what a reader serves (the data, decoded when there is a codec). */
  bytes: Uint8Array;
  /** The file's data: its chunks' data joined (equal to `bytes` without a codec). */
  data: Uint8Array;
}

export interface ReadFileOptions {
  /** Most bytes a file codec may decode to. Default 256 MiB; decoding aborts when crossed. */
  maxInflateBytes?: number;
  /** Most data bytes to read for one file. Default 1 GiB. */
  maxStoredBytes?: number;
  /** Most chunks to read for one file (the ids are paged in). Default 200,000. */
  maxChunks?: number;
  /**
   * Most `eth_call`s reading the chunks may make (not counting the id pages): a positive integer, or `Infinity`.
   * Default {@link defaultMaxChunkReadCalls}.
   */
  maxCalls?: number;
}

/**
 * Read a file by CID: page its chunk ids, read every chunk, join them, and decode the file codec if there is
 * one (checking the result against `outputHash`). The empty file reads as zero bytes.
 */
export async function readFile(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  checkMaxCalls(options.maxCalls);
  const stores = contentStores(addresses);
  const info = await getFileInfo(publicClient, addresses, cid);
  const maxData = options.maxStoredBytes ?? DEFAULT_MAX_BYTES;
  if (info.size > maxData) throw new LimitExceededError("bytes", maxData, `file ${cid}`);
  const chunkIds = await readChunkIds(publicClient, stores, cid, info.chunkCount, {
    ...(options.maxChunks !== undefined ? { maxChunks: options.maxChunks } : {}),
  });
  const parts = await readChunkSlices(publicClient, addresses, cid, chunkIds, maxData, {
    ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}),
  });
  const data = concatBytes(...parts);

  let bytes = data;
  if (info.codec.toLowerCase() !== ZERO) {
    bytes = await Promise.resolve(
      getFileCodec(info.codec).decode(data, { maxOutputBytes: options.maxInflateBytes ?? DEFAULT_MAX_INFLATE_BYTES }),
    );
    const actual = keccak256Hex(bytes);
    if (actual.toLowerCase() !== info.outputHash.toLowerCase()) {
      throw new OutputHashMismatchError({ cid, expectedHash: info.outputHash, actualHash: actual });
    }
  }
  return { cid, mimeType: info.mimeType, codec: info.codec, chunkIds, outputHash: info.outputHash, bytes, data };
}

/**
 * The records of `ids` (backend and data size), read in batches of {@link RECORDS_PER_CALL}. A batch that fails (a
 * missing chunk reverts the whole multicall), or whose answer does not have one record per id, leaves its records
 * unknown: the read that follows reports what is wrong. `spend` is called before each call (the read's call budget).
 */
async function readChunkRecords(
  publicClient: PublicClient,
  chunkStore: Address,
  ids: readonly AbxfsCid[],
  spend: () => void,
): Promise<Array<ChunkRecord | undefined>> {
  const out: Array<ChunkRecord | undefined> = new Array(ids.length);
  for (let off = 0; off < ids.length; off += RECORDS_PER_CALL) {
    const batch = ids.slice(off, off + RECORDS_PER_CALL);
    spend();
    try {
      const recs = await multicallReadHomogeneous<readonly [Address, bigint | number, ...unknown[]]>(
        publicClient,
        chunkStoreAbi as never,
        chunkStore,
        "recordOf",
        batch.map((id) => [id]),
      );
      if (recs.length !== batch.length) continue;
      recs.forEach((r, j) => (out[off + j] = { backend: r[0], size: Number(r[1]) }));
    } catch (err) {
      if (isTransportFailure(err)) throw err;
    }
  }
  return out;
}

/**
 * Cut `ids` into consecutive slices whose estimated read gas (each chunk from its record, plus the memory the slice's
 * results take) stays under {@link READ_CALL_GAS_BUDGET}, at most {@link MAX_CHUNKS_PER_CALL} each, and whose
 * results are at most `maxResult` bytes. A chunk too costly or too long to share a call gets a slice of its own.
 * Exported for tests.
 */
export function planChunkReadSlices(
  records: ReadonlyArray<ChunkRecord | undefined>,
  addresses: ContractAddresses,
  budget: number = READ_CALL_GAS_BUDGET,
  maxResult: number = Infinity,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = 0; start < records.length; ) {
    const end = nextChunkReadSlice(records, addresses, start, budget, maxResult);
    out.push([start, end]);
    start = end;
  }
  return out;
}

/**
 * The bytes a chunk-read call returns: `multicall`'s `bytes[]` (an offset and a length word), and per chunk an offset
 * word, a length word, and `read`'s own ABI-encoded `bytes` (an offset and a length word, then the data padded to a
 * word).
 */
function sliceResultBytes(chunks: number, paddedData: number): number {
  return 64 + 128 * chunks + paddedData;
}

/**
 * The end of the slice that starts at `start` ({@link planChunkReadSlices} one slice at a time): as many chunks as fit
 * `budget`, {@link MAX_CHUNKS_PER_CALL} and `maxResult` (the bytes the node returns from one call), and always at
 * least one.
 */
function nextChunkReadSlice(
  records: ReadonlyArray<ChunkRecord | undefined>,
  addresses: ContractAddresses,
  start: number,
  budget: number,
  maxResult: number = Infinity,
): number {
  let gas = 0;
  let bytes = 0;
  let padded = 0;
  let i = start;
  for (; i < records.length; i++) {
    const g = chunkReadGas(records[i], addresses);
    const b = records[i]?.size ?? MAX_CHUNK_BYTES;
    const p = Math.ceil(b / 32) * 32;
    const n = i - start;
    if (
      n > 0 &&
      (n >= MAX_CHUNKS_PER_CALL || gas + g + sliceMemoryGas(bytes + b) > budget || sliceResultBytes(n + 1, padded + p) > maxResult)
    )
      break;
    gas += g;
    bytes += b;
    padded += p;
  }
  return i;
}

/**
 * Each chunk's data, in order, for any slice of a file's chunk ids (`cid` only labels errors), read through
 * `ChunkStore.read` (which checks each chunk against its record). Exported for readers that need PART of a file (the
 * gateway's ranged reads).
 *
 * A FastLZ chunk is inflated on every read, and 64 of them cost 65-108M, past the 50M most nodes simulate, so calls are
 * sized from the chunks' records ({@link planChunkReadSlices}, under {@link READ_CALL_GAS_BUDGET}): up front for a read
 * of more than {@link MAX_CHUNKS_PER_CALL} chunks; for one call's worth or less, only after the node refuses the single
 * call it is tried as first (most content is cheap, and a range bundle then stays one round trip). A call that still
 * fails (a node with a lower cap, a chunk the chain cannot serve, records that could not be read, an answer without
 * exactly one result per chunk) is split in half and each half retried, keeping every chunk already read; a single
 * chunk whose read reverts on its own is explained ({@link ChunkUnavailableError}) unless its backend says it is
 * EVM-readable, and any other failure of one chunk is rethrown as the node's own error. A failure of the connection is rethrown at once.
 *
 * A planned call that the node refused FOR GAS ({@link isChunkReadGasRefusal}: `RetrieveFailed` or an empty revert, or
 * the node's own out-of-gas words) but whose halves were read says the node simulates less than the plan assumed (a
 * public node capped at 2^24, say), so the rest of the read is re-planned at half the gas budget, and again after each
 * further such refusal: the remaining calls are not each refused and halved in turn. A call (planned, or a part of one)
 * refused because its result is longer than the node returns ({@link resultLimitOf}: Erigon's `--rpc.returndata.limit`,
 * 100,000 bytes by default) is read in slices within the limit the node named, and so is the rest of the read; a limit
 * is taken only when it is below what the refused call returns, so each one shortens what is asked next. Any other
 * failure (a JSON-RPC error that is not a revert, a malformed answer) is read by halves just the same but leaves the
 * plan alone.
 *
 * Every call counts against `opts.maxCalls` (a positive integer or `Infinity`; default
 * {@link defaultMaxChunkReadCalls}); past it the read throws {@link LimitExceededError} with `limit: "calls"`, so no
 * backend or node can make one read cost thousands of calls.
 */
export async function readChunkSlices(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  chunkIds: readonly AbxfsCid[],
  maxBytes: number,
  opts: { maxCalls?: number } = {},
): Promise<Uint8Array[]> {
  checkMaxCalls(opts.maxCalls);
  const chunkStore = contentStores(addresses).chunkStore;
  const n = chunkIds.length;
  const parts: Uint8Array[] = new Array(n);
  const maxCalls = opts.maxCalls ?? defaultMaxChunkReadCalls(n);
  let calls = 0;
  const spend = () => {
    if (++calls > maxCalls) throw new LimitExceededError("calls", maxCalls, `reading file ${cid} (${n} chunks)`);
  };
  let total = 0;
  const keep = (at: number, data: Uint8Array) => {
    total += data.length;
    if (total > maxBytes) throw new LimitExceededError("bytes", maxBytes, `file ${cid}`);
    parts[at] = data;
  };
  /**
   * One multicall of `[s, e)`, or why it failed: the node refused it, or it answered without exactly one result per
   * chunk asked for (`malformed`; a hole or an extra chunk is never taken as data). A failure of the connection is
   * thrown.
   */
  const tryRange = async (s: number, e: number): Promise<`0x${string}`[] | { failed: unknown; malformed?: true }> => {
    spend();
    let got: `0x${string}`[];
    try {
      got = await multicallReadHomogeneous<`0x${string}`>(publicClient, chunkStoreAbi as never, chunkStore, "read", chunkIds.slice(s, e).map((id) => [id]));
    } catch (err) {
      if (isTransportFailure(err)) throw err;
      return { failed: err };
    }
    if (got.length !== e - s) {
      return { failed: new Error(`file ${cid}: asked for ${e - s} chunks [${s}, ${e}) in one call and got ${got.length} results`), malformed: true };
    }
    return got;
  };
  /** The records of a sized read ({@link readSized}), once read: what a call's result length is computed from. */
  let records: ReadonlyArray<ChunkRecord | undefined> | undefined;
  /** The smallest result length a node has named for this read ({@link resultLimitOf}): every call is planned within it. */
  let maxResult = Infinity;
  /**
   * The result limit the refused call of `[s, e)` names, when the read has its records and the limit is below what the
   * call returns. A limit the call is already within says nothing about why it was refused, so it is not taken: each
   * limit taken shortens what is asked next, and a node that names one on every refusal cannot keep a read going.
   */
  const namedLimit = (s: number, e: number, got: { failed: unknown; malformed?: true }): number | undefined => {
    if (!records || got.malformed) return undefined;
    const limit = resultLimitOf(got.failed);
    return limit !== undefined && limit < resultBytes(s, e) ? limit : undefined;
  };
  /** What a call of `[s, e)` returns, from the records. */
  const resultBytes = (s: number, e: number): number => {
    let padded = 0;
    for (let i = s; i < e; i++) padded += Math.ceil((records?.[i]?.size ?? MAX_CHUNK_BYTES) / 32) * 32;
    return sliceResultBytes(e - s, padded);
  };
  /**
   * Read `[s, e)` in one call, splitting it while the node refuses. Whether any call on the way was refused for GAS
   * ({@link isChunkReadGasRefusal}): every failure is read around, but only that one says the node simulates less than
   * the plan assumed. A load-balanced RPC's transient `-32603 internal error` or a malformed answer says nothing about
   * the node's gas, and taking it as a gas refusal once halved the rest of a long read's budget for good (two such
   * blips made a 1,000-chunk FastLZ read fail its call budget on a 50M node).
   */
  const readRange = async (s: number, e: number): Promise<boolean> => {
    // A part of a call split before the node named its limit (the other half of a halving) is not asked whole.
    if (records && e - s > 1 && resultBytes(s, e) > maxResult) return readWithin(s, e);
    const got = await tryRange(s, e);
    if (Array.isArray(got)) {
      for (let j = 0; j < got.length; j++) keep(s + j, fromHex(got[j]!));
      return false;
    }
    return readSplit(s, e, got);
  };
  /**
   * {@link readRange} once the call for `[s, e)` has failed (`got`): one chunk explained, else `[s, e)` read in parts.
   * Refused for its length (a limit the node named, {@link namedLimit}), in slices within that limit, which the rest of
   * the read is planned within too: a call split in halves would be refused again at every level above the limit (a
   * 64-chunk call after one transient error, 15 calls to reach 4 chunks). Refused otherwise, in halves.
   */
  const readSplit = async (s: number, e: number, got: { failed: unknown; malformed?: true }): Promise<boolean> => {
    if (e - s === 1) {
      // One chunk the chain cannot serve (its read reverted): say where its bytes are instead, when its backend says.
      // Anything else is the node's or the RPC's doing, never the backend's, and is reported as it is: an answer of the
      // wrong shape, a result too long for the node, a load balancer's `-32603 internal error`.
      if (!got.malformed && isRevertFailure(got.failed)) await explainUnavailable(publicClient, chunkStore, chunkIds[s]!);
      throw got.failed;
    }
    const limit = namedLimit(s, e, got);
    if (limit !== undefined) {
      maxResult = Math.min(maxResult, limit);
      return readWithin(s, e);
    }
    const mid = s + Math.ceil((e - s) / 2);
    const left = await readRange(s, mid);
    const right = await readRange(mid, e);
    return (!got.malformed && isChunkReadGasRefusal(got.failed)) || left || right;
  };
  /**
   * `[s, e)` in calls within {@link maxResult}. It is part of a slice already planned under the gas budget, so only the
   * length decides; each call is shorter than `[s, e)`, which is longer than the limit.
   */
  const readWithin = async (s: number, e: number): Promise<boolean> => {
    let gas = false;
    for (let a = s; a < e; ) {
      const b = Math.min(e, nextChunkReadSlice(records!, addresses, a, Infinity, maxResult));
      if (await readRange(a, b)) gas = true;
      a = b;
    }
    return gas;
  };
  /**
   * Read everything in slices sized from the records, refusing first when the records already exceed `maxBytes`. A
   * planned slice the node refused for gas, read in parts, halves the gas budget the rest is planned with. One the node
   * refused for its length ({@link namedLimit}) is planned again, from where it starts, within the limit it named.
   * `first` is the one call a read of a call's worth tried before it had records: its refusal counts the same way.
   */
  const readSized = async (first?: { failed: unknown; malformed?: true }): Promise<void> => {
    records = await readChunkRecords(publicClient, chunkStore, chunkIds, spend);
    let planned = 0;
    for (const r of records) planned += r?.size ?? 0;
    if (planned > maxBytes) throw new LimitExceededError("bytes", maxBytes, `file ${cid}`);
    if (first) maxResult = Math.min(maxResult, namedLimit(0, n, first) ?? Infinity);
    let budget = READ_CALL_GAS_BUDGET;
    for (let s = 0; s < n; ) {
      const e = nextChunkReadSlice(records, addresses, s, budget, maxResult);
      const got = await tryRange(s, e);
      if (Array.isArray(got)) {
        for (let j = 0; j < got.length; j++) keep(s + j, fromHex(got[j]!));
      } else {
        const limit = namedLimit(s, e, got);
        if (limit !== undefined && e - s > 1) {
          maxResult = Math.min(maxResult, limit);
          continue;
        }
        if (await readSplit(s, e, got)) budget = Math.floor(budget / 2);
      }
      s = e;
    }
  };

  if (n === 0) return parts;
  if (n <= BLIND_READ_CHUNKS) {
    // A few chunks fit one call whatever they are (a ranged read): no records, one call, halved only if refused.
    await readRange(0, n);
  } else if (n <= MAX_CHUNKS_PER_CALL) {
    // Up to one call's worth (a gateway's range bundle, a small file): tried as one call first, which is what most
    // content costs; only a node that refuses it (or answers it malformed) pays for the records and the sized slices.
    const got = await tryRange(0, n);
    if (Array.isArray(got)) for (let j = 0; j < got.length; j++) keep(j, fromHex(got[j]!));
    else await readSized(got);
  } else {
    await readSized();
  }
  return parts;
}

/**
 * Throw {@link ChunkUnavailableError} for a chunk `ChunkStore.read` refused, naming its backend. Return, so the original
 * error stands, if it has no record, or if its backend says it is EVM-readable (scheme `evm`): the chain can serve that
 * chunk, so whatever refused it (a node that simulates less gas than one chunk's read) was not its backend.
 */
async function explainUnavailable(publicClient: PublicClient, chunkStore: Address, id: AbxfsCid): Promise<void> {
  let backend: Address;
  try {
    const rec = (await publicClient.readContract({
      address: chunkStore,
      abi: chunkStoreAbi,
      functionName: "recordOf",
      args: [id],
    })) as readonly [Address, ...unknown[]];
    backend = rec[0];
  } catch {
    return; // not even a record: let the original error stand
  }
  const r = await backendRetrieval(publicClient, backend);
  if (r.scheme === "evm") return;
  throw new ChunkUnavailableError({ chunkId: id, backend, scheme: r.scheme, instructions: r.instructions });
}

// ─── Directories ───────────────────────────────────────────────────────────────

export async function entryCount(publicClient: PublicClient, stores: ContentStores, cid: AbxfsCid): Promise<number> {
  const n = (await publicClient.readContract({
    address: stores.directoryStore,
    abi: directoryStoreAbi,
    functionName: "entryCount",
    args: [cid],
  })) as bigint;
  return Number(n);
}

/** Entries in `[start, start + count)`, `count` clamped to {@link PAGE_MAX} and to the directory's length. */
export async function getEntriesPage(
  publicClient: PublicClient,
  stores: ContentStores,
  cid: AbxfsCid,
  start: number,
  count: number,
  total: number,
): Promise<DirectoryEntry[]> {
  if (start >= total || count <= 0) return [];
  const end = Math.min(start + Math.min(count, PAGE_MAX), total);
  const entries = (await publicClient.readContract({
    address: stores.directoryStore,
    abi: directoryStoreBytesAbi,
    functionName: "getEntries",
    args: [cid, BigInt(start), BigInt(end)],
  })) as ReadonlyArray<{ name: Hex; cid: AbxfsCid; isDirectory: boolean }>;
  return entries.map((e) => {
    const nameBytes = nameBytesOf(e.name);
    return { name: decodeEntryName(nameBytes), nameBytes, cid: e.cid, isDirectory: e.isDirectory };
  });
}

/**
 * Every entry of a directory in order (unsigned byte order of name), in pages of {@link PAGE_MAX}. A `total` above
 * `maxEntries` (default {@link DEFAULT_MAX_ENTRIES}) is refused before a single page is planned.
 */
export async function readEntries(
  publicClient: PublicClient,
  stores: ContentStores,
  cid: AbxfsCid,
  total: number,
  opts: { maxEntries?: number } = {},
): Promise<DirectoryEntry[]> {
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!(total <= max)) {
    throw new LimitExceededError("nodes", max, `directory ${cid} (${total} entries)`);
  }
  const pages = await mapInSlices(
    pageRanges(0, total),
    async ([s, e]) => {
      const got = await getEntriesPage(publicClient, stores, cid, s, e - s, total);
      if (got.length !== e - s) throw new Error(`directory ${cid}: asked for entries [${s}, ${e}) and got ${got.length}`);
      return got;
    },
    PAGE_CONCURRENCY,
  );
  return pages.flat();
}

/**
 * Read a directory by CID: every entry, in pages of {@link PAGE_MAX}. `maxEntries` (default {@link DEFAULT_MAX_ENTRIES})
 * refuses a bigger one from its count alone. Each entry carries its name's exact bytes (`nameBytes`) and its lossless
 * text form (`name`).
 */
export async function readDirectory(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  opts: { maxEntries?: number } = {},
): Promise<Directory> {
  const stores = contentStores(addresses);
  const total = await entryCount(publicClient, stores, cid);
  const entries = await readEntries(publicClient, stores, cid, total, opts);
  return { cid, entries };
}

/**
 * Segments one `resolvePath` CALL accepts: `DirectoryStore` reverts `PathTooDeep` past 32. It is a per-call limit, not
 * a limit on content: directories nest to any depth (they are built bottom-up), so {@link resolvePath} chains calls.
 */
export const RESOLVE_PATH_SEGMENTS_PER_CALL = 32;

/** Most segments {@link resolvePath} resolves by default: 8 chained calls. Bounds the work one request can cause. */
export const DEFAULT_MAX_PATH_SEGMENTS = 256;

/**
 * A path that did not resolve for a reason the client decided, not a revert: a segment past the first
 * {@link RESOLVE_PATH_SEGMENTS_PER_CALL} named a FILE and more segments followed (the contract reverts `PathNotFound`
 * for the same thing inside one call), or the path has more segments than the caller's cap. Both mean "not found".
 */
export class PathNotResolvedError extends Error {
  readonly reason: "not-a-directory" | "too-deep";
  constructor(reason: "not-a-directory" | "too-deep", path: string, max?: number) {
    super(
      reason === "too-deep"
        ? `path has ${path.split("/").length} segments, more than the ${max} this reader resolves`
        : `path "${path}" descends into a file`,
    );
    this.name = "PathNotResolvedError";
    this.reason = reason;
  }
}

async function resolvePathOnce(
  publicClient: PublicClient,
  stores: ContentStores,
  rootCid: AbxfsCid,
  path: string,
): Promise<{ cid: AbxfsCid; isDirectory: boolean }> {
  const out = await readDirectoryView(publicClient, stores.directoryStore, "resolvePath", rootCid, path, pathBytes(path));
  return { cid: out[0], isDirectory: out[1] };
}

/**
 * Resolve a POSIX path (e.g. "src/index.html") within a directory tree.
 *
 * A path of at most {@link RESOLVE_PATH_SEGMENTS_PER_CALL} segments is ONE call, passed through unchanged, so the
 * contract decides everything about it. A deeper one is cut into runs of 32 segments, each resolved from the directory
 * the previous run ended at. The cut is on `/`, the same byte the contract splits on, and each run is a substring of
 * the original path, so every rule the contract applies still reverts `PathNotFound` from the contract itself. Two
 * cases are decided here and throw {@link PathNotResolvedError}: a run ending at a FILE with more segments after it,
 * and a path longer than `maxSegments`, refused before any call. Decoding a URL path is the caller's job.
 *
 * Segments are names in their text form (`names.ts`): a name read from chain that is not UTF-8 resolves by the `\xHH`
 * spelling a listing shows for it. Any other spelling is sent as UTF-8, and the contract decides (a backslash never
 * names an entry).
 */
export async function resolvePath(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  rootCid: AbxfsCid,
  path: string,
  opts: { maxSegments?: number } = {},
): Promise<{ cid: AbxfsCid; isDirectory: boolean }> {
  const stores = contentStores(addresses);
  const segments = path.split("/");
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_PATH_SEGMENTS;
  if (segments.length > maxSegments) throw new PathNotResolvedError("too-deep", path, maxSegments);
  if (segments.length <= RESOLVE_PATH_SEGMENTS_PER_CALL) return resolvePathOnce(publicClient, stores, rootCid, path);
  let at: { cid: AbxfsCid; isDirectory: boolean } = { cid: rootCid, isDirectory: true };
  for (let i = 0; i < segments.length; i += RESOLVE_PATH_SEGMENTS_PER_CALL) {
    if (!at.isDirectory) throw new PathNotResolvedError("not-a-directory", path);
    const run = segments.slice(i, i + RESOLVE_PATH_SEGMENTS_PER_CALL).join("/");
    at = await resolvePathOnce(publicClient, stores, at.cid, run);
  }
  return at;
}

/**
 * One entry of a directory by exact name (no `/`): an on-chain binary search, the same cost at any size. `name` is the
 * name's exact bytes, or its text form as a listing gives it (`names.ts`).
 */
export async function lookupEntry(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  dirCid: AbxfsCid,
  name: string | Uint8Array,
): Promise<{ cid: AbxfsCid; isDirectory: boolean }> {
  const bytes = typeof name === "string" ? entryNameBytesLenient(name) : name;
  const text = typeof name === "string" ? name : decodeEntryName(name);
  const out = await readDirectoryView(publicClient, contentStores(addresses).directoryStore, "lookup", dirCid, text, bytes);
  return { cid: out[0], isDirectory: out[1] };
}

/** Read a file by path (root CID + relative path). Convenience wrapper. */
export async function readFileByPath(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  rootCid: AbxfsCid,
  path: string,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  const r = await resolvePath(publicClient, addresses, rootCid, path);
  if (r.isDirectory) throw new Error(`path "${path}" resolves to a directory, not a file`);
  return readFile(publicClient, addresses, r.cid, options);
}

/** A directory tree, flat: every file by path, and every directory that holds nothing. */
export interface WalkedTree {
  files: Array<{ path: string; cid: AbxfsCid }>;
  /** Directories with no entries, by path. The walked root itself is never listed. */
  emptyDirectories: string[];
}

/** Which empty directories one side has that the other does not, sorted. */
export function emptyDirectoryChanges(
  from: readonly string[],
  to: readonly string[],
): { added: string[]; removed: string[] } {
  const a = new Set(from);
  const b = new Set(to);
  return { added: [...b].filter((d) => !a.has(d)).sort(), removed: [...a].filter((d) => !b.has(d)).sort() };
}

/**
 * Walk an entire directory subtree and collect all files (flat).
 *
 * Bounded: each directory is read from chain at most once however many times it is linked (a DAG that shares
 * sub-directories is otherwise exponential to walk as a tree), and the number of directories read plus files emitted
 * is capped by `maxNodes` (default 100,000). Hostile or enormous trees fail with {@link LimitExceededError}.
 * Empty directories are part of a root too: {@link walkDirectoryTree} reports them.
 */
export async function walkDirectory(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  rootCid: AbxfsCid,
  limits: TraversalLimits = {},
): Promise<Array<{ path: string; cid: AbxfsCid }>> {
  const budget = new TraversalBudget(limits);
  return (await walkRec(publicClient, addresses, rootCid, budget, new Map(), undefined, false)).files;
}

/**
 * {@link walkDirectory}, plus the empty directories, so the result folds back into the same root
 * (`planDirectoryTree(files, { emptyDirectories })`). Same bounds, and empty directories count against `maxNodes` like
 * files: a DAG that shares empty directories has as many of them as it has paths to them.
 */
export async function walkDirectoryTree(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  rootCid: AbxfsCid,
  limits: TraversalLimits = {},
): Promise<WalkedTree> {
  const budget = new TraversalBudget(limits);
  return walkRec(publicClient, addresses, rootCid, budget, new Map(), undefined, true);
}

function walkRec(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  budget: TraversalBudget,
  memo: Map<string, Promise<WalkedTree>>,
  ancestors: Ancestry | undefined,
  withEmpty: boolean,
): Promise<WalkedTree> {
  const key = cid.toLowerCase();
  // An honest chain cannot hold a cycle (a directory's cid commits to its children), so a directory that lists one of
  // its own ancestors is a hostile RPC. Without this the memo hands the walk its own unfinished promise.
  let path: Ancestry;
  try {
    path = descend(ancestors, key);
  } catch (err) {
    return Promise.reject(err);
  }
  let pending = memo.get(key);
  if (!pending) {
    budget.node();
    pending = (async () => {
      const dir = await readDirectory(publicClient, addresses, cid, { maxEntries: budget.maxNodes });
      const out: WalkedTree = { files: [], emptyDirectories: [] };
      for (const e of dir.entries) {
        if (e.isDirectory) {
          const child = await walkRec(publicClient, addresses, e.cid, budget, memo, path, withEmpty);
          budget.node();
          if (withEmpty && child.files.length === 0 && child.emptyDirectories.length === 0) {
            budget.node();
            out.emptyDirectories.push(e.name);
            continue;
          }
          for (const f of child.files) {
            budget.node();
            out.files.push({ path: `${e.name}/${f.path}`, cid: f.cid });
          }
          for (const d of child.emptyDirectories) {
            budget.node();
            out.emptyDirectories.push(`${e.name}/${d}`);
          }
        } else {
          budget.node();
          out.files.push({ path: e.name, cid: e.cid });
        }
      }
      return out;
    })();
    memo.set(key, pending);
  }
  return pending;
}

// ─── Pagination helpers ──────────────────────────────────────────────────────

/** Chunk count of a stored file (`FileStore.chunkCount`). */
export async function fileChunkCount(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<number> {
  const n = (await publicClient.readContract({
    address: contentStores(addresses).fileStore,
    abi: fileStoreCallAbi,
    functionName: "chunkCount",
    args: [cid],
  })) as bigint;
  return Number(n);
}

/** Page through a file's chunk ids. A page is clamped to {@link PAGE_MAX}; advance by the length returned. */
export async function getFileChunkIdsPage(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  start: number,
  pageSize: number,
): Promise<AbxfsCid[]> {
  const total = await fileChunkCount(publicClient, addresses, cid);
  return getChunkIdsPage(publicClient, contentStores(addresses), cid, start, pageSize, total);
}

/** Entry count of a stored directory. */
export async function directoryEntryCount(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<number> {
  return entryCount(publicClient, contentStores(addresses), cid);
}

/** Page through directory entries. A page is clamped to {@link PAGE_MAX}; advance by the length returned. */
export async function getDirectoryEntriesPage(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  start: number,
  pageSize: number,
): Promise<DirectoryEntry[]> {
  const stores = contentStores(addresses);
  const total = await entryCount(publicClient, stores, cid);
  return getEntriesPage(publicClient, stores, cid, start, pageSize, total);
}
