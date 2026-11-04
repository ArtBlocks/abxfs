/**
 * S-M3 / RS-L1: a directory entry name is BYTES on chain (`specs/abx-fs.md` §5: any 1..255 bytes but `.`, `..`, `/`
 * and `\`). viem decoded the ABI's `string` with a default TextDecoder, so a leading U+FEFF vanished and invalid UTF-8
 * became U+FFFD: a no-op draft changed the root or dropped an entry, the IPFS derivation disagreed with the chain, and
 * `lookup` of a listed name reverted. Names are now read as bytes and carried as a lossless text form end to end.
 */
import { concat, keccak256, toHex, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { directoryStoreAbi } from "../../src/abi.js";
import {
  EntryNameSpellingError,
  assertLiteralPath,
  decodeEntryName,
  encodeEntryName,
  entryNameBytes,
  isUtf8Name,
} from "../../src/names.js";
import { ipfsDirectoryCid, sortDirectoryEntries } from "../../src/cid.js";
import { packDirectory, assertEntryName } from "../../src/nodes.js";
import { planDirectoryTree, planUploadOffline } from "../../src/plan.js";
import { applyDraftToBase } from "../../src/draft.js";
import { uploadFiles } from "../../src/upload.js";
import { lookupEntry, readDirectory, resolvePath, walkDirectoryTree } from "../../src/read.js";
import { assertIpfsCidAgreement, verifyLocalIpfsCid } from "../../src/verify.js";
import { LEGACY_GAS_SCHEDULE } from "../../src/gas-schedule.js";
import type { AbxfsCid, IpfsCid } from "../../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { UnixFS } from "ipfs-unixfs";

const b = (...xs: number[]) => Uint8Array.from(xs);
const BOM_NAME = "﻿index.html";

describe("the text form of a name", () => {
  it("is the UTF-8 text when the bytes are UTF-8, a leading U+FEFF included", () => {
    expect(decodeEntryName(new TextEncoder().encode(BOM_NAME))).toBe(BOM_NAME);
    expect(decodeEntryName(new TextEncoder().encode("héllo 🌍"))).toBe("héllo 🌍");
    expect(isUtf8Name(b(0x63, 0xff))).toBe(false);
  });

  it("escapes each byte that is not part of a well-formed sequence, visibly, and maps back exactly", () => {
    const cases: Array<[Uint8Array, string]> = [
      [b(0x63, 0xff), "c\\xff"],
      [b(0x63, 0xfe), "c\\xfe"],
      [b(0xc3), "\\xc3"], // a truncated two-byte sequence
      [b(0xc3, 0xa9, 0xff, 0x41), "é\\xffA"],
      [b(0xed, 0xa0, 0x80), "\\xed\\xa0\\x80"], // an encoded surrogate is not UTF-8
      [b(0xf0, 0x9f, 0x8c), "\\xf0\\x9f\\x8c"], // a truncated four-byte sequence
      [b(0xc0, 0xaf), "\\xc0\\xaf"], // an overlong "/"
    ];
    for (const [bytes, text] of cases) {
      expect(decodeEntryName(bytes)).toBe(text);
      expect(encodeEntryName(text)).toEqual(bytes);
    }
  });

  it("is a bijection over random bytes without a backslash", () => {
    let s = 7;
    const next = () => (s = (s * 1103515245 + 12345) >>> 0);
    for (let t = 0; t < 2000; t++) {
      const bytes = Uint8Array.from({ length: 1 + (next() % 40) }, () => {
        const v = next() % 256;
        return v === 0x5c ? 0x5d : v;
      });
      expect(encodeEntryName(decodeEntryName(bytes))).toEqual(bytes);
    }
  });

  it("has one spelling: a backslash that is not the canonical escape is refused", () => {
    for (const bad of ["a\\b", "\\x41", "\\xFF", "\\xc3\\xa9", "\\x5c", "\\x", "\\xg0"]) {
      expect(() => encodeEntryName(bad), bad).toThrow(EntryNameSpellingError);
    }
  });

  it("names a person or a file system supplies are literal: a backslash is refused by name", () => {
    expect(() => assertLiteralPath("dir/a\\xff")).toThrow(/backslash/);
    expect(() => assertLiteralPath(BOM_NAME)).not.toThrow();
  });

  it("packing uses the exact bytes: three names that a lossy decoder makes two", () => {
    const cid = `0x${"11".repeat(32)}` as AbxfsCid;
    const entries = [b(0x63, 0xfe), b(0x63, 0xff), new TextEncoder().encode(BOM_NAME)].map((nameBytes) => ({
      name: decodeEntryName(nameBytes),
      nameBytes,
      cid,
      isDirectory: false,
    }));
    // From the bytes, and from the text forms alone: the same directory.
    const fromBytes = packDirectory(entries).cid;
    const fromText = packDirectory(entries.map(({ name, cid: c, isDirectory }) => ({ name, cid: c, isDirectory }))).cid;
    expect(fromText).toBe(fromBytes);
    expect(sortDirectoryEntries(entries).map((e) => toHex(entryNameBytes(e)))).toEqual(["0x63fe", "0x63ff", "0xefbbbf696e6465782e68746d6c"]);
    expect(assertEntryName(b(0x63, 0xff))).toEqual(b(0x63, 0xff));
    expect(() => assertEntryName(b(0x2e, 0x2e))).toThrow(/reserved/);
  });

  it("a fold of text paths keeps every name, and a duplicate path is refused", () => {
    const cid = `0x${"22".repeat(32)}` as AbxfsCid;
    const t = planDirectoryTree([{ path: "d/c\\xfe", cid }, { path: "d/c\\xff", cid }, { path: `d/${BOM_NAME}`, cid }]);
    expect(t.directories.find((d) => d.path === "d")!.entries).toHaveLength(3);
    expect(() => planDirectoryTree([{ path: "a.txt", cid }, { path: "a.txt", cid }])).toThrow(/twice/);
  });

  it("the IPFS block carries the exact bytes, and is byte-identical to @ipld/dag-pb for UTF-8 names", async () => {
    const child = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as IpfsCid;
    const utf8Names = ["a", BOM_NAME, "héllo", "z".repeat(255)];
    const ours = await ipfsDirectoryCid(utf8Names.map((name) => ({ name, cid: child, tsize: 0 })));
    const reference = dagPB.encode(
      dagPB.prepare({ Data: new UnixFS({ type: "directory" }).marshal(), Links: utf8Names.map((Name) => ({ Name, Hash: CID.parse(child), Tsize: 0 })) }),
    );
    expect(ours.encoded).toEqual(reference);
    const raw = await ipfsDirectoryCid([{ name: "c\\xff", nameBytes: b(0x63, 0xff), cid: child, tsize: 0 }]);
    const hex = toHex(raw.encoded);
    expect(hex).toContain("120263ff"); // Name: field 2, 2 bytes, 0x63 0xff
  });
});

describe("names on chain: read, draft, verify", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    h = await startAnvilWithAbxfs({ deployCompanion: true });
  }, 120_000);
  afterAll(async () => h?.stop());

  const backends = () => ({ raw: h.addresses.sstore2Backend, fastLz: h.addresses.fastLzBackend });

  /** A directory of `names` (raw bytes), each naming `fileCid` (a directory when `isDirectory`), written as any client may. */
  async function dirOf(names: Uint8Array[], fileCid: AbxfsCid, isDirectory = false): Promise<AbxfsCid> {
    const sorted = [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    const recs = sorted.map((n) => concat([toHex(n.length, { size: 1 }), toHex(n), isDirectory ? "0x01" : "0x00", fileCid]));
    let off = 0;
    const offs = recs.map((r) => {
      const o = off;
      off += (r.length - 2) / 2;
      return toHex(o, { size: 2 });
    });
    const blob = concat(["0x00", toHex(sorted.length, { size: 2 }), ...offs, ...recs]) as Hex;
    for (const [fn, arg] of [["putEntryNode", blob], ["createDirectory", keccak256(concat(["0x42", blob]))]] as const) {
      const hash = await h.walletClient.writeContract({ address: h.addresses.directoryStore, abi: directoryStoreAbi, functionName: fn, args: [arg] });
      await h.publicClient.waitForTransactionReceipt({ hash });
    }
    return keccak256(concat(["0x32", keccak256(concat(["0x42", blob]))])) as AbxfsCid;
  }

  it("a BOM name the SDK writes reads back with its BOM, looks up, and survives a no-op draft and IPFS agreement", async () => {
    const enc = new TextEncoder();
    const up = await uploadFiles({ publicClient: h.publicClient, walletClient: h.walletClient }, h.addresses, [
      { path: BOM_NAME, bytes: enc.encode("<h1>hi</h1>"), mimeType: "text/html" },
      { path: "b.txt", bytes: enc.encode("world"), mimeType: "text/plain" },
    ], { gasSchedule: LEGACY_GAS_SCHEDULE });
    const root = up.rootCid;
    const dir = await readDirectory(h.publicClient, h.addresses, root);
    expect(dir.entries.map((e) => e.name)).toContain(BOM_NAME);
    const listed = dir.entries.find((e) => e.name.includes("index"))!;
    expect(toHex(listed.nameBytes!)).toBe(toHex(enc.encode(BOM_NAME)));
    await expect(lookupEntry(h.publicClient, h.addresses, root, listed.name)).resolves.toMatchObject({ isDirectory: false });
    await expect(lookupEntry(h.publicClient, h.addresses, root, listed.nameBytes!)).resolves.toMatchObject({ isDirectory: false });
    const noop = await applyDraftToBase(h.publicClient, h.addresses, root, [], { backends: backends() });
    expect(noop.newRootCid).toBe(root);
    const agree = await assertIpfsCidAgreement(h.publicClient, h.addresses, root);
    expect(agree.local).toBe(agree.onChain);
  }, 300_000);

  it("0xff, and 0xfe beside 0xff, read as distinct escaped names; a no-op draft keeps the root; IPFS agrees with the chain", async () => {
    const up = await uploadFiles({ publicClient: h.publicClient, walletClient: h.walletClient }, h.addresses, [
      { path: "x.txt", bytes: new TextEncoder().encode("bytes"), mimeType: "text/plain" },
    ], { gasSchedule: LEGACY_GAS_SCHEDULE });
    const fileCid = up.files[0]!.cid;
    const one = await dirOf([b(0x63, 0xff)], fileCid);
    const two = await dirOf([b(0x63, 0xfe), b(0x63, 0xff)], fileCid);
    const outer = await dirOf([enc8("inner")], two, true); // a directory holding `two`, so paths descend through it

    expect((await readDirectory(h.publicClient, h.addresses, one)).entries.map((e) => e.name)).toEqual(["c\\xff"]);
    const listed = (await readDirectory(h.publicClient, h.addresses, two)).entries;
    expect(listed.map((e) => e.name)).toEqual(["c\\xfe", "c\\xff"]);
    expect(listed.map((e) => toHex(e.nameBytes!))).toEqual(["0x63fe", "0x63ff"]);

    for (const root of [one, two]) {
      const noop = await applyDraftToBase(h.publicClient, h.addresses, root, [], { backends: backends() });
      expect(noop.newRootCid).toBe(root);
      expect(noop.files.filter((f) => f.kind === "unchanged")).toHaveLength(root === two ? 2 : 1);
      const agree = await assertIpfsCidAgreement(h.publicClient, h.addresses, root);
      expect(agree.local).toBe(agree.onChain);
    }

    // Every listed name resolves, by its text form and by its bytes, and so does a path through it.
    await expect(lookupEntry(h.publicClient, h.addresses, two, "c\\xff")).resolves.toMatchObject({ cid: fileCid });
    await expect(lookupEntry(h.publicClient, h.addresses, two, b(0x63, 0xfe))).resolves.toMatchObject({ cid: fileCid });
    await expect(resolvePath(h.publicClient, h.addresses, outer, "inner/c\\xfe")).resolves.toMatchObject({ cid: fileCid, isDirectory: false });
    // Another spelling of the same bytes is not a name: the contract refuses it as it always did.
    await expect(lookupEntry(h.publicClient, h.addresses, two, "c�")).rejects.toThrow();

    const walked = await walkDirectoryTree(h.publicClient, h.addresses, outer);
    expect(walked.files.map((f) => f.path).sort()).toEqual(["inner/c\\xfe", "inner/c\\xff"]);
    const noop = await applyDraftToBase(h.publicClient, h.addresses, outer, [], { backends: backends() });
    expect(noop.newRootCid).toBe(outer);
    expect(await verifyLocalIpfsCid(h.publicClient, h.addresses, outer)).toBe((await assertIpfsCidAgreement(h.publicClient, h.addresses, outer)).onChain);

    // An edit beside the escaped names: removing one keeps the other, byte for byte.
    const edited = await applyDraftToBase(h.publicClient, h.addresses, two, [{ kind: "remove", path: "c\\xfe" }], { backends: backends() });
    expect(edited.newRootCid).toBe(one);
  }, 300_000);

  it("uploads from a file system stay literal UTF-8, and a backslash in one is refused before anything is planned", async () => {
    await expect(planUploadOffline([{ path: "a\\xff", bytes: b(1), mimeType: "text/plain" }], { backends: backends() })).rejects.toThrow(/backslash/);
    const p = await planUploadOffline([{ path: BOM_NAME, bytes: b(1), mimeType: "text/plain" }], { backends: backends() });
    expect(toHex(entryNameBytes(p.directories.at(-1)!.entries[0]!))).toBe(toHex(new TextEncoder().encode(BOM_NAME)));
  });
});

function enc8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
