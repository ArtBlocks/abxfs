import { resolve } from "node:path";

/** Source-verification inventory and verifier routing; no RPC or submission side effects. */
export function explorerFor(chainId) {
  if (chainId === 4663) return { verifier: "blockscout", url: "https://robinhoodchain.blockscout.com/api/" };
  if (chainId === 46630) return { verifier: "blockscout", url: "https://explorer.testnet.chain.robinhood.com/api/" };
  return { verifier: "etherscan", url: "https://api.etherscan.io/v2/api" };
}

export function verificationInventory(a, discovered) {
  const { links, card, traits, abx, renderer, seed, gatewayBase, presentation, reader, resolver, defaultChainBase } = discovered;
  const item = (pkg, name, address, ctor = []) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || /^0x0{40}$/i.test(address))
      throw new Error(`missing or invalid deployment address for ${name}`);
    return [pkg, `src/${name}.sol:${name.split("/").at(-1)}`, address, ctor];
  };
  const factoryArgs = [abx, renderer, seed, a.directoryStore, a.fileStore, a.orgMeta];
  if (presentation) factoryArgs.push(presentation);
  const contracts = [
    item("contracts-core", "ChunkStore", a.chunkStore),
    item("contracts-core", "backends/Sstore2Backend", a.sstore2Backend),
    item("contracts-core", "backends/FastLzSstore2Backend", a.fastLzBackend),
    item("contracts-core", "FileStore", a.fileStore, ["constructor(address)", a.chunkStore]),
    item("contracts-core", "DirectoryStore", a.directoryStore, ["constructor(address)", a.fileStore]),
    item("contracts-companion", "IpfsCidResolver", a.ipfsCidResolver, ["constructor(address,address)", a.fileStore, a.directoryStore]),
    item("contracts-projects", "OrgMeta", a.orgMeta, ["constructor(string)", gatewayBase]),
    item("contracts-projects", "ProjectLinks", links, ["constructor(string)", gatewayBase]),
    item("contracts-projects", "OrgFactory", a.orgFactory, [`constructor(${factoryArgs.map(() => "address").join(",")})`, ...factoryArgs]),
    item("contracts-projects", "ProjectHook", a.projectHook, ["constructor(address,address,address)", a.directoryStore, a.fileStore, a.orgFactory]),
    item("contracts-projects", "ProjectEnumeration", a.projectEnumeration, ["constructor(address)", a.orgFactory]),
    item("contracts-projects", "OrgMinter", a.orgMinter, ["constructor(address)", a.orgFactory]),
    item("contracts-projects", "ProjectCard", card, ["constructor(address)", a.projectHook]),
    item("contracts-projects", "ProjectTraits", traits, ["constructor(address)", a.projectHook]),
    item("contracts-projects", "Lens", a.lens, ["constructor(address,address)", a.orgFactory, a.projectHook]),
  ];
  if (presentation) {
    if (resolver?.toLowerCase() !== a.ipfsCidResolver?.toLowerCase()) throw new Error("presentation resolver differs from deployment bundle");
    contracts.push(
      item("contracts-companion", "ContentReader", reader, ["constructor(address,address)", a.directoryStore, a.fileStore]),
      item("contracts-projects", "ProjectPresentation", presentation, ["constructor(address,address,string)", reader, resolver, defaultChainBase]),
    );
  }
  return contracts;
}

export function assertFactorySource(abi, hasPresentation) {
  const ctor = abi.find((entry) => entry.type === "constructor");
  const wanted = hasPresentation ? 7 : 6;
  if (ctor?.inputs?.length !== wanted || ctor.inputs.some((input) => input.type !== "address")) {
    throw new Error(`deployed factory requires ${wanted} address constructor arguments; local OrgFactory source does not match. Use --source-root with the exact frozen checkout for this generation`);
  }
}

export function forgeVerificationArgs(chainId, verifier, contract, address, constructorBytes) {
  const args = ["verify-contract", address, contract, "--chain", String(chainId), "--verifier", verifier];
  if (verifier === "blockscout") {
    const explorer = explorerFor(chainId);
    if (explorer.verifier !== "blockscout") throw new Error(`no Blockscout endpoint configured for chain ${chainId}`);
    args.push("--verifier-url", explorer.url);
  }
  if (constructorBytes) args.push("--constructor-args", constructorBytes);
  return args;
}

/** Every forge inspection/submission runs inside the explicitly selected frozen source checkout. */
export function sourcePackage(sourceRoot, pkg) {
  if (!["contracts-core", "contracts-companion", "contracts-projects"].includes(pkg)) throw new Error(`unknown contract package ${pkg}`);
  return resolve(sourceRoot, "packages", pkg);
}

/** Partial Sourcify matches must be resubmitted with the exact deployed sources. */
export function verificationComplete(verifier, status) {
  return verifier === "sourcify" ? status === "exact_match" : status === "verified";
}
