/**
 * CAR derivation against a fake client (no chain): the archive names the derived root, holds every block under it
 * exactly once, and the derived root is what the SDK's own composition of `ipfsFileCidWithSize` / `ipfsDirectoryCid`
 * gives for the same tree — including the trees file-based uploads could not express (an empty directory, an empty
 * file).
 */
import { describe, expect, it, vi } from "vitest";
import { ipfsDirectoryCid, ipfsFileCidWithSize, type AbxfsCid, type AbxfsClient, type IpfsCid } from "@artblocks/abxfs-sdk";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;

function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 0x12345678;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** File contents by file cid; `readFile` is the only content read the walk makes. */
const CONTENT = new Map<string, Uint8Array>([
  [c(100), new TextEncoder().encode("<html>hello</html>")],
  [c(101), new Uint8Array(0)],
  // 600 KiB of non-repeating bytes: three distinct raw leaves under one dag-pb file node.
  [c(102), noise(600 * 1024)],
  [c(103), new TextEncoder().encode("export const v = 1;\n")],
]);

vi.mock("@artblocks/abxfs-sdk", async (orig) => ({
  ...(await orig<typeof import("@artblocks/abxfs-sdk")>()),
  readFile: async (_pc: unknown, _a: unknown, cid: string) => {
    const bytes = CONTENT.get(cid);
    if (!bytes) throw new Error(`no file ${cid}`);
    return { bytes };
  },
}));

import { CAR_MEDIA_TYPE, carHeader, deriveCar, pinDirectory, pinRoot } from "../src/index.js";
import type { PinningProvider } from "../src/types.js";
import { reachable, readCar } from "./helpers/car-reader.js";

type Entry = { name: string; cid: AbxfsCid; isDirectory: boolean };

/**
 * root (c0): index.html, empty.txt (empty file), big.bin (600 KiB), copy.html (same file as index.html),
 *            empty/ (empty directory), lib/ (c2: util.js), vendor/ (c2 again: a shared sub-DAG)
 */
const DIRS = new Map<string, Entry[]>([
  [
    c(0),
    [
      { name: "index.html", cid: c(100), isDirectory: false },
      { name: "empty.txt", cid: c(101), isDirectory: false },
      { name: "big.bin", cid: c(102), isDirectory: false },
      { name: "copy.html", cid: c(100), isDirectory: false },
      { name: "empty", cid: c(1), isDirectory: true },
      { name: "lib", cid: c(2), isDirectory: true },
      { name: "vendor", cid: c(2), isDirectory: true },
    ],
  ],
  [c(1), []],
  [c(2), [{ name: "util.js", cid: c(103), isDirectory: false }]],
]);

function fakeClient(dirs = DIRS): AbxfsClient {
  return {
    addresses: {
      chunkStore: "0x0000000000000000000000000000000000000c57",
      directoryStore: "0x0000000000000000000000000000000000000d57",
      fileStore: "0x0000000000000000000000000000000000000f1e",
    },
    publicClient: {
      async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid, bigint?, bigint?] }) {
        if (functionName === "directoryExists") return dirs.has(args[0]);
        if (functionName === "fileExists") return CONTENT.has(args[0]);
        const entries = dirs.get(args[0]);
        if (!entries) throw new Error(`no directory ${args[0]}`);
        if (functionName === "entryCount") return BigInt(entries.length);
        return entries.slice(Number(args[1] ?? 0), Number(args[2] ?? entries.length));
      },
    },
  } as unknown as AbxfsClient;
}

/** The same tree composed by hand from the SDK's derivation functions. */
async function expectedRoot(): Promise<IpfsCid> {
  const f = async (cid: AbxfsCid) => ipfsFileCidWithSize(CONTENT.get(cid)!);
  const dir = async (links: Array<{ name: string; cid: IpfsCid; tsize: number }>) => {
    const sorted = links.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const d = await ipfsDirectoryCid(sorted);
    return { cid: d.cid, tsize: d.encoded.length + links.reduce((n, l) => n + l.tsize, 0) };
  };
  const index = await f(c(100));
  const empty = await dir([]);
  const lib = await dir([{ name: "util.js", ...(await f(c(103))) }]);
  const root = await dir([
    { name: "index.html", ...index },
    { name: "empty.txt", ...(await f(c(101))) },
    { name: "big.bin", ...(await f(c(102))) },
    { name: "copy.html", ...index },
    { name: "empty", ...empty },
    { name: "lib", ...lib },
    { name: "vendor", ...lib },
  ]);
  return root.cid;
}

async function carBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("deriveCar", () => {
  it("derives the same root as the SDK and archives exactly the DAG under it", async () => {
    const derived = await deriveCar({ client: fakeClient(), root: c(0), kind: "directory" });
    expect(derived.root).toBe(await expectedRoot());
    expect(derived.kind).toBe("directory");
    expect(derived.car.type).toBe(CAR_MEDIA_TYPE);

    const car = await readCar(await carBytes(derived.car));
    expect(car.version).toBe(1);
    expect(car.roots).toEqual([derived.root]);
    expect(car.order[0]).toBe(derived.root); // root block first
    // Complete (every link resolves) and minimal (nothing unreachable), each block once (the reader refuses repeats).
    expect(reachable(car, derived.root)).toEqual(new Set(car.order));
    expect(derived.blockCount).toBe(car.order.length);
    // root dir, empty dir, lib (shared), index (shared), empty file, util.js, big.bin: 1 node + 3 leaves.
    expect(car.order.length).toBe(10);
  });

  it("holds the empty directory and the empty file as their standard blocks", async () => {
    const car = await readCar(await carBytes((await deriveCar({ client: fakeClient(), root: c(0), kind: "directory" })).car));
    expect(car.blocks.has("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354")).toBe(true);
    expect(car.blocks.get("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toEqual(new Uint8Array(0));
  });

  it("pins a root that is itself an empty directory", async () => {
    const derived = await deriveCar({ client: fakeClient(), root: c(1), kind: "directory" });
    expect(derived.root).toBe("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
    const car = await readCar(await carBytes(derived.car));
    expect(car.order).toEqual([derived.root]);
  });

  it("probes the kind when not told, and archives a file root", async () => {
    const derived = await deriveCar({ client: fakeClient(), root: c(102) });
    expect(derived.kind).toBe("file");
    expect(derived.root).toBe((await ipfsFileCidWithSize(CONTENT.get(c(102))!)).cid);
    expect(derived.files).toEqual([{ path: "", ipfsCid: derived.root }]);
    const car = await readCar(await carBytes(derived.car));
    expect(car.order.length).toBe(4);
    expect(reachable(car, derived.root).size).toBe(4);
  });

  it("refuses a root neither store has", async () => {
    await expect(deriveCar({ client: fakeClient(), root: c(999) })).rejects.toThrow(/neither a file nor a directory/);
  });

  it("lists each distinct file once, at the first path it was found", async () => {
    const seen: string[] = [];
    const derived = await deriveCar({ client: fakeClient(), root: c(0), kind: "directory", onFile: (f) => seen.push(f.path) });
    // Sorted by UTF-8 name: big.bin, copy.html (index.html's content, met first here), empty.txt, lib/util.js.
    expect(seen).toEqual(["big.bin", "copy.html", "empty.txt", "lib/util.js"]);
    expect(derived.files.map((f) => f.path)).toEqual(seen);
  });

  it("refuses a directory that lists itself as a descendant instead of waiting on itself", async () => {
    const cyclic = new Map<string, Entry[]>([
      [c(0), [{ name: "loop", cid: c(5), isDirectory: true }]],
      [c(5), [{ name: "back", cid: c(0), isDirectory: true }]],
    ]);
    await expect(deriveCar({ client: fakeClient(cyclic), root: c(0), kind: "directory" })).rejects.toThrow(/cycle/);
  });
});

describe("carHeader", () => {
  it("is the dag-cbor map { roots: [root], version: 1 } behind its varint length", async () => {
    const { CID } = await import("multiformats/cid");
    const root = CID.parse("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
    const hex = Buffer.from(carHeader(root.bytes)).toString("hex");
    expect(hex).toBe(
      "3a" + // 58 header bytes follow
        "a2" + "65" + Buffer.from("roots").toString("hex") + "81" + "d82a" + "5825" + "00" +
        Buffer.from(root.bytes).toString("hex") +
        "67" + Buffer.from("version").toString("hex") + "01",
    );
  });
});

describe("pinRoot", () => {
  function recordingProvider(reply?: (root: IpfsCid) => IpfsCid) {
    const calls: Array<{ root: IpfsCid; name: string; car: Uint8Array }> = [];
    const provider: PinningProvider = {
      name: "mock",
      async pinCar({ root, car, name }) {
        calls.push({ root, name, car: await carBytes(car) });
        return { pinnedCid: reply ? reply(root) : root };
      },
      async unpin() {},
      async isPinned() {
        return true;
      },
    };
    return { provider, calls };
  }

  it("hands the provider the CAR and verifies the root it reports", async () => {
    const { provider, calls } = recordingProvider();
    const result = await pinDirectory({ client: fakeClient(), directoryCid: c(0), provider });
    expect(result.verified).toBe(true);
    expect(result.pinnedCid).toBe(await expectedRoot());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe(result.expectedCid);
    expect(calls[0]!.car.length).toBe(result.carBytes);
    expect((await readCar(calls[0]!.car)).roots).toEqual([result.expectedCid]);
  });

  it("throws when the provider reports another root, unless verify is off", async () => {
    const wrong = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as IpfsCid;
    const { provider } = recordingProvider(() => wrong);
    await expect(pinRoot({ client: fakeClient(), root: c(0), kind: "directory", provider })).rejects.toThrow(
      /reported root .* for a CAR whose root is/,
    );
    const result = await pinRoot({ client: fakeClient(), root: c(0), kind: "directory", provider, verify: false });
    expect(result.verified).toBe(false);
    expect(result.pinnedCid).toBe(wrong);
  });

  it("passes a caller's name through", async () => {
    const { provider, calls } = recordingProvider();
    await pinRoot({ client: fakeClient(), root: c(2), kind: "directory", provider, name: "my-site" });
    expect(calls[0]!.name).toBe("my-site");
  });
});
