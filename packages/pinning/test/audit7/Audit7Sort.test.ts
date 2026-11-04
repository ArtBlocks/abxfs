import { describe, expect, it, vi } from "vitest";
import { ipfsDirectoryCid, ipfsFileCidWithSize, type AbxfsCid, type AbxfsClient } from "@abxfs/sdk";

// Every file in this tree is the same small one; the test is about link ORDER.
const LEAF = new TextEncoder().encode("leaf");
vi.mock("@abxfs/sdk", async (orig) => ({
  ...(await orig<typeof import("@abxfs/sdk")>()),
  readFile: async () => ({ bytes: new TextEncoder().encode("leaf") }),
}));

import { pinDirectory } from "../../src/pin.js";
import type { PinningProvider } from "../../src/types.js";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;

describe("audit7: pinDirectory link order", () => {
  it("sorts links by UTF-8 bytes like Kubo/go-unixfs (not UTF-16 code units)", async () => {
    // U+FFFF is EF BF BF in UTF-8; U+1F600 is F0 9F 98 80. Bytes: FFFF first. UTF-16: D83D.. (emoji) first.
    const names = ["￿", "\u{1F600}"];
    const client = {
      addresses: {
        chunkStore: "0x0000000000000000000000000000000000000c57",
        directoryStore: "0x0000000000000000000000000000000000000d57",
        fileStore: "0x0000000000000000000000000000000000000f1e",
      },
      publicClient: {
        async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid] }) {
          const entries = BigInt(args[0]) === 0n ? names.map((name, i) => ({ name, cid: c(10 + i), isDirectory: false })) : [];
          return functionName === "entryCount" ? BigInt(entries.length) : entries;
        },
      },
    } as unknown as AbxfsClient;
    let got = "";
    const provider: PinningProvider = {
      name: "mock",
      async pinCar({ root }) {
        got = root;
        return { pinnedCid: root };
      },
      async unpin() {},
      async isPinned() { return true; },
    };
    await pinDirectory({ client, directoryCid: c(0), provider });
    const leaf = await ipfsFileCidWithSize(LEAF);
    const byBytes = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const canonical = (await ipfsDirectoryCid(byBytes.map((name) => ({ name, cid: leaf.cid, tsize: leaf.tsize })))).cid;
    console.log("AUDIT7 pin root", got, "canonical(byte order)", canonical);
    expect(got).toBe(canonical);
  });
});
