import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Address, type PublicClient, type WalletClient } from "viem";
import { AbxfsClient } from "../src/abxfs.js";
import { iOrgFactoryAbi } from "../src/abi-org.js";
import { ZERO_HASH } from "../src/cid.js";
import { addressesForOrg, orgGenerations, recoverCreateOrg } from "../src/org.js";
import * as reads from "../src/read.js";
import * as kinds from "../src/kind.js";
import { asAbxfsCid, ProjectKind, type ContractAddresses } from "../src/types.js";
import {
  analyzePresentationDependencies, configurePresentationTarget, inspectPresentation,
  lockPresentation, PresentationCapabilityError, PresentationMethod, PresentationSelection,
  previewPresentation, readPresentation, readPresentationLockCommitment, recommendPresentationMethod, setPresentationEndpoints, setPresentationMethod,
} from "../src/presentation.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ROOT = asAbxfsCid(`0x${"aa".repeat(32)}`), ORG = a(900), HASH = `0x${"11".repeat(32)}` as const;
const addresses: ContractAddresses = {
  chunkStore: a(1), fileStore: a(2), directoryStore: a(3), sstore2Backend: a(4), fastLzBackend: a(5),
  orgFactory: a(6), projectHook: a(7), projectPresentation: a(8), contentReader: a(9),
  previousGenerations: [{ orgFactory: a(60), projectHook: a(70) }],
};
const config = { selection: 0, method: 0, locks: 0, version: 0, frozenRoot: ZERO_HASH, tag: "", path: "", chainBase: "", ipfsBase: "" };
const content = (s: string) => new TextEncoder().encode(s);

function clients(locks = 0, status = "success") {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "config") return { ...config, locks };
    if (functionName === "target") return [ROOT, ""];
    if (functionName === "lockCommitment") return HASH;
    if (functionName === "preview") return [0, "text/html", stringToHex("<p>hi</p>")];
    throw new Error(functionName);
  });
  const writeContract = vi.fn(async (_request: unknown) => HASH);
  const waitForTransactionReceipt = vi.fn(async () => ({ status }));
  return {
    publicClient: { chain: { id: 1 }, readContract, waitForTransactionReceipt } as unknown as PublicClient,
    walletClient: { chain: { id: 1 }, account: { address: a(99) }, writeContract } as unknown as WalletClient,
    readContract, writeContract, waitForTransactionReceipt,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("presentation generations and writes", () => {
  it("keeps global reader but never inherits current presentation for an old org", async () => {
    const client = { readContract: async ({ address }: { address: Address }) => address === a(60) } as unknown as PublicClient;
    const old = await addressesForOrg(client, addresses, ORG);
    expect(old?.contentReader).toBe(a(9));
    expect(old?.projectPresentation).toBeUndefined();
    expect(orgGenerations(addresses)[0]?.projectPresentation).toBe(a(8));
    await expect(readPresentation(client, old!, ORG, 0n)).rejects.toBeInstanceOf(PresentationCapabilityError);
  });

  it("refuses every write on a mismatched chain before reading or sending", async () => {
    const c = clients();
    c.walletClient = { ...c.walletClient, chain: { id: 2 } } as WalletClient;
    const operations = [
      () => configurePresentationTarget(c, addresses, ORG, 0n, { selection: PresentationSelection.Latest }),
      () => setPresentationMethod(c, addresses, ORG, 0n, "auto"),
      () => setPresentationEndpoints(c, addresses, ORG, 0n, { chainBase: "", ipfsBase: "" }),
      () => lockPresentation(c, addresses, ORG, 0n, 1, ROOT),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow(/chain 2.*chain 1/);
    expect(c.readContract).not.toHaveBeenCalled(); expect(c.writeContract).not.toHaveBeenCalled();
  });

  it("requires the reviewed commitment for every mask without silently rereading it", async () => {
    const c = clients();
    await expect(lockPresentation(c, addresses, ORG, 0n, 1, ZERO_HASH)).rejects.toThrow(/reviewed snapshot/);
    for (const mask of [1, 2, 3, 4, 7]) await lockPresentation(c, addresses, ORG, 0n, mask, HASH);
    expect(c.readContract).not.toHaveBeenCalled();
    expect(c.writeContract.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 7].map(mask => expect.objectContaining({ functionName: "lock", args: [ORG, 0n, mask, HASH] })));
    expect(c.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("reads lock commitments at the reviewed block, including method-only snapshots", async () => {
    const c = clients();
    expect(await readPresentationLockCommitment(c.publicClient, addresses, ORG, 3n, 2, 123n)).toBe(HASH);
    expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "lockCommitment", args: [ORG, 3n, 2], blockNumber: 123n }));
    await expect(readPresentationLockCommitment(c.publicClient, addresses, ORG, 3n, 8)).rejects.toThrow(/mask/);
  });

  it("previews newly confirmed settings instead of a cached pre-write block", async () => {
    mockContent();
    const c = clients();
    c.publicClient.getBlockNumber = vi.fn(async (options) => options?.cacheTime === 0 ? 2n : 1n);
    c.readContract.mockImplementation(async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === "config") return { ...config, method: blockNumber === 2n ? 1 : 0 };
      if (functionName === "target") return [ROOT, ""];
      if (functionName === "preview") return [0, "text/html", stringToHex("<p>hi</p>")];
      throw new Error(functionName);
    });
    const preview = await previewPresentation(c.publicClient, addresses, ORG, 0n);
    expect(preview.blockNumber).toBe(2n);
    expect(preview.method).toBe(PresentationMethod.Embedded);
    expect(c.readContract.mock.calls.every(([request]) => (request as { blockNumber?: bigint }).blockNumber === 2n)).toBe(true);
  });

  it("rejects reverted receipts and uses exact target selectors", async () => {
    const c = clients(0, "reverted");
    await expect(configurePresentationTarget(c, addresses, ORG, 7n, { selection: PresentationSelection.Version, version: 3, path: "art/index.html" })).rejects.toThrow(/reverted/);
    expect(c.writeContract.mock.calls[0]?.[0]).toMatchObject({ args: [ORG, 7n, 1, 3, "", "art/index.html"] });
  });
});

function createdLog(factory: Address, org: Address) {
  return { address: factory, topics: encodeEventTopics({ abi: iOrgFactoryAbi, eventName: "OrgCreated", args: { org, admin: a(99), index: 0n } }),
    data: encodeAbiParameters([{ type: "string" }, { type: "uint64" }], ["org", 1n]), blockNumber: 1n, transactionHash: HASH, transactionIndex: 0, blockHash: HASH, logIndex: 0, removed: false };
}
describe("receipt recovery across factory rollover", () => {
  it("reads the receipt once and recovers the actual older-generation org without log scans", async () => {
    const getTransactionReceipt = vi.fn(async () => ({ status: "success", logs: [createdLog(a(60), ORG)] }));
    const client = { getTransactionReceipt } as unknown as PublicClient;
    expect(await recoverCreateOrg(client, addresses, HASH)).toEqual({ state: "mined", org: ORG, tokenId: 0n });
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    const sdk = new AbxfsClient({ publicClient: client, addresses });
    expect(await sdk.recoverCreateOrg(HASH)).toEqual({ state: "mined", org: ORG, tokenId: 0n });
    expect(await recoverCreateOrg(client, a(60), HASH)).toEqual({ state: "mined", org: ORG, tokenId: 0n });
  });
  it("refuses multiple matching creations instead of selecting the first", async () => {
    const client = { getTransactionReceipt: async () => ({ status: "success", logs: [createdLog(a(60), ORG), createdLog(a(6), a(901))] }) } as unknown as PublicClient;
    expect(await recoverCreateOrg(client, addresses, HASH)).toMatchObject({ state: "unknown", reason: expect.stringContaining("2 matching") });
  });
});

function mockContent(opts: { mime?: string; body?: string; codec?: `0x${string}`; size?: number; directory?: boolean; entries?: number } = {}) {
  vi.spyOn(kinds, "cidKind").mockResolvedValue(opts.directory ? ProjectKind.Directory : ProjectKind.File);
  vi.spyOn(reads, "getFileInfo").mockResolvedValue({ root: ROOT, rootLevel: 0, size: opts.size ?? 10, chunkCount: 1, mimeType: opts.mime ?? "text/html", codec: opts.codec ?? ZERO_HASH, outputHash: ROOT });
  vi.spyOn(reads, "readFile").mockResolvedValue({ cid: ROOT, mimeType: opts.mime ?? "text/html", codec: ZERO_HASH, chunkIds: [], outputHash: ROOT, bytes: content(opts.body ?? "<p>Hello</p>"), data: content("") });
  vi.spyOn(reads, "directoryEntryCount").mockResolvedValue(opts.entries ?? 1);
  vi.spyOn(reads, "lookupEntry").mockResolvedValue({ cid: ROOT, isDirectory: false });
}
describe("Auto is conservative tooling only", () => {
  it("prefers a tiny static self-contained HTML or media payload", async () => {
    mockContent();
    expect(await recommendPresentationMethod({} as PublicClient, addresses, ROOT)).toMatchObject({ method: PresentationMethod.Embedded, residualDependencies: [], runtimeUncertain: false });
    vi.restoreAllMocks(); mockContent({ mime: "image/png", body: "png" });
    expect((await recommendPresentationMethod({} as PublicClient, addresses, ROOT)).method).toBe(PresentationMethod.Embedded);
  });
  it.each([
    { codec: stringToHex("gzip", { size: 32 }) },
    { body: '<img src="./image.png">' },
    { body: '<script>fetch("https://cdn.example/x")</script>' },
    { body: '<script type="module">import helper from "./helper.js"</script>' },
    { directory: true, entries: 2 },
    { size: 8_193 },
    { mime: "text/plain" },
  ])("chooses chain gateway and never IPFS for excluded content %o", async opts => {
    mockContent(opts);
    const recommendation = await recommendPresentationMethod({} as PublicClient, addresses, ROOT);
    expect(recommendation.method).toBe(PresentationMethod.ChainGateway);
    expect(recommendation.reason.length).toBeGreaterThan(10);
  });
  it("reports static references and uncertain runtime rather than claiming to prove JavaScript", () => {
    expect(analyzePresentationDependencies("text/html", content('<link href="https://cdn.example/a.css"><script>fetch(url)</script>'))).toEqual({ residualDependencies: ["https://cdn.example/a.css", "runtime dependency: fetch("], runtimeUncertain: true });
  });
  it("uses existing codec reads to expose residual dependencies of gzip HTML while retaining gateway delivery", async () => {
    mockContent({ codec: stringToHex("gzip", { size: 32 }), body: '<img src="https://cdn.example/art.png">' });
    expect(await recommendPresentationMethod({} as PublicClient, addresses, ROOT)).toMatchObject({ method: PresentationMethod.ChainGateway, residualDependencies: ["https://cdn.example/art.png"] });
  });
  it("supports typical inline canvas JavaScript while exposing runtime uncertainty", async () => {
    mockContent({ body: '<canvas id="art"></canvas><script>const c=document.getElementById("art").getContext("2d");c.fillRect(0,0,100,100)</script>' });
    expect(await recommendPresentationMethod({} as PublicClient, addresses, ROOT)).toMatchObject({ method: PresentationMethod.Embedded, runtimeUncertain: true, residualDependencies: [] });
  });
  it("resolves Auto to a concrete method before sending", async () => {
    mockContent(); const c = clients();
    await setPresentationMethod(c, addresses, ORG, 0n, "auto");
    expect(c.writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "setMethod", args: [ORG, 0n, PresentationMethod.Embedded] });
  });
  it("preview returns exact root/path/method/status/locks and reports residual dependencies at one block", async () => {
    mockContent({ body: '<img src="other.png">' }); const c = clients(5);
    const getBlockNumber = vi.fn(async () => 42n);
    const client = { ...c.publicClient, getBlockNumber } as unknown as PublicClient;
    const preview = await previewPresentation(client, addresses, ORG, 0n);
    expect(preview).toMatchObject({ root: ROOT, path: "", method: 0, status: 0, locks: 5, blockNumber: 42n, residualDependencies: ["other.png"] });
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    for (const call of c.readContract.mock.calls) expect(call[0]).toMatchObject({ blockNumber: 42n });
    expect(await inspectPresentation(c.publicClient, addresses, ORG, 0n)).toMatchObject({ root: ROOT });
  });
});
