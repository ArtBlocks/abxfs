/**
 * Directory entry names, without loss.
 *
 * A name on chain is BYTES: `DirectoryStore` accepts any 1 to 255 bytes that are not `.` or `..` and hold no `/` or
 * `\` (`specs/abx-fs.md` §5). It does not ask for UTF-8. The ABI types a name `string`, and decoding that the usual way
 * (`TextDecoder` with its defaults, which is what viem does) is lossy twice over: a leading U+FEFF is dropped as a byte
 * order mark, and every invalid sequence becomes U+FFFD, so `0xfe` and `0xff` read as the same name. Anything that
 * writes or derives from such a string gets another name, another directory CID and another IPFS CID, and can lose an
 * entry outright when two names collapse into one.
 *
 * So the SDK reads names as bytes and keeps one TEXT FORM of a name that maps back to exactly those bytes:
 *
 *   - well-formed UTF-8 is the decoded text, a leading U+FEFF included (`fatal`, `ignoreBOM`);
 *   - every byte that is not part of a well-formed sequence is written `\xHH` (two lowercase hex digits).
 *
 * A name can never hold a `\` (0x5c), so a backslash in the text form always begins an escape and the form is
 * unambiguous: {@link encodeEntryName} inverts {@link decodeEntryName} exactly, and refuses any other spelling (a
 * backslash that is not a canonical escape, or an escape for a byte that would decode as text). The text form is what
 * paths, drafts and listings carry; the bytes are what packing, CIDs, lookups and IPFS derivation use.
 *
 * Names a person types or a file system supplies are literal text: they are UTF-8 encoded as they are and may not hold
 * a backslash at all ({@link assertLiteralPath}). Only names read from chain carry escapes.
 *
 * A JavaScript string can hold a lone UTF-16 surrogate, which UTF-8 cannot encode: `TextEncoder` writes U+FFFD in its
 * place, so `"\uD800"` and `"\uFFFD"` would be two spellings of the same bytes. Text that is not well formed
 * ({@link isWellFormedText}) is therefore no name's spelling: {@link encodeEntryName} refuses it, and for a read it names
 * no entry ({@link entryNameBytesLenient}).
 */

const utf8 = new TextEncoder();
/** Strict, and keeps a leading U+FEFF: the default decoder strips it as a byte order mark. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const BACKSLASH = 0x5c;
const HEX = "0123456789abcdef";
/** A lone surrogate: in a `u` regex a well-formed pair is one code point, so only an unpaired half matches. */
const LONE_SURROGATE = /\p{Cs}/u;
const LONE_SURROGATES = /\p{Cs}/gu;

/**
 * True when `text` holds no lone UTF-16 surrogate, so UTF-8 encodes it exactly (`String.prototype.isWellFormed`, which
 * not every runtime the SDK supports has).
 */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/** Length of the well-formed UTF-8 sequence starting at `b[i]` (Unicode table 3-7), or 0 if none starts there. */
function sequenceLength(b: Uint8Array, i: number): number {
  const c = b[i]!;
  if (c < 0x80) return 1;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => i + k < b.length && b[i + k]! >= lo && b[i + k]! <= hi;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

/** True when `bytes` is well-formed UTF-8, so its text form holds no escape. */
export function isUtf8Name(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text form of a name's bytes: the UTF-8 text, with each byte that is not part of a well-formed sequence written
 * `\xHH`. Lossless: {@link encodeEntryName} gives the same bytes back. Display it as it is; it is also the spelling every
 * SDK path, draft and listing uses for this name.
 */
export function decodeEntryName(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    // Not UTF-8: decode the well-formed runs and escape the bytes between them.
  }
  let out = "";
  let run = 0;
  let i = 0;
  const flush = (end: number) => {
    if (end > run) out += strictUtf8.decode(bytes.subarray(run, end));
  };
  while (i < bytes.length) {
    const n = sequenceLength(bytes, i);
    if (n > 0) {
      i += n;
      continue;
    }
    flush(i);
    const c = bytes[i]!;
    out += `\\x${HEX[c >> 4]}${HEX[c & 15]}`;
    i += 1;
    run = i;
  }
  flush(i);
  return out;
}

/** A name's text form is not the canonical spelling of any name (see {@link encodeEntryName}). */
export class EntryNameSpellingError extends Error {
  override readonly name = "EntryNameSpellingError";
  constructor(readonly text: string) {
    super(
      isWellFormedText(text)
        ? `entry name "${text.slice(0, 40)}" contains a backslash that is not a canonical byte escape. Names cannot contain "\\"; ` +
            "a name read from chain that is not UTF-8 is written with \\xHH escapes for its invalid bytes, and only that exact spelling is accepted."
        : `entry name "${text.replace(LONE_SURROGATES, "\uFFFD").slice(0, 40)}" holds a lone UTF-16 surrogate, which UTF-8 cannot encode; ` +
            "it is not the spelling of any name.",
    );
  }
}

/**
 * The bytes a name's text form stands for: the inverse of {@link decodeEntryName}. Text without a backslash is plain
 * UTF-8. A backslash must begin `\xHH` (lowercase hex) for a byte that is not part of a well-formed UTF-8 sequence
 * there, exactly as {@link decodeEntryName} would write it; anything else, and text holding a lone surrogate, throws
 * {@link EntryNameSpellingError}, so a name has one spelling and two spellings never reach the same bytes.
 */
export function encodeEntryName(text: string): Uint8Array {
  if (!isWellFormedText(text)) throw new EntryNameSpellingError(text);
  if (!text.includes("\\")) return utf8.encode(text);
  const parts: number[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("\\", i);
    const end = at < 0 ? text.length : at;
    if (end > i) for (const b of utf8.encode(text.slice(i, end))) parts.push(b);
    if (at < 0) break;
    const hi = HEX.indexOf(text[at + 2] ?? "");
    const lo = HEX.indexOf(text[at + 3] ?? "");
    if (text[at + 1] !== "x" || hi < 0 || lo < 0) throw new EntryNameSpellingError(text);
    parts.push(hi * 16 + lo);
    i = at + 4;
  }
  const bytes = Uint8Array.from(parts);
  if (bytes.includes(BACKSLASH) || decodeEntryName(bytes) !== text) throw new EntryNameSpellingError(text);
  return bytes;
}

/**
 * The bytes for `text` when it is a canonical text form, else its plain UTF-8. For READS (`lookup`, `resolvePath`),
 * where the contract decides: a spelling that names no entry still reverts there, as it did before escapes existed.
 * A lone surrogate is sent as a backslash, the one byte no name holds, so text that is not well formed names no entry
 * (rather than the entry its U+FFFD replacement would name).
 */
export function entryNameBytesLenient(text: string): Uint8Array {
  try {
    return encodeEntryName(text);
  } catch {
    return utf8.encode(text.replace(LONE_SURROGATES, "\\"));
  }
}

/** An entry's name as bytes: the raw bytes when it was read from chain, else its text form encoded. */
export function entryNameBytes(entry: { name: string; nameBytes?: Uint8Array }): Uint8Array {
  return entry.nameBytes ?? encodeEntryName(entry.name);
}

/**
 * Refuse a path a person or a file system supplied that holds a backslash. Such a name is literal text, and `\` is
 * the one character no name may contain; it is refused here, by name, instead of being read as an escape.
 */
export function assertLiteralPath(path: string): void {
  if (path.includes("\\")) {
    throw new Error(`"${path.slice(0, 80)}": names cannot contain a backslash ("\\"). Rename it before uploading.`);
  }
  if (!isWellFormedText(path)) {
    throw new Error(
      `"${path.replace(LONE_SURROGATES, "\uFFFD").slice(0, 80)}": the name holds a lone UTF-16 surrogate, which UTF-8 cannot ` +
        "encode. Rename it before uploading.",
    );
  }
}
