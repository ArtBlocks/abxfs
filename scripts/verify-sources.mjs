#!/usr/bin/env node
/**
 * Publish the source of every deployed ABX FS contract on one chain: on Sourcify and on the chain's Etherscan explorer.
 *
 *   node scripts/verify-sources.mjs <chainId> [sourcify|etherscan|both]      (default: both)
 *
 * The addresses come from the SDK registry (`pnpm --filter @artblocks/abxfs-sdk build` first). The three it does not list (the
 * card, the traits renderer and the links renderer) and the factory's ABX arguments are read from the deployed
 * contracts, so no address here is entered by hand.
 *
 * Build the contracts first (`pnpm build:contracts`): forge submits the local sources, and the build keeps solc's
 * metadata hash, so only the exact frozen source text matches. Sourcify then reports `exact_match`. A contract already
 * verified is skipped, so a rerun finishes what an earlier one left.
 *
 * Etherscan needs ETHERSCAN_API_KEY; one key covers every chain. Reads use ABXFS_RPC_URL_<chainId> when it is set, else
 * the registry's first public endpoint. It exits non-zero unless every contract ends verified on every verifier asked
 * for.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const { requireCanonicalDeployment } = await import(pathToFileURL(resolve(ROOT, "packages/sdk/dist/index.js")).href);

const chainId = Number(process.argv[2]);
const which = process.argv[3] ?? "both";
if (!Number.isInteger(chainId) || !["sourcify", "etherscan", "both"].includes(which)) {
  console.error("usage: node scripts/verify-sources.mjs <chainId> [sourcify|etherscan|both]");
  process.exit(2);
}
const verifiers = which === "both" ? ["sourcify", "etherscan"] : [which];
const apiKey = process.env.ETHERSCAN_API_KEY;
if (verifiers.includes("etherscan") && !apiKey) {
  console.error("ETHERSCAN_API_KEY is not set");
  process.exit(2);
}

const deployment = requireCanonicalDeployment(chainId);
const a = deployment.addresses;
const rpc = process.env[`ABXFS_RPC_URL_${chainId}`] || deployment.publicRpc[0];

const cast = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const readAddress = (to, getter) => cast("call", to, `${getter}()(address)`, "--rpc-url", rpc);
const same = (x, y) => x.toLowerCase() === y.toLowerCase();

// What the registry does not list, read from the contracts that hold it; and what it does list, checked against them.
const links = readAddress(a.orgMeta, "links");
const card = readAddress(a.orgFactory, "card");
const traits = readAddress(a.orgFactory, "traits");
const abx = readAddress(a.orgFactory, "abx");
const renderer = readAddress(a.orgFactory, "metadataRenderer");
const seed = readAddress(a.orgFactory, "seedSource");
const gatewayBase = JSON.parse(cast("call", a.orgMeta, "gatewayBase()(string)", "--rpc-url", rpc));
for (const [getter, expected] of [
  ["hook", a.projectHook],
  ["enumeration", a.projectEnumeration],
  ["minter", a.orgMinter],
  ["orgMeta", a.orgMeta],
  ["links", links],
]) {
  const got = readAddress(a.orgFactory, getter);
  if (!same(got, expected)) throw new Error(`the factory's ${getter}() is ${got}, the registry says ${expected}`);
}

// [package, contract, address, constructor signature and arguments]
const contracts = [
  ["contracts-core", "src/ChunkStore.sol:ChunkStore", a.chunkStore, []],
  ["contracts-core", "src/backends/Sstore2Backend.sol:Sstore2Backend", a.sstore2Backend, []],
  ["contracts-core", "src/backends/FastLzSstore2Backend.sol:FastLzSstore2Backend", a.fastLzBackend, []],
  ["contracts-core", "src/FileStore.sol:FileStore", a.fileStore, ["constructor(address)", a.chunkStore]],
  ["contracts-core", "src/DirectoryStore.sol:DirectoryStore", a.directoryStore, ["constructor(address)", a.fileStore]],
  [
    "contracts-companion",
    "src/IpfsCidResolver.sol:IpfsCidResolver",
    a.ipfsCidResolver,
    ["constructor(address,address)", a.fileStore, a.directoryStore],
  ],
  ["contracts-projects", "src/OrgMeta.sol:OrgMeta", a.orgMeta, ["constructor(string)", gatewayBase]],
  ["contracts-projects", "src/ProjectLinks.sol:ProjectLinks", links, ["constructor(string)", gatewayBase]],
  [
    "contracts-projects",
    "src/OrgFactory.sol:OrgFactory",
    a.orgFactory,
    ["constructor(address,address,address,address,address,address)", abx, renderer, seed, a.directoryStore, a.fileStore, a.orgMeta],
  ],
  [
    "contracts-projects",
    "src/ProjectHook.sol:ProjectHook",
    a.projectHook,
    ["constructor(address,address,address)", a.directoryStore, a.fileStore, a.orgFactory],
  ],
  ["contracts-projects", "src/ProjectEnumeration.sol:ProjectEnumeration", a.projectEnumeration, ["constructor(address)", a.orgFactory]],
  ["contracts-projects", "src/OrgMinter.sol:OrgMinter", a.orgMinter, ["constructor(address)", a.orgFactory]],
  ["contracts-projects", "src/ProjectCard.sol:ProjectCard", card, ["constructor(address)", a.projectHook]],
  ["contracts-projects", "src/ProjectTraits.sol:ProjectTraits", traits, ["constructor(address)", a.projectHook]],
  ["contracts-projects", "src/Lens.sol:Lens", a.lens, ["constructor(address,address)", a.orgFactory, a.projectHook]],
];

async function status(verifier, address) {
  // A status read that fails (a dropped connection, a rate limit) counts as not verified yet: the next round asks again.
  try {
    if (verifier === "sourcify") {
      const r = await (await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`)).json();
      return r.match ?? "not verified";
    }
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}`;
    const r = await (await fetch(`${url}&apikey=${apiKey}`)).json();
    return Array.isArray(r.result) && r.result[0]?.ContractName ? "verified" : "not verified";
  } catch {
    return "not verified";
  } finally {
    if (verifier === "etherscan") await new Promise((s) => setTimeout(s, 400)); // the free tier answers 3 calls a second
  }
}

for (const verifier of verifiers) {
  for (const [pkg, contract, address, ctor] of contracts) {
    if ((await status(verifier, address)) !== "not verified") continue;
    console.log(`${verifier}: submitting ${contract} at ${address}`);
    const args = ["verify-contract", address, contract, "--chain", String(chainId), "--verifier", verifier];
    if (ctor.length) args.push("--constructor-args", cast("abi-encode", ...ctor));
    // forge 1.4.3 submits to Etherscan whenever ETHERSCAN_API_KEY is set, whatever `--verifier` says.
    const env = { ...process.env };
    if (verifier !== "etherscan") delete env.ETHERSCAN_API_KEY;
    try {
      execFileSync("forge", args, { cwd: resolve(ROOT, "packages", pkg), env, stdio: ["ignore", "ignore", "inherit"] });
    } catch {
      console.log(`${verifier}: the submission of ${contract} failed`);
    }
  }
}

// Etherscan queues a submission, sometimes for minutes: wait for every contract to read verified, or report what did not.
// A Sourcify match short of `exact_match` means the submitted source text differs from what was deployed.
let left = [];
for (let round = 0; round < 40; round++) {
  left = [];
  for (const verifier of verifiers) {
    for (const [, contract, address] of contracts) {
      const s = await status(verifier, address);
      if (s !== "verified" && s !== "exact_match") left.push(`${verifier}: ${contract} at ${address}: ${s}`);
    }
  }
  if (left.every((l) => !l.endsWith(": not verified"))) break;
  await new Promise((s) => setTimeout(s, 15_000));
}
if (left.length) {
  console.log(`chain ${chainId}, not verified exactly:\n  ${left.join("\n  ")}`);
  process.exit(1);
}
console.log(`chain ${chainId}: all ${contracts.length} contracts verified on ${verifiers.join(" and ")}`);
