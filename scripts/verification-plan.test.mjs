import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { assertFactorySource, explorerFor, forgeVerificationArgs, sourcePackage, verificationInventory, verificationComplete } from "./verification-plan.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const a = Object.fromEntries(["chunkStore", "sstore2Backend", "fastLzBackend", "fileStore", "directoryStore", "ipfsCidResolver", "orgMeta", "orgFactory", "projectHook", "projectEnumeration", "orgMinter", "lens"].map((key, i) => [key, address(i + 1)]));
const d = { links: address(21), card: address(22), traits: address(23), abx: address(24), renderer: address(25), seed: address(26), gatewayBase: "https://fs.abx.io" };
const candidate = { ...d, presentation: address(27), reader: address(28), resolver: a.ipfsCidResolver, defaultChainBase: "https://fs.abx.io" };
const abi = (count) => [{ type: "constructor", inputs: Array.from({ length: count }, () => ({ type: "address" })) }];

test("candidate inventory contains exact seven-argument factory and companion constructor ordering", () => {
  const inventory = verificationInventory(a, candidate);
  assert.equal(inventory.length, 17);
  const ctor = (name) => inventory.find(([, contract]) => contract.endsWith(`:${name}`))[3];
  assert.deepEqual(ctor("OrgFactory"), ["constructor(address,address,address,address,address,address,address)", d.abx, d.renderer, d.seed, a.directoryStore, a.fileStore, a.orgMeta, candidate.presentation]);
  assert.deepEqual(ctor("ContentReader"), ["constructor(address,address)", a.directoryStore, a.fileStore]);
  assert.deepEqual(ctor("ProjectPresentation"), ["constructor(address,address,string)", candidate.reader, a.ipfsCidResolver, candidate.defaultChainBase]);
  assert.deepEqual(ctor("IpfsCidResolver"), ["constructor(address,address)", a.fileStore, a.directoryStore]);
  assert.equal(new Set(inventory.map(([, , addr]) => addr)).size, 17);
  assert.equal(a.projectPresentation, undefined, "planning never registers candidate capability");
});

test("legacy inventory remains six-argument and refuses mismatched source before submission", () => {
  const inventory = verificationInventory(a, d);
  assert.equal(inventory.length, 15);
  assert.equal(inventory.find(([, c]) => c.endsWith(":OrgFactory"))[3].length, 7);
  assert.doesNotThrow(() => assertFactorySource(abi(6), false));
  assert.doesNotThrow(() => assertFactorySource(abi(7), true));
  assert.throws(() => assertFactorySource(abi(7), false), /exact frozen checkout/);
  assert.throws(() => assertFactorySource(abi(6), true), /7 address constructor/);
  const wrongTypes = abi(7); wrongTypes[0].inputs[0].type = "bytes32";
  assert.throws(() => assertFactorySource(wrongTypes, true), /does not match/);
});

test("candidate inventory rejects missing reader and mismatched resolver", () => {
  assert.throws(() => verificationInventory(a, { ...candidate, reader: undefined }), /ContentReader/);
  assert.throws(() => verificationInventory(a, { ...candidate, resolver: address(99) }), /resolver differs/);
});

test("all eight chains route to the supported explorer, with explicit Blockscout URLs", () => {
  for (const chain of [1, 8453, 84532, 11155111, 42161, 421614]) assert.equal(explorerFor(chain).verifier, "etherscan");
  for (const [chain, url] of [[4663, "https://robinhoodchain.blockscout.com/api/"], [46630, "https://explorer.testnet.chain.robinhood.com/api/"]]) {
    assert.deepEqual(explorerFor(chain), { verifier: "blockscout", url });
    assert.deepEqual(forgeVerificationArgs(chain, "blockscout", "src/OrgFactory.sol:OrgFactory", a.orgFactory, "0x1234"), ["verify-contract", a.orgFactory, "src/OrgFactory.sol:OrgFactory", "--chain", String(chain), "--verifier", "blockscout", "--verifier-url", url, "--constructor-args", "0x1234"]);
  }
  assert.throws(() => forgeVerificationArgs(8453, "blockscout", "X", address(1)), /no Blockscout/);
});

test("source-root selects the frozen checkout for every contract package", () => {
  for (const pkg of ["contracts-core", "contracts-companion", "contracts-projects"]) {
    assert.equal(sourcePackage("/tmp/frozen-generation", pkg), resolve("/tmp/frozen-generation", "packages", pkg));
  }
  assert.throws(() => sourcePackage("/tmp/frozen-generation", "../../other"), /unknown contract package/);
});

test("partial source matches are resubmitted and never satisfy exact verification", () => {
  for (const status of ["partial_match", "match", "not verified", "verified", null])
    assert.equal(verificationComplete("sourcify", status), false);
  assert.equal(verificationComplete("sourcify", "exact_match"), true);
  for (const verifier of ["etherscan", "blockscout"]) {
    assert.equal(verificationComplete(verifier, "verified"), true);
    assert.equal(verificationComplete(verifier, "not verified"), false);
  }
});
