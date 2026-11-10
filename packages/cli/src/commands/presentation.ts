import { Command } from "commander";
import { bytesToHex, keccak256, type Hex } from "viem";
import {
  PresentationLock, PresentationMethod, PresentationSelection, PresentationStatus,
  recommendPresentationMethod, ZERO_HASH, type PresentationTarget,
} from "@artblocks/abxfs-sdk";
import { parseTokenId, parsePositiveInt } from "../args.js";
import { createOrgClient } from "../client.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { redact } from "../redact.js";
import { safe } from "../text.js";
import { confirmWrite } from "../write-plan.js";

type Options = {
  projectId: string; chain?: string; org?: string; json?: boolean; dryRun?: boolean; yes?: boolean;
  latest?: boolean; version?: string; tag?: string; path?: string;
  chainBase?: string; ipfsBase?: string; expectedCommitment?: string;
};
type Client = Awaited<ReturnType<typeof createOrgClient>>;

export function parsePresentationMethod(value: string): PresentationMethod | "auto" {
  switch (value.toLowerCase()) {
    case "auto": return "auto";
    case "chain-gateway": return PresentationMethod.ChainGateway;
    case "embedded": return PresentationMethod.Embedded;
    case "ipfs": return PresentationMethod.Ipfs;
    default: throw new Error("method must be auto, chain-gateway, embedded, or ipfs");
  }
}
export function parsePresentationLocks(value: string): number {
  const names: Record<string, number> = { content: PresentationLock.Content, method: PresentationLock.Method, endpoints: PresentationLock.Endpoints };
  return value.split(",").reduce((mask, name) => {
    const bit = names[name.trim().toLowerCase()];
    if (!bit) throw new Error("locks must be a comma-separated list of content, method, endpoints");
    return mask | bit;
  }, 0);
}
function command(name: string, description: string, write = false): Command {
  const cmd = new Command(name).description(description)
    .requiredOption("--project-id <id>", "project token id")
    .option("-c, --chain <name>", "network")
    .option("--org <address>", "project org (else ABXFS_ORG or configured org)")
    .option("--json", "emit a single JSON result; confirmations go to stderr");
  if (write) cmd.option("--dry-run", "show the proposed change without a signer or transaction")
    .option("--yes", "confirm the printed write plan without asking");
  return cmd;
}
async function context(opts: Options, write = false) {
  const tokenId = parseTokenId("--project-id", opts.projectId);
  const chain = resolveChain(loadConfig(), opts.chain);
  const org = requireOrg(chain, opts.org);
  const client = await createOrgClient(chain, { org, write: write && !opts.dryRun });
  return { tokenId, chain, org, client };
}
function stateOutput(state: Awaited<ReturnType<Client["inspectPresentation"]>>) {
  return {
    ...state,
    methodName: PresentationMethod[state.method], selectionName: PresentationSelection[state.selection],
    lockNames: Object.entries(PresentationLock).filter(([, bit]) => (state.locks & bit) !== 0).map(([name]) => name),
    targetError: state.targetError ? redact(state.targetError) : null,
  };
}
function emit(opts: Options, value: unknown): void {
  const text = JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, opts.json ? undefined : 2);
  console.log(opts.json ? text : safe(text));
}
function source(ctx: Awaited<ReturnType<typeof context>>) {
  return { chainId: ctx.chain.chainId, org: ctx.org, tokenId: ctx.tokenId.toString(), factory: ctx.client.addresses.orgFactory,
    presentation: ctx.client.addresses.projectPresentation };
}
async function change(opts: Options, action: string, lockMask: number, proposed: unknown,
  send: (client: Client, tokenId: bigint) => Promise<Hex>, permanent: string[] = [], reviewed?: Awaited<ReturnType<Client["inspectPresentation"]>>) {
  const ctx = await context(opts, true);
  const before = reviewed ?? await ctx.client.inspectPresentation(ctx.tokenId);
  if ((before.locks & lockMask) !== 0) throw new Error(`${action} is permanently locked; there is no force override`);
  const plan = { action, source: source(ctx), before: stateOutput(before), proposed, permanent };
  if (opts.dryRun) { emit(opts, { ok: true, dryRun: true, ...plan }); return; }
  const confirmed = await confirmWrite(ctx.client, {
    action, chainId: ctx.chain.chainId, org: ctx.org,
    steps: [{ what: action, txs: 1, gas: 300_000 }], permanent,
    warnings: ["presentation gas is a planning allowance; the RPC estimates the actual transaction"],
  }, { yes: opts.yes, stderr: opts.json });
  if (!confirmed) { emit(opts, { ok: true, cancelled: true, ...plan }); return; }
  const txHash = await send(ctx.client, ctx.tokenId);
  emit(opts, { ok: true, ...plan, txHash, after: stateOutput(await ctx.client.inspectPresentation(ctx.tokenId)) });
}
export function presentationCommand(): Command {
  const group = new Command("presentation").description("Inspect and configure generation-specific project presentation");
  group.addCommand(command("inspect", "Read the exact selected source, method, endpoints and immutable locks")
    .action(async (opts: Options) => {
      const ctx = await context(opts);
      const inspected = await ctx.client.inspectPresentation(ctx.tokenId);
      const recommendation = inspected.root
        ? await recommendPresentationMethod(ctx.client.publicClient, ctx.client.addresses, inspected.root, inspected.path) : null;
      emit(opts, { ok: true, source: source(ctx), ...stateOutput(inspected),
        reason: recommendation ? redact(recommendation.reason) : inspected.targetError ? redact(inspected.targetError) : "unresolved target",
        recommendation: recommendation ? { ...recommendation, reason: redact(recommendation.reason) } : null });
    }));
  group.addCommand(command("preview", "Preview the selected content and its render status without signing")
    .action(async (opts: Options) => {
      const ctx = await context(opts);
      const preview = await ctx.client.previewPresentation(ctx.tokenId);
      const { bytes, recommendation, ...state } = preview;
      emit(opts, { ok: true, source: source(ctx), ...stateOutput(state), status: preview.status,
        statusName: PresentationStatus[preview.status], contentType: preview.contentType, bytesHex: bytesToHex(bytes),
        residualDependencies: preview.residualDependencies, runtimeUncertain: preview.runtimeUncertain,
        recommendation: recommendation ? { ...recommendation, reason: redact(recommendation.reason) } : null });
    }));
  group.addCommand(command("set-target", "Select latest, an exact version, or a movable tag and optional path", true)
    .option("--latest", "follow the latest version")
    .option("--version <number>", "select this version")
    .option("--tag <name>", "follow this tag")
    .option("--path <path>", "path in the selected directory (empty for its index.html or a file root)", "")
    .action(async (opts: Options) => {
      if (Number(opts.latest === true) + Number(opts.version !== undefined) + Number(opts.tag !== undefined) !== 1)
        throw new Error("choose exactly one of --latest, --version, or --tag");
      const target: PresentationTarget = opts.version !== undefined
        ? { selection: PresentationSelection.Version, version: parsePositiveInt("--version", opts.version), path: opts.path ?? "" }
        : opts.tag !== undefined ? { selection: PresentationSelection.Tag, tag: opts.tag, path: opts.path ?? "" }
          : { selection: PresentationSelection.Latest, path: opts.path ?? "" };
      await change(opts, "set presentation target", PresentationLock.Content, target,
        (client, id) => client.configurePresentationTarget(id, target));
    }));
  group.addCommand(command("set-method", "Choose auto, chain-gateway, embedded, or explicit ipfs", true)
    .argument("<method>")
    .action(async (value: string, opts: Options) => {
      const requested = parsePresentationMethod(value);
      const ctx = await context(opts);
      const inspected = await ctx.client.inspectPresentation(ctx.tokenId);
      if (!inspected.root && requested === "auto") throw new Error("auto requires a resolved presentation target");
      const recommendation = requested === "auto"
        ? await recommendPresentationMethod(ctx.client.publicClient, ctx.client.addresses, inspected.root!, inspected.path) : null;
      const method = recommendation?.method ?? requested as PresentationMethod;
      await change(opts, "set presentation method", PresentationLock.Method,
        { requested, method, methodName: PresentationMethod[method], reason: recommendation ? redact(recommendation.reason) : "explicit selection",
          residualDependencies: recommendation?.residualDependencies ?? [], runtimeUncertain: recommendation?.runtimeUncertain ?? null },
        (client, id) => client.setPresentationMethod(id, method));
    }));
  group.addCommand(command("set-endpoints", "Set explicit chain and IPFS gateway base URLs", true)
    .requiredOption("--chain-base <url>", "chain gateway base URL")
    .requiredOption("--ipfs-base <url>", "IPFS gateway base URL")
    .action(async (opts: Options) => {
      const endpoints = { chainBase: opts.chainBase!, ipfsBase: opts.ipfsBase! };
      await change(opts, "set presentation endpoints", PresentationLock.Endpoints, endpoints,
        (client, id) => client.setPresentationEndpoints(id, endpoints));
    }));
  group.addCommand(command("lock", "Permanently lock content, method and/or endpoints; cannot be undone", true)
    .argument("<locks>", "comma-separated content,method,endpoints")
    .option("--expected-commitment <hash>", "exact commitment from the reviewed lock dry-run")
    .action(async (value: string, opts: Options) => {
      const mask = parsePresentationLocks(value);
      const ctx = await context(opts);
      const preview = await ctx.client.previewPresentation(ctx.tokenId);
      const commitment = await ctx.client.readPresentationLockCommitment(ctx.tokenId, mask, preview.blockNumber);
      if (opts.expectedCommitment && (!/^0x[0-9a-fA-F]{64}$/.test(opts.expectedCommitment) ||
        opts.expectedCommitment.toLowerCase() === ZERO_HASH || opts.expectedCommitment.toLowerCase() !== commitment.toLowerCase()))
        throw new Error("--expected-commitment does not match the reviewed settings; run lock --dry-run and review again");
      if (!opts.dryRun && !opts.expectedCommitment)
        throw new Error("lock requires --expected-commitment from a reviewed lock --dry-run");
      const expectedCommitment = (opts.expectedCommitment ?? commitment) as Hex;
      const { bytes, recommendation, ...state } = preview;
      const review = { ...stateOutput(state), statusName: PresentationStatus[preview.status],
        payloadBytes: bytes.length, payloadHash: keccak256(bytes),
        recommendation: recommendation ? { ...recommendation, reason: redact(recommendation.reason) } : null };
      await change(opts, "lock presentation", 0, { mask, expectedCommitment, review },
        (client, id) => client.lockPresentation(id, mask, expectedCommitment),
        ["selected presentation locks are permanent for all future owners; no force bypass exists",
          ...((mask & PresentationLock.Content) ? [`content freezes the reviewed root ${preview.root} and path ${preview.path}; later versions and tag moves cannot change it`] : []),
          ...(preview.status !== PresentationStatus.Ready ? ["the current presentation is not Ready; locking content and method may preserve an unusable display"] : [])], preview);
    }));
  return group;
}
