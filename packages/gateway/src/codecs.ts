/**
 * File codecs for a gateway running on Node.
 *
 * `createGateway` registers gzip and deflate through the Compression Streams API, which every runtime has. On Node the
 * SDK can add `br` and (where `node:zlib` has it) `zstd` too (`autoRegisterNodeCodecs`); without them a file stored
 * with either is refused with a 501 instead of served.
 *
 * This ADDS what is missing and leaves a codec that is already registered (the platform's streaming gzip and deflate,
 * when `createGateway` ran first) as it was, so the order of the two calls does not matter. Every decoder it adds is
 * CAPPED: whatever a caller asks for, it never inflates past `maxOutputBytes` (zlib stops at the cap; it does not
 * inflate and then measure), so a compression bomb costs the cap, not the bomb. Safe to call anywhere: outside Node it
 * adds nothing.
 */
import {
  CODEC_BROTLI,
  CODEC_DEFLATE,
  CODEC_GZIP,
  CODEC_ZSTD,
  autoRegisterNodeCodecs,
  getFileCodec,
  hasFileCodec,
  registerFileCodec,
  type FileCodecImpl,
} from "@abxfs/sdk";

const LABELS = [CODEC_GZIP, CODEC_DEFLATE, CODEC_BROTLI, CODEC_ZSTD];

/** Register Node's file codecs that are not registered yet, each capped at `maxOutputBytes` of output. Returns the codecs now decodable. */
export async function registerNodeCodecs(options: { maxOutputBytes: number }): Promise<string[]> {
  const cap = options.maxOutputBytes;
  if (!(Number.isSafeInteger(cap) && cap > 0)) throw new Error(`registerNodeCodecs: maxOutputBytes must be a positive integer (got ${cap})`);
  const existing = new Map<string, FileCodecImpl>();
  for (const label of LABELS) if (hasFileCodec(label)) existing.set(label, getFileCodec(label));
  await autoRegisterNodeCodecs();
  const names: string[] = [];
  for (const label of LABELS) {
    const kept = existing.get(label);
    if (kept) {
      registerFileCodec(kept); // put back what was there: autoRegisterNodeCodecs replaces every label it knows
      names.push(kept.name);
      continue;
    }
    if (!hasFileCodec(label)) continue;
    const inner = getFileCodec(label);
    registerFileCodec({
      ...inner,
      decode: (bytes, o) => inner.decode(bytes, { ...o, maxOutputBytes: Math.min(o?.maxOutputBytes ?? cap, cap) }),
    });
    names.push(inner.name);
  }
  return names;
}
