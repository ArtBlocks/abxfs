import type { Hex } from "viem";

/** Concatenate any number of Uint8Arrays into a new one. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Convert a Uint8Array into a 0x-prefixed lowercase hex string. */
export function toHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

/** Parse a 0x-prefixed hex string into a Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Chunk an array into groups of `size`. */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Infer a MIME type from a file path. Conservative mapping, extensible by caller. */
export function inferMimeType(path: string, fallback = "application/octet-stream"): string {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return fallback;
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    wasm: "application/wasm",
    pdf: "application/pdf",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
    gz: "application/gzip",
    br: "application/brotli",
  };
  return map[ext] ?? fallback;
}

/** Assert (`path` is POSIX-style with no `..`, no absolute, no empty components). */
export function validateRelativePath(path: string): void {
  if (!path) throw new Error("path is empty");
  if (path.startsWith("/")) throw new Error(`path must be relative: ${path}`);
  const parts = path.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") {
      throw new Error(`invalid path component "${p}" in ${path}`);
    }
  }
}

/**
 * How many reads one burst may issue. The browser's RPC transport batches concurrent calls into one
 * request and an RPC proxy may cap a batch, so an unbounded `Promise.all` over a few hundred
 * probes fails as a whole. Slices keep every burst well under any such cap.
 */
export const PROBE_SLICE = 50;

/**
 * `Promise.all(items.map(fn))` in sequential slices of at most `size` (default {@link PROBE_SLICE}):
 * order is preserved and no more than `size` calls are ever in flight at once.
 */
export async function mapInSlices<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  size: number = PROBE_SLICE,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    out.push(...(await Promise.all(slice.map((item, j) => fn(item, i + j)))));
  }
  return out;
}
