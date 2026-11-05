/**
 * The mirror's pre-flight on roots: directories are read by count and in pages, and one whose flat IPFS
 * block would be too big is skipped by name (not derived wrong).
 */
import { describe, expect, it } from "vitest";
import { ProjectKind, type DirectoryEntry } from "@artblocks/abxfs-sdk";

import { assessRoot, RootTooLargeError } from "../src/mirror.js";
import { FakeChain } from "./fake-chain.js";

const te = (s: string) => new TextEncoder().encode(s);

describe("assessRoot on v2", () => {
  it("counts the files of a 3,000-entry directory by paging, within the caps", async () => {
    const chain = new FakeChain();
    const f = chain.addFile([te("x")]).cid;
    const entries: DirectoryEntry[] = Array.from({ length: 3000 }, (_, i) => ({ name: `f${String(i).padStart(5, "0")}`, cid: f, isDirectory: false }));
    const root = chain.addDirectory(entries);
    const r = await assessRoot({ id: 84532, contracts: chain.contracts, client: chain.client }, root, ProjectKind.Directory);
    // The one distinct file is counted once (a shared child is not expanded per parent); the directory read in pages of 100.
    expect(r.files).toBe(1);
    expect(chain.count("getEntries")).toBe(30);
  });

  it("refuses a directory over --max-files-per-root by its count, before paging any entries", async () => {
    const chain = new FakeChain();
    const f = chain.addFile([te("x")]).cid;
    const entries: DirectoryEntry[] = Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, cid: f, isDirectory: false }));
    const root = chain.addDirectory(entries);
    await expect(assessRoot({ id: 84532, contracts: chain.contracts, client: chain.client }, root, ProjectKind.Directory, { maxFilesPerRoot: 100 })).rejects.toBeInstanceOf(RootTooLargeError);
    expect(chain.count("getEntries")).toBe(0);
  });

  it("skips a directory IPFS would shard, saying why, and keeps one just under the threshold", async () => {
    const chain = new FakeChain();
    const f = chain.addFile([te("x")]).cid;
    // Kubo's rule: the sum of name bytes plus 36 per entry, sharded when over 262,144. 901 × (255 + 36) = 262,191.
    const named = (n: number): DirectoryEntry[] =>
      Array.from({ length: n }, (_, i) => ({ name: `${String(i).padStart(5, "0")}${"n".repeat(250)}`, cid: f, isDirectory: false }));
    const over = chain.addDirectory(named(901));
    await expect(assessRoot({ id: 84532, contracts: chain.contracts, client: chain.client }, over, ProjectKind.Directory)).rejects.toThrow(
      /IPFS would shard \(link estimate 262191 bytes, over 262144\).*HAMT/,
    );
    const under = chain.addDirectory(named(900));
    await expect(assessRoot({ id: 84532, contracts: chain.contracts, client: chain.client }, under, ProjectKind.Directory)).resolves.toBeDefined();
  });
});
