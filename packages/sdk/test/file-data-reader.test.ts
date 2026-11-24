/**
 * `FileDataReader` through the SDK: the data a contract gets for a file of any codec, read in one `eth_call` against
 * the companion deployed over the content layer (the anvil harness deploys it with the IPFS resolver), and the content
 * recovered from it by the same decode-and-check `readFile` uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";

import { AbxfsClient } from "../src/abxfs.js";
import { autoRegisterNodeCodecs, CODEC_GZIP, CODEC_NONE } from "../src/compression.js";
import { ZERO_HASH, keccak256Hex } from "../src/cid.js";
import { abxfsContractAddresses } from "../src/org.js";
import { PresentationCapabilityError, readNativeFileData } from "../src/presentation.js";
import { decodeFileData, OutputHashMismatchError, readFile } from "../src/read.js";
import { asAbxfsCid, type FileDescriptor } from "../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";

let harness: AnvilHarness;
let client: AbxfsClient;

beforeAll(async () => {
  await autoRegisterNodeCodecs();
  harness = await startAnvilWithAbxfs({ deployCompanion: true });
  client = new AbxfsClient({
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    addresses: harness.addresses,
  });
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

/** About 70 KB of script-like text: several chunks raw, and gzip shrinks it to a few. */
function library(): Uint8Array {
  let s = "";
  for (let i = 0; s.length < 70_000; i++) s += `function f${i}(x){return x*${i}+${(i * 7919) % 1000};}\n`;
  return new TextEncoder().encode(s);
}

const LIMITS = { maxBytes: 1n << 20n, maxChunks: 64n };

describe("readNativeFileData", () => {
  it("returns a gzip file's stored data, labelled, as readFile reads it; decodeFileData recovers the content", async () => {
    const body = library();
    const files: FileDescriptor[] = [{ path: "libs/lib.min.js", bytes: body, mimeType: "text/javascript" }];
    const { rootCid, files: uploaded } = await client.upload(files, { codec: CODEC_GZIP });
    const cid = uploaded[0]!.cid;

    const native = await client.readNativeFileData(cid, LIMITS);
    const sdk = await readFile(harness.publicClient, harness.addresses, cid);
    expect(native.mimeType).toBe("text/javascript");
    expect(native.codec).toBe(CODEC_GZIP);
    expect(native.outputHash).toBe(keccak256Hex(body));
    expect(native.data).toEqual(sdk.data);
    expect(native.data.length).toBeLessThan(body.length);
    expect(await decodeFileData({ cid, ...native })).toEqual(body);

    const byPath = await client.readNativePathData(rootCid, "libs/lib.min.js", LIMITS);
    expect(byPath).toEqual(native);

    // Ranges of the data, joined in order, are the data: how a caller pages a file under a per-call gas budget.
    const page = 10_000n;
    const parts: Uint8Array[] = [];
    for (let start = 0n; start < BigInt(native.data.length); start += page) {
      const left = BigInt(native.data.length) - start;
      const range = await client.readNativeFileDataRange(cid, start, left < page ? left : page, LIMITS);
      expect(range.codec).toBe(CODEC_GZIP);
      parts.push(range.data);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(native.data));
  }, 240_000);

  it("returns a file without a codec as its content", async () => {
    const body = new TextEncoder().encode("plain bytes, no codec\n");
    const { files: uploaded } = await client.upload([{ path: "a.txt", bytes: body, mimeType: "text/plain" }]);
    const native = await client.readNativeFileData(uploaded[0]!.cid, LIMITS);
    expect(native.codec).toBe(CODEC_NONE);
    expect(native.outputHash).toBe(ZERO_HASH);
    expect(native.data).toEqual(body);
    expect(await decodeFileData({ cid: uploaded[0]!.cid, ...native })).toEqual(body);
  }, 240_000);

  it("refuses a chain whose address book has no fileDataReader, naming the capability", async () => {
    const { fileDataReader: _drop, ...without } = harness.addresses;
    void _drop;
    const err = await readNativeFileData(harness.publicClient, without, asAbxfsCid(`0x${"11".repeat(32)}`), LIMITS).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PresentationCapabilityError);
    expect((err as PresentationCapabilityError).capability).toBe("fileDataReader");
  });

  it("counts the reader among the ABX FS contracts no project or role may be sent to", () => {
    expect(abxfsContractAddresses(harness.addresses)).toContain(harness.addresses.fileDataReader as Address);
  });
});

describe("decodeFileData", () => {
  it("refuses data whose decoded content does not hash to outputHash", async () => {
    const body = library();
    const { files: uploaded } = await client.upload([{ path: "b.js", bytes: body, mimeType: "text/javascript" }], {
      codec: CODEC_GZIP,
    });
    const native = await client.readNativeFileData(uploaded[0]!.cid, LIMITS);
    const forged = { cid: uploaded[0]!.cid, ...native, outputHash: keccak256Hex(new Uint8Array([1])) };
    await expect(decodeFileData(forged)).rejects.toBeInstanceOf(OutputHashMismatchError);
  }, 240_000);
});
