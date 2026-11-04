/**
 * An in-memory ABX FS deployment, answering the same calls the SDK makes against a real RPC (`readContract` per store,
 * and `simulateContract` for `ChunkStore.multicall`), and counting them.
 *
 * It is a model of what the contracts return, not of how they store it: the tree packing and every id are the SDK's
 * own (so a file's shape and CID are real), and the views are answered from plain maps. What the gateway tests assert
 * is what a request COSTS in calls, which is why every call is recorded.
 */
import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from "viem";
import {
  chunkId,
  chunkStoreAbi,
  directoryStoreAbi,
  fileStoreAbi,
  packDirectory,
  packFile,
  sortDirectoryEntries,
  type AbxfsCid,
  type DirectoryEntry,
} from "@abxfs/sdk";

import { revertError } from "./helpers.js";

export const BACKEND = "0x00000000000000000000000000000000000000b1" as const;
export const FASTLZ = "0x00000000000000000000000000000000000000b2" as const;
export const CHUNKS = "0x00000000000000000000000000000000000000c1" as const;
export const FILE = "0x00000000000000000000000000000000000000d1" as const;
export const DIR = "0x00000000000000000000000000000000000000d2" as const;

const ZERO = `0x${"00".repeat(32)}` as AbxfsCid;
/** `_MAX_PATH_DEPTH` in `DirectoryStore`: segments per `resolvePath` call. */
export const MAX_PATH_DEPTH = 32;

interface FileRec {
  chunkIds: AbxfsCid[];
  mimeType: string;
  rootLevel: number;
  root: Hex;
}

interface ChunkRec {
  data: Uint8Array | undefined;
  size: number;
  dataHash: Hex;
  inputHash: Hex;
}

export interface Call {
  address: string;
  fn: string;
}

export class FakeChain {
  readonly calls: Call[] = [];
  private readonly chunks = new Map<string, ChunkRec>();
  private readonly files = new Map<string, FileRec>();
  private readonly dirs = new Map<string, DirectoryEntry[]>();

  readonly contracts = {
    chunkStore: CHUNKS,
    fileStore: FILE,
    directoryStore: DIR,
    sstore2Backend: BACKEND,
    fastLzBackend: FASTLZ,
  } as never;

  /** Number of calls to `fn` on `address` (any address when omitted) since the last `reset`. */
  count(fn: string, address?: string): number {
    return this.calls.filter((c) => c.fn === fn && (address === undefined || c.address === address)).length;
  }
  reset(): void {
    this.calls.length = 0;
  }

  /** Record chunks under their real ids (raw backend: input = data) and return the ids. */
  private put(chunks: Uint8Array[]): AbxfsCid[] {
    return chunks.map((data) => {
      const h = keccak256(data);
      const id = chunkId(BACKEND, h, h, data.length);
      this.chunks.set(id.toLowerCase(), { data, size: data.length, dataHash: h, inputHash: h });
      return id;
    });
  }

  /** A file. Returns its CID and the packed tree's root level (1 once it holds more than one leaf). */
  addFile(chunks: Uint8Array[], mimeType = "text/plain"): { cid: AbxfsCid; rootLevel: number } {
    const ids = this.put(chunks);
    const { cid, tree } = packFile({ chunkIds: ids, chunkSizes: chunks.map((c) => c.length), mimeType });
    this.files.set(cid, { chunkIds: ids, mimeType, rootLevel: tree.rootLevel, root: tree.root });
    return { cid, rootLevel: tree.rootLevel };
  }

  addDirectory(entries: DirectoryEntry[]): AbxfsCid {
    const sorted = sortDirectoryEntries(entries);
    const { cid } = packDirectory(sorted);
    this.dirs.set(cid, sorted);
    return cid;
  }

  /** Drop a chunk's data while its record and the file that names it stay: a backend that stopped serving. */
  dropChunk(id: string): void {
    const rec = this.chunks.get(id.toLowerCase());
    if (rec) rec.data = undefined;
  }

  /**
   * `resolvePath` as `DirectoryStore` answers it, rule for rule and in the same order: an unknown root reverts
   * `DirectoryNotFound`; an empty path, a leading or trailing `/`, an empty segment, a missing name and descending into
   * a file revert `PathNotFound`; the 33rd segment reverts `PathTooDeep` (`_MAX_PATH_DEPTH = 32`, per CALL), so a deeper
   * path only resolves if the reader chains calls.
   */
  private resolve(root: string, path: string): readonly [AbxfsCid, boolean] {
    if (!this.dirs.has(root)) throw revertError("DirectoryNotFound");
    if (path === "" || path.startsWith("/") || path.endsWith("/")) throw revertError("PathNotFound");
    let cur = root;
    let isDirectory = true;
    let depth = 0;
    for (const seg of path.split("/")) {
      if (seg === "" || !isDirectory) throw revertError("PathNotFound");
      if (++depth > MAX_PATH_DEPTH) throw revertError("PathTooDeep");
      const hit = this.dirs.get(cur)?.find((e) => e.name === seg);
      if (!hit) throw revertError("PathNotFound");
      cur = hit.cid;
      isDirectory = hit.isDirectory;
    }
    return [cur as AbxfsCid, isDirectory];
  }

  readonly client = {
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: readonly unknown[] }) => {
      this.calls.push({ address, fn: functionName });
      const a = address.toLowerCase();
      const cid = String(args?.[0]);
      if (a === FILE) return this.file(functionName, cid, args);
      if (a === DIR) return this.dir(functionName, cid, args);
      if (a === CHUNKS) return this.chunk(functionName, cid);
      throw new Error(`fake chain: no contract at ${address} (${functionName})`);
    },
    // `ChunkStore.multicall(bytes[])` is the only simulated call the readers make.
    simulateContract: async ({ address, args }: { address: string; functionName: string; args: readonly unknown[] }) => {
      const out: Hex[] = [];
      for (const data of args[0] as Hex[]) {
        const { functionName, args: inner } = decodeFunctionData({ abi: chunkStoreAbi, data });
        this.calls.push({ address, fn: `multicall:${functionName}` });
        const result = this.chunk(functionName, String(inner![0]));
        out.push(encodeFunctionResult({ abi: chunkStoreAbi, functionName: functionName as never, result: result as never }));
      }
      return { result: out };
    },
  } as never;

  private chunk(fn: string, id: string): unknown {
    const rec = this.chunks.get(id.toLowerCase());
    if (!rec) throw revertError("ChunkNotFound");
    switch (fn) {
      case "read":
        if (!rec.data) throw revertError("RetrieveFailed");
        return `0x${Buffer.from(rec.data).toString("hex")}` as Hex;
      case "recordOf":
        return [BACKEND, rec.size, ZERO, rec.dataHash, rec.inputHash] as const;
      case "exists":
        return true;
      case "sizeOf":
        return rec.size;
    }
    throw new Error(`fake ChunkStore: unexpected ${fn}`);
  }

  private file(fn: string, cid: string, args: readonly unknown[]): unknown {
    const f = this.files.get(cid);
    switch (fn) {
      case "fileExists":
        return f !== undefined;
      case "chunkCount":
        return BigInt(this.need(f, cid).chunkIds.length);
      case "getFileInfo": {
        const r = this.need(f, cid);
        return {
          root: r.root,
          rootLevel: r.rootLevel,
          chunkCount: BigInt(r.chunkIds.length),
          size: BigInt(this.sizesOf(r.chunkIds).reduce((a, b) => a + b, 0)),
          mimeType: r.mimeType,
          codec: ZERO,
          outputHash: ZERO,
        };
      }
      case "locateByte": {
        const r = this.need(f, cid);
        const offset = Number(args[1]);
        let start = 0;
        const sizes = this.sizesOf(r.chunkIds);
        for (let i = 0; i < sizes.length; i++) {
          if (offset < start + sizes[i]!) return [BigInt(i), BigInt(start), r.chunkIds[i], BigInt(sizes[i]!)];
          start += sizes[i]!;
        }
        throw revertError("OffsetOutOfRange");
      }
      case "getChunkIds": {
        const r = this.need(f, cid);
        return r.chunkIds.slice(Number(args[1]), Number(args[2]));
      }
    }
    throw new Error(`fake FileStore: unexpected ${fn} (${fileStoreAbi.length} abi entries)`);
  }

  private dir(fn: string, cid: string, args: readonly unknown[]): unknown {
    const d = this.dirs.get(cid);
    switch (fn) {
      case "directoryExists":
        return d !== undefined;
      case "entryCount":
        return BigInt(this.need(d, cid).length);
      case "getEntries":
        return this.need(d, cid).slice(Number(args[1]), Number(args[2]));
      case "lookup": {
        const hit = this.need(d, cid).find((e) => e.name === args[1]);
        if (!hit) throw revertError("PathNotFound");
        return [hit.cid, hit.isDirectory] as const;
      }
      case "resolvePath":
        return this.resolve(cid, String(args[1]));
    }
    throw new Error(`fake DirectoryStore: unexpected ${fn} (${directoryStoreAbi.length} abi entries)`);
  }

  private sizesOf(ids: readonly string[]): number[] {
    return ids.map((id) => this.chunks.get(id.toLowerCase())!.size);
  }

  private need<T>(v: T | undefined, cid: string): T {
    if (v === undefined) throw revertError(`NotFound ${cid}`);
    return v;
  }
}

/** Deterministic bytes: chunk `i` of `size` bytes, so a slice is checkable without storing the file twice. */
export function chunkBytes(i: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let k = 0; k < size; k++) out[k] = (i * 31 + k * 7) & 0xff;
  return out;
}
