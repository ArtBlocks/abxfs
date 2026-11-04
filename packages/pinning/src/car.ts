/**
 * A minimal CARv1 writer (https://ipld.io/specs/transport/car/carv1/): a varint-prefixed dag-cbor header
 * `{ roots: [root], version: 1 }`, then one varint-prefixed `cid ‖ block` section per block.
 *
 * Only what pinning needs: one root, blocks already hashed by the caller. Nothing here re-encodes or re-hashes a block,
 * so the archive carries exactly the DAG the caller derived.
 */
import type { IpfsBlock } from "@abxfs/sdk";

/** The media type of a CAR (CARv1 and CARv2 alike). */
export const CAR_MEDIA_TYPE = "application/vnd.ipld.car";

/** Unsigned LEB128, as CAR uses for its length prefixes. */
function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return new Uint8Array(out);
}

/** A CBOR head (major type and argument) for arguments below 2^16, which is all a one-root header needs. */
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error(`cbor argument ${n} out of range`);
}

function cborText(s: string): Uint8Array[] {
  const b = new TextEncoder().encode(s);
  return [cborHead(3, b.length), b];
}

/**
 * The dag-cbor header `{ roots: [root], version: 1 }`. Map keys sort by length then bytes ("roots" before
 * "version"); a CID is tag 42 over a byte string of `0x00 ‖ cid`.
 */
export function carHeader(rootCidBytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    cborHead(5, 2),
    ...cborText("roots"),
    cborHead(4, 1),
    new Uint8Array([0xd8, 0x2a]),
    cborHead(2, rootCidBytes.length + 1),
    new Uint8Array([0x00]),
    rootCidBytes,
    ...cborText("version"),
    cborHead(0, 1),
  ];
  const body = concat(parts);
  return concat([varint(body.length), body]);
}

/**
 * A CARv1 with one root and `blocks` in the order given (the caller dedupes). Returned as parts so a large archive is
 * not copied into one buffer; wrap them in a `Blob` to upload.
 */
export function encodeCar(rootCidBytes: Uint8Array, blocks: Iterable<IpfsBlock>): Uint8Array[] {
  const parts: Uint8Array[] = [carHeader(rootCidBytes)];
  for (const b of blocks) {
    parts.push(varint(b.cidBytes.length + b.bytes.length), b.cidBytes, b.bytes);
  }
  return parts;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
