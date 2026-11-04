/**
 * Docs drift guard: the numbers and interfaces the docs state, checked against the code they describe.
 *
 * Earlier docs said a chunk leaf holds 750 hashes (the code capped it at 512) and called a backend's functions
 * put/get (the contract has store/retrieve). Readers build against the docs, so a stale one is a bug. This checks the
 * storage-backend interface as the docs print it against the SDK's ABI (which `abi-drift.test.ts` checks against the
 * contract), and the leaf limits the docs state against the contract's constants and the SDK's packing cap.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { toFunctionSignature, type AbiFunction } from "viem";

import { storageBackendAbi } from "../src/abi.js";
import { CHUNK_LEAF_MAX_HASHES } from "../src/node-gas.js";

const ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** `function name(type a, type b, …)` lines of a Solidity block, as canonical signatures. */
function documentedSignatures(text: string, block: RegExp): string[] {
  const body = text.match(block)?.[1];
  if (!body) throw new Error(`no ${block} block`);
  return [...body.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)]
    .map(([, name, params]) => {
      const types = params!
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.split(/\s+/)[0]);
      return `${name}(${types.join(",")})`;
    })
    .sort();
}

const abiSignatures = (storageBackendAbi as readonly { type: string }[])
  .filter((x): x is AbiFunction => x.type === "function")
  .map((f) => toFunctionSignature(f))
  .sort();

/** A constant `name = <digits>` from a Solidity source, underscores allowed. */
function solidityConstant(path: string, name: string): number {
  const m = read(path).match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`));
  if (!m) throw new Error(`${name} not found in ${path}`);
  return Number(m[1]!.replaceAll("_", ""));
}

describe("docs agree with the code", () => {
  it("the storage-backend interface on the protocol page is the contract's", () => {
    const docs = documentedSignatures(
      read("site/content/docs/protocol/storage-backends.mdx"),
      /interface IStorageBackend \{([\s\S]*?)\n\}/,
    );
    expect(docs).toEqual(abiSignatures);
  });

  it("the storage-backend interface in the spec is the contract's", () => {
    const docs = documentedSignatures(read("specs/abx-fs.md"), /interface IStorageBackend \{([\s\S]*?)\n\}/);
    expect(docs).toEqual(abiSignatures);
  });

  it("the chunk-leaf limits the docs state are the contract's and the SDK's", () => {
    const maxData = solidityConstant("packages/contracts-core/src/utils/CodeStore.sol", "MAX_DATA");
    const stride = solidityConstant("packages/contracts-core/src/FileStore.sol", "_LEAF_STRIDE");
    // A leaf is `0x00 ‖ (chunkId:32 ‖ size:6) × n` inside one node.
    const contractMax = Math.floor((maxData - 1) / stride);
    expect(contractMax).toBe(646);

    const protocol = read("site/content/docs/protocol/index.mdx");
    expect(protocol).toContain(`1 to ${contractMax} \`(chunkId, size)\` records of ${stride} bytes`);
    expect(protocol).toContain(`The SDK\n    packs at most ${CHUNK_LEAF_MAX_HASHES}`);

    const spec = read("specs/abx-fs.md");
    expect(spec).toContain(`\`1 ≤ n ≤ ${contractMax}\``);
    expect(spec).toContain(`${CHUNK_LEAF_MAX_HASHES} records (the contracts accept ${contractMax})`);
  });

  it("no doc repeats the old numbers or names", () => {
    for (const path of ["site/content/docs/protocol/index.mdx", "site/content/docs/protocol/storage-backends.mdx"]) {
      const text = read(path);
      expect(text).not.toMatch(/\b750\b/);
      expect(text).not.toMatch(/\b(put|get)\s*\(/);
    }
  });
});
