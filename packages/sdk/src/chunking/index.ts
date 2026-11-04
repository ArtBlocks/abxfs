/**
 * Public chunking entry point: every upload-side split goes through `chunkBytes`. It is FastCDC with
 * `defaultParamsFor(backendMax)`, and the boundaries it picks are part of every CID, so they are frozen.
 */

import { defaultParamsFor, fastcdcSplit, type FastCDCParams } from "./fastcdc.js";

export { fastcdcSplit, defaultParamsFor } from "./fastcdc.js";
export type { FastCDCParams } from "./fastcdc.js";
export { GEAR_TABLE } from "./gear-table.js";

export interface ChunkBytesOptions {
  /**
   * The hard ceiling on a single chunk: the planner passes the backends' input cap (`SSTORE2_MAX_INPUT`). FastCDC
   * params are derived from this via `defaultParamsFor(backendMax)`, so it is part of every chunk boundary.
   */
  backendMax: number;
  /**
   * Optional explicit FastCDC params override. When provided, `backendMax` is ignored
   * for parameter derivation but callers must ensure `params.hardMax <= backendMax`.
   * Mainly useful for tests; production callsites should pass only `backendMax`.
   */
  params?: FastCDCParams;
}

/**
 * Chunk a byte buffer into content-addressed pieces, each then planned onto a backend (`plan.ts`) and written through
 * `ChunkStore.write`.
 *
 * Returns subarray views (zero-copy). Boundaries are content-defined via FastCDC, so
 * inserting/deleting bytes near the start of a file only changes the chunk(s) at the
 * edit site — downstream chunks dedup against on-chain storage automatically.
 *
 * Determinism: identical input bytes always produce identical chunks given identical
 * `backendMax` (and gear table). The CID of a file is therefore fully determined by its bytes, `backendMax`, the
 * backends chosen per chunk (their addresses are in every chunk id), its MIME type, and its file codec.
 */
export function chunkBytes(bytes: Uint8Array, opts: ChunkBytesOptions): Uint8Array[] {
  const params = opts.params ?? defaultParamsFor(opts.backendMax);
  return fastcdcSplit(bytes, params);
}
