/**
 * Integration: upload trees to Anvil with the SDK, pin them through a provider that imports the CAR the way a node
 * would (re-hash every block, require every link to resolve), and check the pinned root against the SDK's own local
 * derivation and, where it can derive one, the on-chain resolver. Covers the trees a file-by-file upload could not
 * express: empty directories, an empty file, files stored with a codec, and a file root.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AbxfsClient,
  CODEC_GZIP,
  CodecNotSupportedOnChainError,
  DirectoryNeedsShardingError,
  autoRegisterNodeCodecs,
  ipfsFileCid,
  type IpfsCid,
} from "@abxfs/sdk";
import { startAnvilWithAbxfs, type AnvilHarness } from "../../sdk/test/helpers/anvil.js";

import { pinDirectory, pinRoot } from "../src/pin.js";
import type { PinningProvider } from "../src/types.js";
import { reachable, readCar, type ReadCar } from "./helpers/car-reader.js";

function anvilInstalled(): boolean {
  try {
    return spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const SHOULD_SKIP = !anvilInstalled();
if (SHOULD_SKIP) console.warn("pinning integration skipped: anvil not on PATH");

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** A provider that imports like a node: it refuses a CAR with a bad block or a missing one, then "pins" the root. */
function importingProvider(reply?: IpfsCid): { provider: PinningProvider; imported: ReadCar[] } {
  const imported: ReadCar[] = [];
  const provider: PinningProvider = {
    name: "mock",
    async pinCar({ root, car }) {
      const read = await readCar(new Uint8Array(await car.arrayBuffer()));
      expect(read.roots).toEqual([root]);
      expect(reachable(read, root)).toEqual(new Set(read.order));
      imported.push(read);
      return { pinnedCid: reply ?? root };
    },
    async unpin() {},
    async isPinned() {
      return true;
    },
  };
  return { provider, imported };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(SHOULD_SKIP)("pinning on chain", () => {
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
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("pins empty directories, an empty file and a multi-leaf file under the root the chain derives", async () => {
    const big = noise(300 * 1024, 7);
    const upload = await client.upload(
      [
        { path: "index.html", bytes: enc("<h1>hi</h1>"), mimeType: "text/html" },
        { path: "empty.txt", bytes: new Uint8Array(0), mimeType: "text/plain" },
        { path: "assets/big.bin", bytes: big, mimeType: "application/octet-stream" },
      ],
      { emptyDirectories: ["empty", "assets/nested/also-empty"] },
    );

    const { provider, imported } = importingProvider();
    const result = await pinDirectory({ client, directoryCid: upload.rootCid, provider });

    expect(result.verified).toBe(true);
    expect(result.expectedCid).toBe(await client.verifyLocalIpfsCid(upload.rootCid));
    expect(result.expectedCid).toBe(await client.verifyOnChainIpfsCid(upload.rootCid));
    const car = imported[0]!;
    expect(car.blocks.has("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354")).toBe(true); // the empty dir
    expect(car.blocks.has("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toBe(true); // the empty file
    expect(result.files.map((f) => f.path).sort()).toEqual(["assets/big.bin", "empty.txt", "index.html"]);
  }, 180_000);

  it("pins files stored with a gzip codec as their decoded content", async () => {
    const page = enc("<!doctype html>" + "<p>compressible</p>".repeat(500));
    const upload = await client.upload(
      [
        { path: "index.html", bytes: page, mimeType: "text/html" },
        { path: "js/app.js", bytes: enc("console.log(1);\n".repeat(200)), mimeType: "text/javascript" },
      ],
      { codec: CODEC_GZIP, emptyDirectories: ["fonts"] },
    );
    expect(upload.files.every((f) => f.codec === CODEC_GZIP)).toBe(true);

    const { provider, imported } = importingProvider();
    const result = await pinDirectory({ client, directoryCid: upload.rootCid, provider });

    // The on-chain resolver refuses codec files, so the SDK's local derivation is the reference.
    expect(result.expectedCid).toBe(await client.verifyLocalIpfsCid(upload.rootCid));
    expect(imported[0]!.blocks.has(await ipfsFileCid(page))).toBe(true); // the content, not the gzip bytes
  }, 180_000);

  it("pins a file root, probing its kind", async () => {
    const bytes = noise(270 * 1024, 11);
    const upload = await client.upload([{ path: "solo.bin", bytes, mimeType: "application/octet-stream" }]);
    const fileCid = upload.files[0]!.cid;

    const { provider, imported } = importingProvider();
    const result = await pinRoot({ client, root: fileCid, provider });

    expect(result.kind).toBe("file");
    expect(result.expectedCid).toBe(await ipfsFileCid(bytes));
    expect(result.expectedCid).toBe(await client.verifyOnChainIpfsCid(fileCid));
    expect(imported[0]!.order.length).toBe(3); // a dag-pb file node over two raw leaves
  }, 180_000);

  it("refuses before uploading when the on-chain resolver disagrees with the derived root", async () => {
    const upload = await client.upload([{ path: "a.txt", bytes: enc("resolver check"), mimeType: "text/plain" }]);
    const { provider, imported } = importingProvider();
    const lying = Object.create(client) as AbxfsClient;
    lying.verifyOnChainIpfsCid = async () => "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as IpfsCid;
    await expect(pinDirectory({ client: lying, directoryCid: upload.rootCid, provider })).rejects.toThrow(/nothing was pinned/);
    expect(imported).toHaveLength(0);
  });

  it("the on-chain resolver's refusals: a codec or a node declining leaves the local derivation, a sharding refusal stands", async () => {
    const upload = await client.upload([{ path: "r.txt", bytes: enc("resolver refusals"), mimeType: "text/plain" }]);
    const root = upload.rootCid;
    const asking = (fail: Error) => {
      const c = Object.create(client) as AbxfsClient;
      c.verifyOnChainIpfsCid = async () => {
        throw fail;
      };
      return c;
    };
    for (const fail of [new CodecNotSupportedOnChainError(root, `0x${"67".repeat(4)}${"00".repeat(28)}`), new Error("eth_call exceeds the node's gas cap")]) {
      const { provider, imported } = importingProvider();
      const result = await pinDirectory({ client: asking(fail), directoryCid: root, provider });
      expect(result.verified).toBe(true);
      expect(imported).toHaveLength(1);
    }
    const { provider, imported } = importingProvider();
    await expect(pinDirectory({ client: asking(new DirectoryNeedsShardingError(root, 300_000)), directoryCid: root, provider })).rejects.toThrow(
      DirectoryNeedsShardingError,
    );
    expect(imported).toHaveLength(0);

    // No resolver configured: it is never asked, and the local derivation is the answer.
    const noResolver = Object.create(client) as AbxfsClient;
    Object.defineProperty(noResolver, "addresses", { value: { ...client.addresses, ipfsCidResolver: undefined } });
    noResolver.verifyOnChainIpfsCid = async () => {
      throw new Error("must not be asked");
    };
    const second = importingProvider();
    expect((await pinDirectory({ client: noResolver, directoryCid: root, provider: second.provider })).verified).toBe(true);
  }, 180_000);

  it("asks the provider whether it answers before reading anything from chain", async () => {
    const { provider, imported } = importingProvider();
    let reads = 0;
    const counting = Object.create(client) as AbxfsClient;
    Object.defineProperty(counting, "publicClient", {
      get: () => {
        reads++;
        return client.publicClient;
      },
    });
    provider.preflight = async () => {
      throw new Error("provider unreachable");
    };
    await expect(pinRoot({ client: counting, root: `0x32${"00".repeat(31)}` as never, provider })).rejects.toThrow(/provider unreachable/);
    expect(reads).toBe(0);
    expect(imported).toHaveLength(0);
  });

  it("throws when the provider reports another root", async () => {
    const upload = await client.upload([{ path: "x.txt", bytes: enc("x"), mimeType: "text/plain" }]);
    const { provider } = importingProvider("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as IpfsCid);
    await expect(pinDirectory({ client, directoryCid: upload.rootCid, provider })).rejects.toThrow(/reported root/);
  }, 180_000);
});
