/**
 * An independent CARv1 reader for tests: written from the spec, sharing nothing with `src/car.ts`. It decodes the
 * header with a small generic CBOR decoder, re-hashes every block against its CID, and checks the DAG is complete
 * (every dag-pb link points at a block in the archive), which is what an importing node needs to pin the root.
 */
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

export interface ReadCar {
  roots: string[];
  version: number;
  blocks: Map<string, Uint8Array>;
  /** Block CIDs in archive order. */
  order: string[];
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (let i = at; i < b.length; i++) {
    v += (b[i]! & 0x7f) * mul;
    if ((b[i]! & 0x80) === 0) return [v, i + 1];
    mul *= 0x80;
  }
  throw new Error("truncated varint");
}

/** Generic CBOR (majors 0, 2, 3, 4, 5 and tag 42), enough for any CAR header. */
function cbor(b: Uint8Array, at: number): [unknown, number] {
  const head = b[at]!;
  const major = head >> 5;
  const info = head & 0x1f;
  let n: number;
  let p = at + 1;
  if (info < 24) n = info;
  else if (info === 24) n = b[p++]!;
  else if (info === 25) {
    n = (b[p]! << 8) | b[p + 1]!;
    p += 2;
  } else throw new Error(`cbor: unsupported argument ${info}`);
  switch (major) {
    case 0:
      return [n, p];
    case 2:
      return [b.subarray(p, p + n), p + n];
    case 3:
      return [new TextDecoder().decode(b.subarray(p, p + n)), p + n];
    case 4: {
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const [v, q] = cbor(b, p);
        out.push(v);
        p = q;
      }
      return [out, p];
    }
    case 5: {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const [k, q] = cbor(b, p);
        const [v, r] = cbor(b, q);
        out[k as string] = v;
        p = r;
      }
      return [out, p];
    }
    case 6: {
      if (n !== 42) throw new Error(`cbor: unexpected tag ${n}`);
      const [v, q] = cbor(b, p);
      const bytes = v as Uint8Array;
      if (bytes[0] !== 0) throw new Error("dag-cbor CID without the 0x00 prefix");
      return [CID.decode(bytes.subarray(1)), q];
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

export async function readCar(bytes: Uint8Array): Promise<ReadCar> {
  const [hlen, hstart] = readVarint(bytes, 0);
  const [header, hend] = cbor(bytes, hstart);
  if (hend !== hstart + hlen) throw new Error("header length mismatch");
  const h = header as { roots: CID[]; version: number };
  const blocks = new Map<string, Uint8Array>();
  const order: string[] = [];
  let p = hend;
  while (p < bytes.length) {
    const [len, start] = readVarint(bytes, p);
    const section = bytes.subarray(start, start + len);
    const [cid, rest] = CID.decodeFirst(section);
    if (cid.version !== 1 || cid.multihash.code !== sha256.code) throw new Error(`unexpected CID ${cid}`);
    if (cid.code !== raw.code && cid.code !== dagPB.code) throw new Error(`unexpected codec in ${cid}`);
    const digest = await sha256.digest(rest);
    if (!equal(digest.digest, cid.multihash.digest)) throw new Error(`block ${cid} does not hash to its CID`);
    if (blocks.has(cid.toString())) throw new Error(`block ${cid} appears twice`);
    blocks.set(cid.toString(), rest);
    order.push(cid.toString());
    p = start + len;
  }
  return { roots: h.roots.map(String), version: h.version, blocks, order };
}

/** Every block reachable from `root`, throwing if any link points outside the archive. */
export function reachable(car: ReadCar, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    const block = car.blocks.get(c);
    if (!block) throw new Error(`block ${c} is linked but missing from the CAR`);
    seen.add(c);
    if (CID.parse(c).code === dagPB.code) {
      for (const link of dagPB.decode(block).Links) stack.push(link.Hash.toString());
    }
  }
  return seen;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
