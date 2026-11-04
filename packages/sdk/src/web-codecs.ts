/**
 * gzip and deflate file codecs via the Compression Streams API — no Node, no bundler shims.
 *
 * `autoRegisterNodeCodecs` reaches for `node:zlib`, so it does nothing in a browser. `CompressionStream` /
 * `DecompressionStream` are native in every current browser *and* in Node 18+, so this one implementation covers both
 * and is the right registration for anything that renders content: the web gateway, and the client previewing a file.
 *
 * Same labels and wire formats as the Node registration: a file written by the CLI with `node:zlib` decodes here and
 * vice versa. Registering both is harmless; the last registration wins and either works.
 *
 * File codecs are off chain by definition: the chain never decodes them, so `IpfsCidResolver` cannot derive a file that
 * has one. On-chain compression is the FastLZ storage backend's job, per chunk, and is the SDK default.
 */
import { CODEC_DEFLATE, CODEC_GZIP, registerFileCodec } from "./compression.js";
import { DEFAULT_MAX_INFLATE_BYTES } from "./limits.js";

/** Whether the Compression Streams API is available in this runtime. */
export function hasWebCompression(): boolean {
  return (
    typeof globalThis.CompressionStream === "function" &&
    typeof globalThis.DecompressionStream === "function"
  );
}

async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maxOutputBytes?: number,
): Promise<Uint8Array> {
  // The source is built directly rather than via `new Blob([bytes]).stream()`. Blob is not
  // uniformly implemented — jsdom ships one without `.stream()`, so the Blob route threw in a test
  // environment while working fine in a real browser. A ReadableStream is available wherever
  // CompressionStream is, by definition.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const piped = source.pipeThrough(
    stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );

  const reader = piped.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (maxOutputBytes !== undefined && total > maxOutputBytes) {
      // Streaming on purpose: stop reading the moment the cap is crossed, so a gzip bomb is never
      // materialised. Cancelling the reader tears the pipe down.
      await reader.cancel().catch(() => undefined);
      throw new Error(`decode: output exceeds ${maxOutputBytes} bytes; refusing to inflate`);
    }
    parts.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Register the `gzip` and `deflate` file codecs using the platform's own streams (HTTP's `deflate` is the zlib format,
 * which is what `CompressionStream("deflate")` produces).
 *
 * Idempotent and safe to call unconditionally — it no-ops where the API is missing rather than
 * throwing, so a caller does not have to feature-detect before calling.
 */
export function registerWebCodecs(): void {
  if (!hasWebCompression()) return;

  for (const [label, name] of [
    [CODEC_GZIP, "gzip"],
    [CODEC_DEFLATE, "deflate"],
  ] as const) {
    registerFileCodec({
      label,
      name,
      encode: (b) => pipe(b, new CompressionStream(name)),
      decode: (b, o) => pipe(b, new DecompressionStream(name), o?.maxOutputBytes ?? DEFAULT_MAX_INFLATE_BYTES),
    });
  }
}
