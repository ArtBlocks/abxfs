#!/usr/bin/env node
/**
 * Verify one deployed generation, without changing the canonical registry.
 * node scripts/verify-sources.mjs <chainId> [sourcify|etherscan|blockscout|both]
 *   [--addresses <deployment-bundle.json>] [--source-root <frozen checkout>]
 *
 * Default addresses come from the built SDK; an explicit bundle supports candidate qualification
 * before registration. Read renderer/companion addresses and constructor arguments from deployed
 * contracts, checking immutable wiring. Old factories require their exact original source checkout;
 * today's seven-argument factory source cannot verify an immutable six-argument generation.
 *
 * Build the SDK and selected source checkout's contracts first. Both means Sourcify plus the chain's
 * explorer (Blockscout for Robinhood, Etherscan otherwise). Only Etherscan needs ETHERSCAN_API_KEY.
 * RPCs use ABXFS_RPC_URL_<chainId>, else registry metadata. No transactions are broadcast. Exit
 * nonzero unless every requested contract/verifier succeeds (Sourcify requires exact_match).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFactorySource, explorerFor, forgeVerificationArgs, sourcePackage, verificationInventory, verificationComplete } from "./verification-plan.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const { CANONICAL_DEPLOYMENTS } = await import(pathToFileURL(resolve(ROOT, "packages/sdk/dist/index.js")).href);
const chainId = Number(process.argv[2]);
const rest = process.argv.slice(3);
const which = rest[0] && !rest[0].startsWith("--") ? rest.shift() : "both";
let addressFile;
let sourceRoot = ROOT;
while (rest.length) {
  const flag = rest.shift();
  const value = rest.shift();
  if (!value || !["--addresses", "--source-root"].includes(flag)) throw new Error("expected --addresses <JSON file> or --source-root <frozen checkout>");
  if (flag === "--addresses") addressFile = value;
  else sourceRoot = resolve(value);
}
if (!Number.isInteger(chainId) || !["sourcify", "etherscan", "blockscout", "both"].includes(which)) {
  throw new Error("usage: node scripts/verify-sources.mjs <chainId> [sourcify|etherscan|blockscout|both] [--addresses <JSON file>] [--source-root <frozen checkout>]");
}
const deployment = CANONICAL_DEPLOYMENTS[chainId];
if (!deployment) throw new Error(`chain ${chainId} is not in the SDK network registry`);
// An explicit bundle permits qualification before canonical registration, including metadata-only chains.
const a = addressFile ? JSON.parse(readFileSync(addressFile, "utf8")) : deployment.addresses;
if (!a) throw new Error(`chain ${chainId} has no verified deployment; supply --addresses for an explicit candidate bundle`);
const explorer = explorerFor(chainId);
const verifiers = which === "both" ? ["sourcify", explorer.verifier] : [which];
if (verifiers.includes("blockscout") && explorer.verifier !== "blockscout") throw new Error("no Blockscout verifier configured for this chain");
const apiKey = process.env.ETHERSCAN_API_KEY;
if (verifiers.includes("etherscan") && !apiKey) throw new Error("ETHERSCAN_API_KEY is not set");
const rpc = process.env[`ABXFS_RPC_URL_${chainId}`] || deployment.publicRpc[0];
const cast = (...args) => {
  try { return execFileSync("cast", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`cast ${args[0]} failed; inspect the RPC locally (credentials omitted)`); }
};
if (Number(cast("chain-id", "--rpc-url", rpc)) !== chainId) throw new Error("RPC chain id differs from requested verification chain");
const readAddress = (to, getter) => cast("call", to, `${getter}()(address)`, "--rpc-url", rpc);
const readString = (to, getter) => JSON.parse(cast("call", to, `${getter}()(string)`, "--rpc-url", rpc));
const same = (x, y) => x?.toLowerCase() === y?.toLowerCase();
const check = (to, getter, expected) => {
  if (!expected || !same(readAddress(to, getter), expected)) throw new Error(`deployment wiring mismatch: ${getter}()`);
};
const links = readAddress(a.orgMeta, "links");
const card = readAddress(a.orgFactory, "card");
const traits = readAddress(a.orgFactory, "traits");
const abx = readAddress(a.orgFactory, "abx");
const renderer = readAddress(a.orgFactory, "metadataRenderer");
const seed = readAddress(a.orgFactory, "seedSource");
const gatewayBase = readString(a.orgMeta, "gatewayBase");
for (const [getter, expected] of [["hook", a.projectHook], ["enumeration", a.projectEnumeration], ["minter", a.orgMinter], ["orgMeta", a.orgMeta], ["links", links]]) check(a.orgFactory, getter, expected);
check(a.directoryStore, "fileStore", a.fileStore);
check(a.fileStore, "chunkStore", a.chunkStore);
let presentation;
try { presentation = readAddress(a.orgFactory, "presentation"); } catch { /* Legacy factories have no presentation getter. */ }
if (a.projectPresentation && !same(presentation, a.projectPresentation)) throw new Error("factory presentation differs from deployment bundle");
let reader;
let resolver;
let defaultChainBase;
if (presentation) {
  reader = readAddress(presentation, "reader");
  resolver = readAddress(presentation, "ipfsResolver");
  defaultChainBase = readString(presentation, "defaultChainBase");
  if (a.contentReader && !same(reader, a.contentReader)) throw new Error("reader differs from deployment bundle");
  for (const target of [reader, presentation, resolver]) {
    check(target, "fileStore", a.fileStore);
    check(target, "directoryStore", a.directoryStore);
  }
  if (defaultChainBase !== gatewayBase) throw new Error("presentation and OrgMeta gateway defaults differ");
}
const contracts = verificationInventory(a, { links, card, traits, abx, renderer, seed, gatewayBase, presentation, reader, resolver, defaultChainBase });
// Never submit today's seven-argument source for an immutable six-argument factory (or vice versa).
const factoryAbi = JSON.parse(execFileSync("forge", ["inspect", "src/OrgFactory.sol:OrgFactory", "abi", "--json"], {
  cwd: sourcePackage(sourceRoot, "contracts-projects"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}));
assertFactorySource(factoryAbi, Boolean(presentation));
for (const [, contract, address] of contracts) {
  if (cast("code", address, "--rpc-url", rpc) === "0x") throw new Error(`no deployed code for ${contract} at ${address}`);
}

async function status(verifier, address) {
  // A status read that fails (a dropped connection, a rate limit) counts as not verified yet: the next round asks again.
  try {
    if (verifier === "sourcify") {
      const r = await (await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`)).json();
      return r.match ?? "not verified";
    }
    const base = verifier === "blockscout" ? explorer.url : "https://api.etherscan.io/v2/api";
    const url = new URL(base);
    for (const [key, value] of Object.entries({ chainid: String(chainId), module: "contract", action: "getsourcecode", address })) url.searchParams.set(key, value);
    if (verifier === "etherscan") url.searchParams.set("apikey", apiKey);
    const r = await (await fetch(url)).json();
    return Array.isArray(r.result) && r.result[0]?.ContractName ? "verified" : "not verified";
  } catch {
    return "not verified";
  } finally {
    if (verifier === "etherscan") await new Promise((s) => setTimeout(s, 400)); // the free tier answers 3 calls a second
  }
}

for (const verifier of verifiers) {
  for (const [pkg, contract, address, ctor] of contracts) {
    if (verificationComplete(verifier, await status(verifier, address))) continue;
    console.log(`${verifier}: submitting ${contract} at ${address}`);
    const args = forgeVerificationArgs(chainId, verifier, contract, address, ctor.length ? cast("abi-encode", ...ctor) : undefined);
    // forge 1.4.3 submits to Etherscan whenever ETHERSCAN_API_KEY is set, whatever `--verifier` says.
    const env = { ...process.env };
    if (verifier !== "etherscan") delete env.ETHERSCAN_API_KEY;
    try {
      execFileSync("forge", args, { cwd: sourcePackage(sourceRoot, pkg), env, stdio: ["ignore", "ignore", "inherit"] });
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
      if (!verificationComplete(verifier, s)) left.push(`${verifier}: ${contract} at ${address}: ${s}`);
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
