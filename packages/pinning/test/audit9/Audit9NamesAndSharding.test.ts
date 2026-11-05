/**
 * Pinning carries entry names as their exact bytes (S-M3 / RS-L1), and refuses by the rule IPFS shards by (RS-M1).
 *
 *   - A name on chain is bytes, UTF-8 or not. The CAR's directory block must hold those bytes, or the pinned root is a
 *     CID no reader of the chain derives (`0xfe` and `0xff` both decoded to U+FFFD and collided; a BOM vanished).
 *   - Kubo shards a directory once the sum over every entry of name bytes plus 36 passes 262,144. A directory past that
 *     has no flat CID `ipfs add -r` agrees with, so it is refused, under the error name the gateway's mirror matches.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DirectoryNeedsShardingError,
  ipfsDirectoryCid,
  ipfsFileCidWithSize,
  type AbxfsCid,
  type AbxfsClient,
} from "@artblocks/abxfs-sdk";

// Every file in these trees is the same small one: the tests are about directory blocks.
const LEAF = new TextEncoder().encode("leaf");
let fileReads = 0;
vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readFile: async () => {
    fileReads++;
    return { bytes: new TextEncoder().encode("leaf") };
  },
}));

import { DirectoryTooLargeForFlatIpfsError, deriveCar, pinDirectory } from "../../src/pin.js";
import type { PinningProvider } from "../../src/types.js";
import { readCar } from "../helpers/car-reader.js";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

/** A client listing one directory (cid 0) as the bytes ABI returns names: 0x-hex. */
function client(names: Uint8Array[]): AbxfsClient {
  const entries = names.map((n, i) => ({ name: hex(n), cid: c(10 + i), isDirectory: false }));
  return {
    addresses: {
      chunkStore: "0x0000000000000000000000000000000000000c57",
      directoryStore: "0x0000000000000000000000000000000000000d57",
      fileStore: "0x0000000000000000000000000000000000000f1e",
    },
    publicClient: {
      async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid, bigint?, bigint?] }) {
        if (functionName === "entryCount") return BigInt(entries.length);
        return entries.slice(Number(args[1]), Number(args[2]));
      },
    },
  } as unknown as AbxfsClient;
}

const provider: PinningProvider = {
  name: "mock",
  async pinCar({ root }) {
    return { pinnedCid: root };
  },
  async unpin() {},
  async isPinned() {
    return true;
  },
};

describe("names are pinned as their exact bytes", () => {
  it("a BOM name, 0xff, and 0xfe beside it: three links, each with its own bytes, in byte order", async () => {
    const names = [new TextEncoder().encode("﻿index.html"), Uint8Array.from([0x63, 0xff]), Uint8Array.from([0x63, 0xfe])];
    const car = await deriveCar({ client: client(names), root: c(0), kind: "directory" });
    const parsed = await readCar(new Uint8Array(await car.car.arrayBuffer()));
    expect(parsed.roots).toEqual([car.root]);
    const block = parsed.blocks.get(car.root)!;
    const blockHex = Buffer.from(block).toString("hex");
    // Name is dag-pb field 2: tag 0x12, then the length, then the bytes, exactly.
    expect(blockHex).toContain("120263fe");
    expect(blockHex).toContain("120263ff");
    expect(blockHex).toContain("120d" + "efbbbf" + Buffer.from("index.html").toString("hex"));
    expect(blockHex.indexOf("120263fe")).toBeLessThan(blockHex.indexOf("120263ff"));

    // The root is the SDK's derivation from the same bytes, which the on-chain resolver agrees with (SDK Audit9Names).
    const leaf = await ipfsFileCidWithSize(LEAF);
    const expected = await ipfsDirectoryCid(names.map((nameBytes) => ({ name: "", nameBytes, cid: leaf.cid, tsize: leaf.tsize })));
    expect(car.root).toBe(expected.cid);
  });
});

describe("pinning refuses what IPFS would shard, by the same rule", () => {
  const names = (count: number, len: number) =>
    Array.from({ length: count }, (_, i) => new TextEncoder().encode(String(i).padStart(5, "0") + "n".repeat(len - 5)));

  it("900 entries of 255-byte names (estimate 261,900) pin flat", async () => {
    const r = await pinDirectory({ client: client(names(900, 255)), directoryCid: c(0), provider });
    expect(r.verified).toBe(true);
  });

  it("901 (262,191) are refused from the listing, before any file is read, under the name the mirror matches", async () => {
    fileReads = 0;
    const err = await pinDirectory({ client: client(names(901, 255)), directoryCid: c(0), provider }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryTooLargeForFlatIpfsError);
    expect(err).toBeInstanceOf(DirectoryNeedsShardingError);
    expect((err as Error).name).toBe("DirectoryTooLargeForFlatIpfsError");
    expect((err as DirectoryTooLargeForFlatIpfsError).blockBytes).toBe(262_191);
    expect((err as Error).message).toMatch(/needs sharding, not supported/);
    expect(fileReads).toBe(0);
  });

  it("the boundary is strict: exactly 262,144 pins, 262,145 is refused", async () => {
    const at = [...names(900, 255), new TextEncoder().encode("z" + "m".repeat(207))];
    const over = [...names(900, 255), new TextEncoder().encode("z" + "m".repeat(208))];
    await expect(pinDirectory({ client: client(at), directoryCid: c(0), provider })).resolves.toMatchObject({ verified: true });
    await expect(pinDirectory({ client: client(over), directoryCid: c(0), provider })).rejects.toBeInstanceOf(DirectoryTooLargeForFlatIpfsError);
  });
});
