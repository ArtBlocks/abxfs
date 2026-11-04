import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AbxfsClient } from "../src/abxfs.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";
import type { FileDescriptor } from "../src/types.js";
import { autoRegisterNodeCodecs, CODEC_GZIP, CODEC_NONE } from "../src/compression.js";
import { EMPTY_DIRECTORY } from "../src/nodes.js";
import { CodecNotSupportedOnChainError } from "../src/verify.js";

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

/** The on-chain `IpfsCidResolver` reads the same stores the SDK writes; the local derivation reads them through the SDK. */
describe("IPFS CID parity (on-chain vs local)", () => {
  it("agrees for a small single-file directory", async () => {
    const fs: FileDescriptor[] = [
      { path: "hello.txt", bytes: new TextEncoder().encode("hello\n"), mimeType: "text/plain" },
    ];
    const { rootCid, files: uploaded } = await client.upload(fs);

    const file = uploaded[0]!;
    const [chain, local] = await Promise.all([
      client.verifyOnChainIpfsCid(file.cid),
      client.verifyLocalIpfsCid(file.cid),
    ]);
    expect(chain).toBe(local);
    expect(chain.startsWith("bafk")).toBe(true);

    // Directory-level parity.
    const [dChain, dLocal] = await Promise.all([
      client.verifyOnChainIpfsCid(rootCid),
      client.verifyLocalIpfsCid(rootCid),
    ]);
    expect(dChain).toBe(dLocal);
    expect(dChain.startsWith("bafy")).toBe(true);
  }, 180_000);

  it("agrees for a nested directory", async () => {
    const fs: FileDescriptor[] = [
      { path: "a.txt", bytes: new TextEncoder().encode("alpha"), mimeType: "text/plain" },
      {
        path: "sub/b.txt",
        bytes: new TextEncoder().encode("beta"),
        mimeType: "text/plain",
      },
    ];
    const { rootCid } = await client.upload(fs);
    const { onChain, local } = await client.assertIpfsCidAgreement(rootCid);
    expect(onChain).toBe(local);
  }, 180_000);

  /** Both come out of the normal algorithm with zero input; the spec pins them (`specs/abx-fs.md` §8). */
  it("agrees on the empty file and the empty directory, and both are the spec's vectors", async () => {
    const up = await client.upload([{ path: ".nojekyll", bytes: new Uint8Array(0), mimeType: "text/plain" }], {
      emptyDirectories: ["empty"],
    });
    const emptyFile = up.files[0]!.cid;
    const fileVector = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const dirVector = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";
    expect(await client.verifyOnChainIpfsCid(emptyFile)).toBe(fileVector);
    expect(await client.verifyLocalIpfsCid(emptyFile)).toBe(fileVector);
    // The empty directory exists without ever being created.
    expect(await client.verifyOnChainIpfsCid(EMPTY_DIRECTORY)).toBe(dirVector);
    expect(await client.verifyLocalIpfsCid(EMPTY_DIRECTORY)).toBe(dirVector);
    await client.assertIpfsCidAgreement(up.rootCid);
  }, 180_000);
});

describe("IPFS CID parity across the 256 KiB block boundary", () => {
  /**
   * Below 256 KiB a file is a single raw block (`bafk…`); above it, a balanced dag-pb DAG with raw
   * leaves (`bafy…`). The multi-block path is where the resolver has to fold leaves and compute
   * cumulative `Tsize` per link — the exact place a subtle divergence between the Solidity and
   * TypeScript implementations would hide, since both agree trivially on the single-block case.
   *
   * On cost: the on-chain path is bounded by the serving node's `eth_call` gas cap, which is a
   * PROVIDER setting rather than a chain one, so the same content resolves on one endpoint and not
   * another. The size below clears the block boundary cheaply.
   */
  it("agrees for a multi-block file, and switches codec at the boundary", async () => {
    const size = 300_000; // > 256 KiB → two blocks
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const up = await client.upload([{ path: "big.bin", bytes, mimeType: "application/octet-stream" }]);

    const fileCid = up.files[0]!.cid;
    const [chain, local] = await Promise.all([
      client.verifyOnChainIpfsCid(fileCid),
      client.verifyLocalIpfsCid(fileCid),
    ]);
    expect(chain).toBe(local);
    // dag-pb root, not a raw block — proof the multi-block path actually ran.
    expect(chain.startsWith("bafybei")).toBe(true);

    // And a single-block file of the same content shape stays raw.
    const small = await client.upload([{ path: "small.bin", bytes: bytes.slice(0, 1000), mimeType: "application/octet-stream" }]);
    expect(await client.verifyOnChainIpfsCid(small.files[0]!.cid)).toMatch(/^bafkrei/);
  }, 300_000);
});

describe("IPFS CID parity for compressed content", () => {
  /**
   * An IPFS CID is computed over a file's CONTENT, re-chunked per the UnixFS profile. It has no relationship to how
   * ABX FS chunked, compressed or where it kept the bytes, so a file stored through FastLZ and one stored raw, holding
   * the same content, MUST produce the same IPFS CID, on chain and locally.
   */
  it("agrees on-chain and locally for per-chunk FastLZ, and matches the raw-stored CID", async () => {
    // Repetitive content so FastLZ actually shrinks it — otherwise the test proves nothing.
    const body = new TextEncoder().encode("abxfs ".repeat(400));
    const descriptor = (): FileDescriptor[] => [{ path: "a.txt", bytes: body, mimeType: "text/plain" }];

    const plain = await client.upload(descriptor(), { fastLz: false });
    const packed = await client.upload(descriptor());

    // Different ABX FS CIDs — chunk ids commit to the backend and the stored input, which differ.
    expect(packed.rootCid).not.toBe(plain.rootCid);
    expect(packed.files[0]!.storedBytesLength).toBeLessThan(body.length);
    expect(packed.files[0]!.codec).toBe(CODEC_NONE);

    const stored = await client.readFile(packed.files[0]!.cid);
    expect(new TextDecoder().decode(stored.bytes)).toBe(new TextDecoder().decode(body));

    // Same IPFS CID, because the content is the same.
    const [plainIpfs, packedLocal, packedChain] = await Promise.all([
      client.verifyLocalIpfsCid(plain.files[0]!.cid),
      client.verifyLocalIpfsCid(packed.files[0]!.cid),
      client.verifyOnChainIpfsCid(packed.files[0]!.cid),
    ]);
    expect(packedLocal).toBe(packedChain);
    expect(packedLocal).toBe(plainIpfs);

    // And at the directory level.
    const [dirLocal, dirChain] = await Promise.all([
      client.verifyLocalIpfsCid(packed.rootCid),
      client.verifyOnChainIpfsCid(packed.rootCid),
    ]);
    expect(dirLocal).toBe(dirChain);

    // The assertion helper is what callers actually use; it must not throw here.
    await client.assertIpfsCidAgreement(packed.rootCid);
  }, 240_000);

  /**
   * The asymmetry worth pinning, because it is the opposite of the intuition that on-chain is the more capable side: a
   * file codec is decoded off chain, and the chain has no decoder for it. So for a gzip file the LOCAL path is the only
   * one that can produce a CID — and it must still produce the right one, identical to the same content with no codec.
   * The resolver refuses with `CodecNotSupported`, which the SDK surfaces as a typed error.
   */
  it("computes locally for a gzip file; the on-chain resolver refuses with CodecNotSupportedOnChainError", async () => {
    const body = new TextEncoder().encode("gzip ".repeat(500));
    const descriptor = (): FileDescriptor[] => [{ path: "g.txt", bytes: body, mimeType: "text/plain" }];

    const plain = await client.upload(descriptor());
    const gz = await client.upload(descriptor(), { codec: CODEC_GZIP });

    const stored = await client.readFile(gz.files[0]!.cid);
    expect(stored.codec).toBe(CODEC_GZIP);
    expect(stored.data.length).toBeLessThan(stored.bytes.length);

    const [gzLocal, plainLocal] = await Promise.all([
      client.verifyLocalIpfsCid(gz.files[0]!.cid),
      client.verifyLocalIpfsCid(plain.files[0]!.cid),
    ]);
    expect(gzLocal).toBe(plainLocal);

    const err = await client.verifyOnChainIpfsCid(gz.files[0]!.cid).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CodecNotSupportedOnChainError);
    expect((err as CodecNotSupportedOnChainError).codec).toBe(CODEC_GZIP);
    // Cached as the same typed error, so a retry does not burn the resolver's gas again.
    await expect(client.verifyOnChainIpfsCid(gz.files[0]!.cid)).rejects.toBeInstanceOf(CodecNotSupportedOnChainError);
    // A directory holding such a file cannot be derived on chain either.
    await expect(client.verifyOnChainIpfsCid(gz.rootCid)).rejects.toBeInstanceOf(CodecNotSupportedOnChainError);
  }, 240_000);
});
