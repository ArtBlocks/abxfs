/**
 * The upload options that decide CIDs: the file codec and per-chunk FastLZ.
 *
 * Both are part of every CID an upload produces (the codec through the file CID, FastLZ through each chunk's
 * backend), so `upload`, `update` and `diff` resolve them here, from the same flags and the same config keys. A diff
 * that resolved them differently would recompute every CID and report unchanged files as changed.
 */
import { CODEC_NONE, codecLabel, type FileCodec } from "@artblocks/abxfs-sdk";

import type { ChainConfig } from "./config.js";

/**
 * The file codecs the CLI offers. The protocol takes any IANA content-coding token, but a file is only useful if its
 * readers can decode it, and gzip is the one every reader here decodes natively: browsers and the gateway through the
 * Compression Streams API, Node through `node:zlib`.
 */
const CODECS = ["none", "gzip"] as const;

/**
 * Map a `--codec` name to its `bytes32` label.
 *
 * `fastlz` is refused with a pointer to what replaced it: FastLZ is no longer a file codec but a storage backend,
 * chosen per chunk wherever it shrinks the chunk, and the chain inflates it itself.
 */
export function codecFromName(name: string): FileCodec {
  const n = name.toLowerCase();
  if (n === "fastlz") {
    throw new Error(
      'fastlz is not a file codec: chunks already go through the FastLZ backend wherever it shrinks them, and the ' +
        "chain inflates them itself. Leave --codec unset (or pass --no-fastlz to store chunks raw).",
    );
  }
  if (n === "none") return CODEC_NONE;
  if ((CODECS as readonly string[]).includes(n)) return codecLabel(n);
  throw new Error(`unknown file codec "${name}" (expected ${CODECS.join("|")})`);
}

/**
 * The help text of `--fastlz`, the positive twin of `--no-fastlz`. It exists for the default it gives the pair: a
 * lone `--no-fastlz` makes commander default `fastlz` to TRUE, so the chain's `fastLz: false` was never consulted;
 * with both declared, an unset flag is `undefined` and {@link resolveContentOptions} falls through to the config.
 */
export const FASTLZ_HELP = "store chunks through the FastLZ backend where it shrinks them (the default; overrides a chain's fastLz: false)";

/** The codec and FastLZ choice for one command: the flags when given, else the chain's config, else none + FastLZ on. */
export function resolveContentOptions(
  chain: ChainConfig,
  flags: { codec?: string | undefined; fastlz?: boolean | undefined },
): { codec: FileCodec; fastLz: boolean } {
  const name = flags.codec ?? chain.defaultCodec;
  return {
    codec: name === undefined ? CODEC_NONE : codecFromName(name),
    fastLz: flags.fastlz ?? chain.fastLz ?? true,
  };
}
