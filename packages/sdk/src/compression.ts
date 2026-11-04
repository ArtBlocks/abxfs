/**
 * File-level codecs (`specs/abx-fs.md` §6).
 *
 * Two different things compress ABX FS content, and they live in different places:
 *
 *   - **Per chunk, on chain:** a storage backend may decode what it stores. `FastLzSstore2Backend` keeps FastLZ input
 *     and inflates it on every read, so the chain itself returns the chunk's data and checks it. The planner chooses
 *     that backend per chunk (`plan.ts`); nothing here is involved.
 *   - **Per file, off chain:** a file may carry a codec label. Its data (the chunks joined) is then
 *     `encode(content)`, and a reader decodes it and checks the result against the file's `outputHash`. The chain
 *     never decodes these. This module is that registry.
 *
 * A label is a `bytes32`: a lowercase ASCII token, left-aligned and zero-padded. Zero means no codec. The convention is
 * the IANA HTTP Content Coding registry (`gzip`, `br`, `zstd`, `deflate`), so a gateway that has checked a file can
 * pass its stored bytes straight through with `Content-Encoding`. A reader refuses a token it does not know.
 *
 * The SDK registers nothing that needs Node by default; {@link autoRegisterNodeCodecs} adds gzip, br, deflate and
 * (where the runtime has it) zstd through `node:zlib`, and `registerWebCodecs` adds gzip and deflate in browsers.
 */
import type { FileCodec, FileCodecImpl } from "./types.js";
import { ZERO_HASH } from "./cid.js";
import { DEFAULT_MAX_INFLATE_BYTES } from "./limits.js";

/** No file codec. */
export const CODEC_NONE: FileCodec = ZERO_HASH;

const TOKEN = /^[a-z0-9][a-z0-9._+-]{0,31}$/;

/** The `bytes32` label for an ASCII token (`"gzip"` → `0x677a6970000…`). Throws on anything but a short lowercase token. */
export function codecLabel(token: string): FileCodec {
  if (!TOKEN.test(token)) throw new Error(`codec token "${token}" must be 1 to 32 lowercase ASCII characters [a-z0-9._+-]`);
  let hex = "0x";
  for (let i = 0; i < 32; i++) hex += (i < token.length ? token.charCodeAt(i) : 0).toString(16).padStart(2, "0");
  return hex as FileCodec;
}

/**
 * The token in a label, or `null` for zero (no codec). Throws on a label that is not a left-aligned, zero-padded
 * lowercase ASCII token: such a label names no codec any reader knows.
 */
export function codecName(label: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(label)) throw new Error(`codec label must be a bytes32, got ${label}`);
  const bytes = label.slice(2).toLowerCase();
  if (/^0+$/.test(bytes)) return null;
  let token = "";
  let ended = false;
  for (let i = 0; i < 64; i += 2) {
    const c = parseInt(bytes.slice(i, i + 2), 16);
    if (c === 0) {
      ended = true;
      continue;
    }
    if (ended) throw new Error(`codec label ${label} is not zero-padded after its token`);
    token += String.fromCharCode(c);
  }
  if (!TOKEN.test(token)) throw new Error(`codec label ${label} does not hold a lowercase ASCII token`);
  return token;
}

export const CODEC_GZIP: FileCodec = codecLabel("gzip");
export const CODEC_BROTLI: FileCodec = codecLabel("br");
export const CODEC_ZSTD: FileCodec = codecLabel("zstd");
/** HTTP's `deflate`: the zlib format (RFC 1950), not raw deflate. */
export const CODEC_DEFLATE: FileCodec = codecLabel("deflate");

const registry = new Map<string, FileCodecImpl>();

/** Register (or replace) the implementation for a label. */
export function registerFileCodec(c: FileCodecImpl): void {
  codecName(c.label);
  registry.set(c.label.toLowerCase(), c);
}

/** The implementation for a label. Throws for zero and for a label nothing registered. */
export function getFileCodec(label: FileCodec): FileCodecImpl {
  const name = codecName(label);
  if (name === null) throw new Error("no file codec: the zero label means none");
  const c = registry.get(label.toLowerCase());
  if (!c) throw new Error(`no decoder registered for file codec "${name}"; this reader cannot decode the file`);
  return c;
}

export function hasFileCodec(label: FileCodec): boolean {
  return registry.has(label.toLowerCase());
}

/** Whether a label is zero (no file codec). */
export function isNoCodec(label: string): boolean {
  return codecName(label) === null;
}

/**
 * Register gzip, br, deflate and (where `node:zlib` has it) zstd from Node. Safe to call anywhere: it does nothing
 * outside Node.
 */
export async function autoRegisterNodeCodecs(): Promise<void> {
  let zlib: typeof import("node:zlib");
  let promisify: typeof import("node:util").promisify;
  try {
    zlib = await import("node:zlib");
    ({ promisify } = await import("node:util"));
  } catch {
    return; // not Node
  }
  const cap = (o?: { maxOutputBytes?: number }) => ({ maxOutputLength: o?.maxOutputBytes ?? DEFAULT_MAX_INFLATE_BYTES });
  const pair = (
    label: FileCodec,
    name: string,
    enc: (b: Uint8Array) => Promise<Buffer>,
    dec: (b: Uint8Array, opts: { maxOutputLength: number }) => Promise<Buffer>,
  ): FileCodecImpl => ({
    label,
    name,
    encode: async (b) => new Uint8Array(await enc(b)),
    decode: async (b, o) => new Uint8Array(await dec(b, cap(o))),
  });
  registerFileCodec(pair(CODEC_GZIP, "gzip", promisify(zlib.gzip), promisify(zlib.gunzip)));
  registerFileCodec(pair(CODEC_BROTLI, "br", promisify(zlib.brotliCompress), promisify(zlib.brotliDecompress)));
  registerFileCodec(pair(CODEC_DEFLATE, "deflate", promisify(zlib.deflate), promisify(zlib.inflate)));
  const z = zlib as unknown as {
    zstdCompress?: (b: Uint8Array, cb: (e: Error | null, r: Buffer) => void) => void;
    zstdDecompress?: (b: Uint8Array, o: object, cb: (e: Error | null, r: Buffer) => void) => void;
  };
  if (typeof z.zstdCompress === "function" && typeof z.zstdDecompress === "function") {
    const zc = z.zstdCompress.bind(zlib);
    const zd = z.zstdDecompress.bind(zlib);
    registerFileCodec(
      pair(
        CODEC_ZSTD,
        "zstd",
        (b) => new Promise((ok, no) => zc(b, (e, r) => (e ? no(e) : ok(r)))),
        (b, o) => new Promise((ok, no) => zd(b, o, (e, r) => (e ? no(e) : ok(r)))),
      ),
    );
  }
}
