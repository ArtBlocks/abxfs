/**
 * ABI drift guard — compares the viem-compatible ABI constants in
 * `src/abi*.ts` against the authoritative Solidity interfaces via `forge inspect`.
 *
 * This closes the gap where a contract interface could be renamed, reordered, or have
 * its parameter types changed and the SDK would continue to compile+test (because the
 * SDK tests ran against the *wrong* ABI paired with a contract that happens to accept
 * the encoded calldata anyway). The check works entirely on canonical function /
 * event / error signatures — order-insensitive, `internalType`-insensitive.
 *
 * If this test fails after a contract change, update `src/abi.ts` (or `src/abi-hook.ts`) to match.
 *
 * NOT covered here: the ABX collection's own param ABI. That comes from `@artblocks/abx-sdk/abi`
 * rather than being hand-maintained, so there is nothing local for it to drift from — an ABX
 * version bump moves it through the dependency, not through this file.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  type AbiEvent,
  type AbiFunction,
  type Abi,
  toEventSignature,
  toFunctionSignature,
} from "viem";

/** viem does not re-export abitype's `AbiError`; this is the same member of the `Abi` union. */
type AbiError = Extract<Abi[number], { type: "error" }>;

import * as abi from "../src/abi.js";
import * as abiHook from "../src/abi-hook.js";
import * as abiEnum from "../src/abi-enumeration.js";
import * as abiOrg from "../src/abi-org.js";

/** The hook ABI lives in its own module, so look constants up across both. */
const ABI_CONSTANTS = { ...abi, ...abiHook, ...abiEnum, ...abiOrg };

interface Target {
  constName: keyof typeof ABI_CONSTANTS;
  contractPackage: "contracts-core" | "contracts-companion" | "contracts-projects";
  interfacePath: string; // e.g. "src/interfaces/IChunkStore.sol:IChunkStore"
}

const TARGETS: Target[] = [
  {
    constName: "storageBackendAbi",
    contractPackage: "contracts-core",
    interfacePath: "src/interfaces/IStorageBackend.sol:IStorageBackend",
  },
  {
    // The stores are mirrored from their contracts: their views and errors ARE the surface.
    constName: "chunkStoreAbi",
    contractPackage: "contracts-core",
    interfacePath: "src/ChunkStore.sol:ChunkStore",
  },
  {
    constName: "fileStoreAbi",
    contractPackage: "contracts-core",
    interfacePath: "src/FileStore.sol:FileStore",
  },
  {
    constName: "directoryStoreAbi",
    contractPackage: "contracts-core",
    interfacePath: "src/DirectoryStore.sol:DirectoryStore",
  },
  {
    constName: "iProjectHookAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/interfaces/IProjectHook.sol:IProjectHook",
  },
  {
    // Mirrored from the contract, not an interface: the views ARE its surface.
    constName: "iProjectEnumerationAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/ProjectEnumeration.sol:ProjectEnumeration",
  },
  {
    constName: "iOrgFactoryAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/interfaces/IOrgFactory.sol:IOrgFactory",
  },
  {
    // The minter and the lens are mirrored from their contracts: their functions ARE their surface.
    constName: "orgMinterAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/OrgMinter.sol:OrgMinter",
  },
  {
    constName: "lensAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/Lens.sol:Lens",
  },
  {
    // `OrgMeta` and the links renderer it deploys are mirrored from their contracts: a token's links are read there.
    constName: "orgMetaAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/OrgMeta.sol:OrgMeta",
  },
  {
    constName: "projectLinksAbi",
    contractPackage: "contracts-projects",
    interfacePath: "src/ProjectLinks.sol:ProjectLinks",
  },
  {
    constName: "iIpfsCidResolverAbi",
    contractPackage: "contracts-companion",
    interfacePath: "src/interfaces/IIpfsCidResolver.sol:IIpfsCidResolver",
  },
];

const REPO_ROOT = resolve(__dirname, "../../..");

function forgeAvailable(): boolean {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function forgeInspectAbi(pkg: string, interfacePath: string): Abi {
  const cwd = resolve(REPO_ROOT, "packages", pkg);
  if (!existsSync(cwd)) throw new Error(`package not found: ${cwd}`);
  const out = execFileSync("forge", ["inspect", interfacePath, "abi", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out) as Abi;
}

/**
 * Canonicalize an ABI to sorted buckets keyed by entry kind. `internalType` /
 * parameter-name differences are dropped.
 */
function canonicalize(input: Abi): {
  functions: string[];
  events: string[];
  errors: string[];
} {
  const functions: string[] = [];
  const events: string[] = [];
  const errors: string[] = [];
  for (const entry of input) {
    if (entry.type === "function") {
      const e = entry as AbiFunction;
      const sig = toFunctionSignature(e);
      const outs = e.outputs.map((o) => o.type).join(",");
      functions.push(`${sig} ${e.stateMutability} -> (${outs})`);
    } else if (entry.type === "event") {
      const e = entry as AbiEvent;
      const sig = toEventSignature(e);
      const indexed = e.inputs.map((i) => (i.indexed ? "1" : "0")).join("");
      events.push(`${sig}[indexed=${indexed}]${e.anonymous ? ",anon" : ""}`);
    } else if (entry.type === "error") {
      const e = entry as AbiError;
      const args = e.inputs.map((i) => i.type).join(",");
      errors.push(`${e.name}(${args})`);
    }
    // constructors / fallbacks / receives aren't in the hand-maintained TS ABIs — skip.
  }
  functions.sort();
  events.sort();
  errors.sort();
  return { functions, events, errors };
}

describe("ABI drift vs on-chain interfaces", () => {
  if (!forgeAvailable()) {
    it.skip("forge not on PATH — skipping ABI drift check", () => {});
    return;
  }

  for (const target of TARGETS) {
    it(`${target.constName} matches ${target.interfacePath}`, () => {
      const tsAbi = ABI_CONSTANTS[target.constName] as unknown as Abi;
      const solAbi = forgeInspectAbi(target.contractPackage, target.interfacePath);

      const ts = canonicalize(tsAbi);
      const sol = canonicalize(solAbi);

      // Policy:
      //   functions + events: strict — TS must exactly match the Solidity interface.
      //   errors: TS may declare a superset. Solidity errors are often defined on the
      //           implementation contract rather than the interface; the SDK includes them
      //           anyway so viem can decode reverts client-side. Only missing (Solidity
      //           has an error TS doesn't) counts as drift.
      const diff = {
        functionsMissingInTs: sol.functions.filter((s) => !ts.functions.includes(s)),
        functionsExtraInTs: ts.functions.filter((s) => !sol.functions.includes(s)),
        eventsMissingInTs: sol.events.filter((s) => !ts.events.includes(s)),
        eventsExtraInTs: ts.events.filter((s) => !sol.events.includes(s)),
        errorsMissingInTs: sol.errors.filter((s) => !ts.errors.includes(s)),
      };

      expect(
        diff,
        `ABI drift detected for ${target.constName}. ` +
          `Update packages/sdk/src/abi.ts to match ${target.interfacePath}.`,
      ).toEqual({
        functionsMissingInTs: [],
        functionsExtraInTs: [],
        eventsMissingInTs: [],
        eventsExtraInTs: [],
        errorsMissingInTs: [],
      });
    });
  }
});
