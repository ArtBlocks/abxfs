import { lstatSync } from "node:fs";
import { basename } from "node:path";

import { Command } from "commander";
import kleur from "kleur";
import type { Address, Hex } from "viem";

import {
  autoRegisterNodeCodecs,
  codecName,
  defaultOrgName,
  gasScheduleForChain,
  assertValidPublishInputs,
  orgGenerations,
  PresentationSelection,
  PresentationLock,
  PresentationMethod,
  PublishedPartialError,
  type PresentationPlan,
  readOrgsAdministeredAcrossGenerations,
  readOrgsHeld,
  type AbxfsCid,
  type FileCodec,
  type FileDescriptor,
  type PublishProgress,
  type UploadResult,
} from "@artblocks/abxfs-sdk";

import { parsePresentationMethod } from "./presentation.js";
import { parsePositiveInt, parseTokenId } from "../args.js";
import { createClient } from "../client.js";
import { FASTLZ_HELP, resolveContentOptions } from "../codec.js";
import { loadConfig, requireOrg, resolveChain, resolveOrg, type ChainConfig } from "../config.js";
import { assertNotSymlink, scanDirectoryReport } from "../fsscan.js";
import { loadSingleFile, scanTreeForUpload, validateAllowPublicGlob } from "../scan-guard.js";
import { describeStage, summarizeUpload, type UploadSummary } from "../plan-summary.js";
import { withMintRecovery } from "../recover.js";
import { printProjectLinks, printRootLink } from "../links.js";
import { CliRefusal, redact } from "../redact.js";
import { safe, shellArg, txHash } from "../text.js";
import { confirmWrite, describeOrg, estimateCreateOrgGas, WRITE_GAS, type WriteStep } from "../write-plan.js";

import { jsonAction, type Report } from "../json-action.js";
import { publicationPresentation } from "../publication-presentation.js";

type Kind = "file" | "directory" | "auto";

type Client = ReturnType<typeof createClient>;

/** The `--allow-public` help text, shared by `upload` and `update`. */
export const ALLOW_PUBLIC_HELP =
  "approve ONE secret-looking file, or a glob that NAMES it (a bare * / ** / *.* is refused). Repeatable. Uploads are " +
  "public and permanent; any hit no glob names stops the run";

export interface UploadOpts {
  name?: string;
  projectId?: string;
  chain?: string;
  org?: string;
  codec?: string;
  fastlz?: boolean;
  tag?: string;
  kind?: string;
  dryRun?: boolean;
  includeHidden?: boolean;
  /** Always set: commander's default for `--allow-public` is `[]`. */
  allowPublic: string[];
  maxBundleGas?: string;
  yes?: boolean;
  presentation?: string;
  presentationPath?: string;
  json?: boolean;
}

export function uploadCommand(): Command {
  return new Command("upload")
    .description(
      "Upload a directory or single file to ABX FS, optionally minting a project token for it",
    )
    .argument("<path>", "local directory or file to upload")
    .option("-n, --name <name>", "project name — mints a project token and publishes to it")
    .option(
      "--project-id <id>",
      "publish into an EXISTING project token instead of minting a new one",
    )
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option(
      "--org <address>",
      "the org to mint the project in (defaults only use the current factory: ABXFS_ORG, configured org, then newest administered org; " +
        "if you administer none, a personal org is created for you)",
    )
    .option("--codec <codec>", "file codec, decoded off chain by readers: none|gzip (defaults to the chain's defaultCodec, else none)")
    .option("--fastlz", FASTLZ_HELP)
    .option("--no-fastlz", "store every chunk raw instead of through the FastLZ backend where it shrinks them")
    .option(
      "--tag <tag>",
      "tag the published version (requires --name or --project-id; 'latest' is reserved)",
    )
    .option(
      "--kind <kind>",
      "force file|directory (defaults to auto-detect from local FS)",
    )
    .option("--presentation <method>", "presentation: auto|chain-gateway|embedded|ipfs (new projects default to auto; existing projects keep their method)")
    .option("--presentation-path <path>", "explicit file entrypoint; empty selects the root")
    .option("--json", "one structured result; progress is printed to stderr")
    .option("--dry-run", "compute CIDs and the plan only; no transactions (needs no --yes)")
    .option("--include-hidden", "include dotfiles and dot-directories (skipped by default, except .well-known)")
    .option("--allow-public <glob>", ALLOW_PUBLIC_HELP, collectAllowPublic, [] as string[])
    .option(
      "--max-bundle-gas <gas>",
      "max estimated gas per multicall bundle, a positive whole number, counted as the chain's per-transaction cap counts it " +
        "(all gas, or only execution gas under EIP-8037); defaults to the chain's defaultBundleGasBudget, else 12000000",
    )
    .option("--yes", "send without asking (the plan is still printed). Required when there is no terminal to confirm on")
    .action(async (path: string, opts: UploadOpts) => jsonAction(opts.json, async (report) => {
      // Everything that can be checked offline is checked FIRST: a bad tag, name, id, kind or gas budget must not be
      // found after content was uploaded and a project minted.
      assertValidPublishInputs({ tag: opts.tag, name: opts.name });
      if (opts.presentation !== undefined) parsePresentationMethod(opts.presentation);
      if ((opts.presentation !== undefined || opts.presentationPath !== undefined) && !opts.name && opts.projectId === undefined) throw new Error("--presentation requires --name or --project-id");
      if (opts.tag && !opts.name && !opts.projectId) {
        throw new Error("--tag requires --name or --project-id (a tag points at a version of a project)");
      }
      const projectId = opts.projectId !== undefined ? parseTokenId("--project-id", opts.projectId) : undefined;
      const maxBundleGasFlag = opts.maxBundleGas !== undefined ? parsePositiveInt("--max-bundle-gas", opts.maxBundleGas) : undefined;
      const requestedKind = parseKind(opts.kind);

      await autoRegisterNodeCodecs();
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      // Keep recovery on the selected network even when it came from env/config defaults.
      const chainName = opts.chain ?? (process.env["ABXFS_CHAIN"]?.trim() || undefined)
        ?? cfg.defaultChain ?? Object.keys(cfg.chains)[0]!;
      const client = createClient(chain, { write: !opts.dryRun });

      const { codec, fastLz } = resolveContentOptions(chain, opts);
      const maxBundleGas = maxBundleGasFlag ?? chain.defaultBundleGasBudget;
      const gas = maxBundleGas !== undefined ? { maxBundleGas } : {};
      const kind = resolveKind(path, requestedKind, opts.kind);

      // The content, read and checked (symlinks, hidden files, secrets) before anything else happens.
      let file: FileDescriptor | undefined;
      let files: FileDescriptor[] = [];
      let emptyDirectories: string[] = [];
      if (kind === "file") {
        file = await loadSingleFile(path, { allowPublic: opts.allowPublic });
        files = [file];
        console.log(kleur.cyan("→"), `uploading single file ${safe(file.path)} (file-kind project)`);
      } else {
        ({ files, emptyDirectories } = await scanTreeForUpload(path, {
          includeHidden: opts.includeHidden === true,
          allowPublic: opts.allowPublic,
        }));
        if (files.length === 0 && emptyDirectories.length === 0) throw new Error(`nothing to upload in ${safe(path)}`);
        console.log(
          kleur.cyan("→"),
          `uploading ${files.length} file(s)` +
            (emptyDirectories.length > 0 ? ` and ${emptyDirectories.length} empty director${emptyDirectories.length === 1 ? "y" : "ies"}` : "") +
            ` from ${safe(path)} (directory-kind project)`,
        );
      }

      // Offline preflight (no transaction): throws PlanTooLargeError naming the folder or file that would need more
      // node levels than the protocol allows (or one node above a single transaction's gas). Before any org is
      // created, token minted or byte uploaded.
      const preflight = file
        ? await client.uploadFile(file, { codec, fastLz, dryRun: true })
        : await client.planUpload(files, { codec, fastLz, emptyDirectories });
      const summary = await summarizeUpload({
        addresses: client.addresses,
        files,
        ...(file ? { asFile: true } : { emptyDirectories }),
        codec,
        fastLz,
        maxBundleGas,
        gasSchedule: gasScheduleForChain(chain.chainId),
      });

      if (opts.dryRun) {
        const org = projectId !== undefined ? requireOrg(chain, opts.org) : resolveOrg(chain, opts.org);
        const bound = org ? await client.resolveOrg(org) : client;
        const presentation = opts.name || projectId !== undefined ? await publicationPresentation(bound, projectId, {
          root: preflight.rootCid, files, rootIsDirectory: !file, codec, emptyDirectories,
          ...(opts.presentation !== undefined ? { method: parsePresentationMethod(opts.presentation) } : {}),
          ...(opts.presentationPath !== undefined ? { path: opts.presentationPath } : {}),
        }) : undefined;
        report({ outcome: "planned", dryRun: true, chainId: chain.chainId, org, tokenId: projectId, contentMode: "snapshot",
          root: preflight.rootCid, summary, presentation });
        console.log(kleur.yellow("dry-run:"), "root =", preflight.rootCid, kleur.gray(file ? "(file)" : "(directory)"));
        if (!file) for (const f of (preflight as { files: Array<{ cid: string; path: string }> }).files) console.log("  ", f.cid, safe(f.path));
        printSummary(summary);
        if (opts.name || projectId !== undefined) printProjectSteps(summary, opts, projectId);
        return;
      }

      // Where the project goes, and whether this account may put it there: read only, BEFORE anything is paid for.
      // The content is the expensive part, and an account that may not mint into the org would otherwise pay for the
      // whole upload and only then learn it cannot use it.
      const target = opts.name || projectId !== undefined ? await planTarget(client, chain, opts, projectId) : undefined;
      const presentationClient = target?.org ? await client.resolveOrg(target.org) : client;
      const presentationSupported = Boolean(presentationClient.addresses.projectPresentation);
      const presentationPlan = target ? await publicationPresentation(presentationClient, projectId, {
        root: preflight.rootCid, files, rootIsDirectory: !file, codec, emptyDirectories,
        ...(opts.presentation !== undefined ? { method: parsePresentationMethod(opts.presentation) } : {}),
        ...(opts.presentationPath !== undefined ? { path: opts.presentationPath } : {}),
      }) : undefined;
      report({ chainId: chain.chainId, org: target?.org, tokenId: projectId, root: preflight.rootCid,
        contentMode: "snapshot", presentation: presentationPlan, phase: "review" });

      const steps: WriteStep[] = [];
      const permanent: string[] = [];
      if (target?.createOrgName !== undefined) {
        const est = await estimateCreateOrgGas(client, { name: target.createOrgName, description: "" });
        steps.push({
          what: "create your personal org and mint its first project to you" + (est.estimated ? "" : " (gas: at most)"),
          txs: 1,
          gas: est.gas,
          scheduled: est.estimated,
        });
        permanent.push(`a new org named "${safe(target.createOrgName)}" (the name is fixed for life), administered by you`);
      }
      steps.push({
        what: `store the content (${summary.files} file(s), ${summary.directories} director${summary.directories === 1 ? "y" : "ies"})`,
        txs: summary.txs,
        gas: summary.estimatedGas,
        upTo: true,
        scheduled: true,
      });
      permanent.push(
        `the content: ${summary.files} file(s), ${(summary.storedBytes / 1024).toFixed(0)} KiB stored. It is PUBLIC, and it can never be deleted`,
      );
      if (target) {
        if (target.mint) {
          steps.push({ what: "mint a new project token to you", txs: 1, gas: WRITE_GAS.mint });
          permanent.push("a new project token in the org, held by you");
        }
        steps.push({ what: "publish the root as the project's next version", txs: 1, gas: WRITE_GAS.publish });
        permanent.push(
          `the version: the root is appended to ${projectId !== undefined ? `project #${projectId}` : "the project"}'s history for good`,
        );
        if (opts.tag) steps.push({ what: `point tag "${safe(opts.tag)}" at it (a tag can be moved later)`, txs: 1, gas: WRITE_GAS.setTag });
        if (presentationPlan?.configureTarget || presentationPlan?.configureMethod)
          steps.push({ what: "configure the reviewed presentation target/method (Auto never selects IPFS)",
            txs: Number(presentationPlan.configureTarget) + Number(presentationPlan.configureMethod), gas: 600_000 });
        if (opts.name) steps.push({ what: `set the project's name to "${safe(opts.name)}" (it can be renamed later)`, txs: 1, gas: WRITE_GAS.setName });
      }
      const ok = await confirmWrite(
        client,
        {
          action: target
            ? `upload ${safe(path)} and publish it ${projectId !== undefined ? `to project #${projectId}` : "as a new project"}`
            : `upload ${safe(path)} (content only: no project)`,
          chainId: chain.chainId,
          ...(target ? { org: target.orgLabel } : {}),
          steps,
          permanent,
        },
        { yes: opts.yes },
      );
      if (!ok) { report({ outcome: "cancelled" }); return; }

      // What a recovery command must reproduce: every choice that decides the root, resolved, and the root itself.
      const recoveryOpts = projectId === undefined && target && presentationSupported
        ? { ...opts, presentation: opts.presentation ?? "auto" } : opts;
      const recovery = recoveryCommand(path, recoveryOpts, { codec, fastLz, kind, maxBundleGas, root: preflight.rootCid });
      const resolved = target ? await executeTarget(client, target, recovery) : undefined;

      console.log(kleur.gray("  large uploads are many transactions; if one is interrupted, run the same command again: what is already on chain is skipped"));
      const onFileUploaded = (f: { path: string; chunkIds: unknown[] }) =>
        console.log(kleur.gray("•"), safe(f.path), kleur.gray(`(${f.chunkIds.length} chunk${f.chunkIds.length === 1 ? "" : "s"})`));
      const result = file
        ? await client.uploadFile(file, { codec, fastLz, ...gas, onProgress, onFileUploaded })
        : await client.upload(files, { codec, fastLz, emptyDirectories, ...gas, onProgress, onFileUploaded });
      console.log(kleur.green("✓"), file ? "file root:" : "root directory:", result.rootCid);
      report({ root: result.rootCid, contentTxHashes: result.txHashes, phase: "content-stored" });
      await maybeCreateProject(client, result, opts, resolved, projectId, recovery, { name: chainName, chainId: chain.chainId }, presentationPlan, report);
      if (!resolved) await printRootLink(client, chain.chainId, result.rootCid);
    }));
}

/** One line per content transaction: stage, progress in the stage and overall, and the gas model's estimate. */
function onProgress(e: PublishProgress): void {
  console.log(
    kleur.gray("·"),
    describeStage(e).padEnd(22),
    `${e.stageCallsDone}/${e.stageCallsTotal}`.padStart(9),
    kleur.gray(`tx ${e.txsDone}/${e.txsTotal}`),
    kleur.gray(`~${e.estimatedGas.toLocaleString()} gas`),
    kleur.gray(txHash(e.txHash)),
  );
}

function printSummary(s: UploadSummary): void {
  console.log(
    kleur.yellow("dry-run:"),
    `${s.files} file(s), ${s.directories} director${s.directories === 1 ? "y" : "ies"}, ${s.uniqueChunks} chunk(s) ` +
      `(${(s.storedBytes / 1024).toFixed(0)} KiB stored), ${s.chunkNodes} chunk node(s), ${s.entryNodes} entry node(s)`,
  );
  for (const st of s.stages) {
    console.log(
      "  ",
      describeStage(st).padEnd(22),
      `${st.calls} call(s) in ${st.txs} tx`.padEnd(24),
      kleur.gray(`~${st.estimatedGas.toLocaleString()} gas`),
    );
  }
  console.log(
    kleur.yellow("dry-run:"),
    `up to ${s.txs} transaction(s), ~${s.estimatedGas.toLocaleString()} gas estimated`,
    kleur.gray("(assumes nothing exists on chain yet; content already stored is skipped, so re-running an interrupted upload resumes where it stopped)"),
  );
}

/**
 * The project transactions a real run adds after the content, which the dry run does not plan: choosing or creating
 * the org needs the account, so both possibilities are named. The real run prints the exact plan before sending.
 */
function printProjectSteps(s: UploadSummary, opts: UploadOpts, projectId: bigint | undefined): void {
  const lines: [string, number | undefined][] = [];
  if (projectId === undefined) {
    if (opts.org) lines.push(["mint a new project token into the org", WRITE_GAS.mint]);
    else {
      lines.push(["create your personal org and mint its first project (when you administer no org yet; gas estimated when sent)", undefined]);
      lines.push(["  or mint a new project token into your newest org", WRITE_GAS.mint]);
    }
  }
  lines.push(["publish the root as the project's next version", WRITE_GAS.publish]);
  if (opts.tag) lines.push([`point tag "${safe(opts.tag)}" at it`, WRITE_GAS.setTag]);
  if (opts.name) lines.push([`set the project's name to "${safe(opts.name)}"`, WRITE_GAS.setName]);
  console.log(kleur.yellow("dry-run:"), "then, to publish it as a project:");
  for (const [what, gas] of lines) {
    console.log("  ", `${what.startsWith("  or") ? "" : "1 × "}${what}`.padEnd(70), gas === undefined ? "" : kleur.gray(`~${gas.toLocaleString()} gas`));
  }
  const txs = s.txs + lines.filter(([what]) => !what.startsWith("  or")).length;
  console.log(kleur.yellow("dry-run:"), `in all, up to ${txs} transaction(s); the real run plans them against your account and shows the cost before sending`);
}

/** A shell-quoted argument for a command the CLI prints for the user to run: its exact characters ({@link shellArg}). */
const sh = shellArg;

/** What the upload was run with that decides its root, resolved (flags over the chain's config), and the root. */
export interface RootChoices {
  codec: FileCodec;
  fastLz: boolean;
  kind: "file" | "directory";
  maxBundleGas: number | undefined;
  root: AbxfsCid;
}

/** What finishes an upload whose mint (or org creation) was sent but had not confirmed: a command, and its root. */
export interface Recovery {
  /** The command, for an org and a project id (placeholders such as `<id>` until the transaction confirms). */
  command: (org: string, id: string) => string;
  /** The root it must publish. */
  root: AbxfsCid;
}

/**
 * The command that publishes this upload into a project whose mint (or org creation) was sent but had not
 * confirmed: the same upload with `--project-id`, which never mints. `<org>` and `<id>` are left for the user, from
 * the transaction once it confirms.
 *
 * It must give the SAME root, because what it publishes is permanent: so it carries every choice that decides the
 * root, resolved rather than as typed (a codec or FastLZ default from the config is written out, so a config edited
 * in between cannot change it), every `--allow-public` (without them the run stops, or a prompt answered differently
 * drops a file), and the root it must produce is printed with it. The command is printed on a line of its own, as it
 * was built (`formatCliError`): never through `redact`, which would cut a path such as `mysite.com/build`. Every
 * argument is quoted with its exact characters ({@link shellArg}): a control, bidi or Unicode-space character in a
 * path is written as `$'\xHH'` escapes rather than passed through `safe()`, which made the pasted command name a
 * different path.
 *
 * Exported for tests: the upload calls it only for a mint, which `--name` is required for, so a command without
 * `--name` is reached only from a test.
 */
export function recoveryCommand(path: string, opts: UploadOpts, choices: RootChoices): Recovery {
  const codec = codecName(choices.codec) ?? "none";
  const command = (org: string, id: string) =>
    [
      "abxfs upload",
      sh(path),
      ...(opts.chain ? ["--chain", sh(opts.chain)] : []),
      "--org",
      org,
      "--project-id",
      id,
      "--kind",
      choices.kind,
      "--codec",
      sh(codec),
      choices.fastLz ? "--fastlz" : "--no-fastlz",
      ...(opts.includeHidden ? ["--include-hidden"] : []),
      ...opts.allowPublic.flatMap((g) => ["--allow-public", sh(g)]),
      ...(choices.maxBundleGas !== undefined ? ["--max-bundle-gas", String(choices.maxBundleGas)] : []),
      ...(opts.tag ? ["--tag", sh(opts.tag)] : []),
      ...(opts.name ? ["--name", sh(opts.name)] : []),
      ...(opts.presentation ? ["--presentation", sh(opts.presentation)] : []),
      ...(opts.presentationPath !== undefined ? ["--presentation-path", sh(opts.presentationPath)] : []),
    ].join(" ");
  return { command, root: choices.root };
}

/** What the recovery message says about the command printed under it. */
function rootNote(recovery: Recovery): string {
  return `It must publish root ${recovery.root}; it is the same upload, so what is on chain is skipped.`;
}

/** Where the project goes, decided by reads only. */
interface TargetPlan {
  /** The org, or undefined when a personal org will be created first. */
  org: Address | undefined;
  /** How the org is printed: `"Name" 0x…`, or the org that will be created. */
  orgLabel: string;
  /** Set when no org is configured and the account administers none: the personal org's name. */
  createOrgName?: string;
  /** A project token is minted into an existing org (no `--project-id`). */
  mint: boolean;
}

/** Where the project went, once {@link executeTarget} ran. */
interface Target {
  org: Address;
  orgLabel: string;
  orgClient: Client;
  /** Set when the org was just created, and already minted us its first project. */
  firstTokenId: bigint | undefined;
}

/**
 * Where a project goes, and whether this account may put it there. Reads only; called before any content is
 * uploaded and before the confirmation, so the plan the user confirms names the org.
 *
 * With `--project-id` the org must be named, because token ids repeat across orgs, and the account must hold the
 * token. Otherwise the org is `--org` / `ABXFS_ORG` / the chain's `org`, else the newest org the account
 * ADMINISTERS, else a personal org created for it. An org where the account only HOLDS a project is never chosen
 * implicitly: anyone can mint a project into your wallet from an open org of theirs, and that must not decide where
 * your next project goes.
 */
async function planTarget(client: Client, chain: ChainConfig, opts: UploadOpts, projectId: bigint | undefined): Promise<TargetPlan> {
  if (projectId !== undefined) {
    const org = requireOrg(chain, opts.org);
    // Before a byte of content is paid for: the account must hold this token, because the publish that
    // ends the upload is authorized by `ownerOf` alone.
    await (await client.resolveOrg(org)).assertCanPublish(projectId);
    return { org, orgLabel: await describeOrg(client, org), mint: false };
  }

  const account = client.walletClient?.account?.address;
  if (!account) throw new Error("no account to mint with — set ABXFS_PRIVATE_KEY");
  let org = resolveOrg(chain, opts.org);
  // Configured orgs are remembered defaults, not permission to silently mint into an old generation.
  if (org && !opts.org) {
    const remembered = await client.resolveOrg(org);
    if (remembered.addresses.orgFactory?.toLowerCase() !== client.registry.orgFactory?.toLowerCase()) org = undefined;
  }
  if (!org) {
    // "You administer no org" must be a fact read from chain, never a read that failed: it leads to a paid, permanent
    // org creation. It is read from the factories' administered lists alone: the held list is never used to choose
    // (anyone can mint into a wallet from an open org), so a failed read of it must not stop the choice either.
    const { orgs: mine, failed, failedGenerations, truncated } = await readOrgsAdministeredAcrossGenerations(
      client.publicClient,
      { ...client.registry, previousGenerations: [] },
      account,
    );
    const unread = [
      ...(failed.length > 0 ? [`${failed.length} org(s) you administer`] : []),
      ...(failedGenerations.length > 0 ? [`the list of orgs you administer from ${failedGenerations.length} org factory(ies) (${failedGenerations.join(", ")})`] : []),
    ];
    if (unread.length > 0) {
      throw new Error(
        `could not read ${unread.join(", or ")}; pass --org or retry. Nothing was uploaded (without them it is not ` +
          "known which org you administer, and a new one would be created).",
      );
    }
    if (truncated) {
      throw new Error("you administer more orgs than one read returns (2,000 per factory), so the newest is not known; pass --org. Nothing was uploaded.");
    }
    const administered = mine[0];
    if (!administered) {
      const name = defaultOrgName(account);
      const others = await heldOrgCount(client, account);
      console.log(
        kleur.cyan("→"),
        `you administer no org on this chain, so a personal org "${safe(name)}" will be created for this project` +
          (others !== undefined && others > 0
            ? `. You hold projects in ${others} org(s) run by others; those are never used without --org`
            : ""),
      );
      return { org: undefined, orgLabel: `a new personal org "${safe(name)}", administered by you`, createOrgName: name, mint: false };
    }
    org = administered.org;
    console.log(kleur.gray(`  no --org given: using the newest org you administer, "${safe(administered.name)}" ${administered.org} (current factory)`));
  }
  if (!(await (await client.resolveOrg(org)).mayMint(account))) {
    throw new Error(
      `${account} may not mint into org ${org}. It is admin-only unless the admin opens it. Nothing was uploaded.`,
    );
  }
  return { org, orgLabel: await describeOrg(client, org), mint: true };
}

/**
 * How many orgs the account holds a project in, for the note that they are never used: best effort, and undefined
 * when any generation's held list could not be read (that list never decides anything, so its failure stops nothing).
 */
async function heldOrgCount(client: Client, account: Address): Promise<number | undefined> {
  try {
    let n = 0;
    for (const g of orgGenerations(client.registry)) {
      if (g.projectEnumeration) n += (await readOrgsHeld(client.publicClient, g.projectEnumeration, account)).length;
    }
    return n;
  } catch {
    return undefined;
  }
}

/** Carry out the one write {@link planTarget} may have planned: creating the personal org. */
async function executeTarget(client: Client, plan: TargetPlan, recovery: Recovery): Promise<Target> {
  if (plan.createOrgName === undefined) {
    // An org named by the user may predate the current factory, so its own generation is found first.
    return { org: plan.org!, orgLabel: plan.orgLabel, orgClient: await client.resolveOrg(plan.org!), firstTokenId: undefined };
  }
  const name = plan.createOrgName;
  console.log(kleur.cyan("→"), `creating your personal org "${safe(name)}"`);
  const created = await withMintRecovery({
    what: "creating your org",
    send: (onSent) => client.createOrg({ name, onSent }),
    recover: (hash) => client.recoverCreateOrg(hash),
    fromRecovered: (r, hash) => ({ org: r.org, firstTokenId: r.tokenId, txHash: hash }),
    whenConfirmed:
      "Once it confirms, `abxfs org list` shows the new org, and the command below publishes the upload into its first " +
      `project (put the new org's address in place of <the new org>). ${rootNote(recovery)}`,
    command: recovery.command("<the new org>", "0"),
  });
  const orgLabel = `"${safe(name)}" ${created.org}`;
  console.log(kleur.green("✓"), `org created: ${orgLabel}`, kleur.gray(txHash(created.txHash)));
  // Created a moment ago in this process, by the current factory: bound without a lookup.
  return { org: created.org, orgLabel, orgClient: client.forOrg(created.org), firstTokenId: created.firstTokenId };
}

/**
 * Turn a freshly uploaded root into a project.
 *
 * A project IS an ABX token in an org, so this MINTS one through the org's minter, then writes the
 * root and the name as PostParams on it. Three transactions, and the split is what lets the same
 * publish path target a token you already own or bought.
 *
 * `--project-id` skips the mint and publishes into an existing token.
 */
async function maybeCreateProject(
  client: Client,
  result: UploadResult,
  opts: UploadOpts,
  target: Target | undefined,
  projectId: bigint | undefined,
  recovery: Recovery,
  network: { name: string; chainId: number },
  presentationPlan?: PresentationPlan,
  report: Report = () => {},
): Promise<void> {
  if (result.txHashes.length > 0) {
    console.log(kleur.gray(`  ${result.txHashes.length} content transaction(s) sent`));
  }

  if (!target) {
    // Content-only upload. The root is already addressable at /g/cid/<chain>/<root> whether or not a token
    // ever points at it, so this is a complete outcome rather than a half-finished one.
    console.log(
      kleur.gray("  no --name or --project-id — content is stored and addressable by CID"),
    );
    return;
  }

  const { org, orgLabel, orgClient } = target;
  let tokenId: bigint;
  if (projectId !== undefined) {
    tokenId = projectId;
  } else if (target.firstTokenId !== undefined) {
    // A just-created org already minted its first project to us. Publish into that, rather than
    // minting a second and leaving an empty one behind.
    tokenId = target.firstTokenId;
    console.log(kleur.gray(`  publishing into the org's first project #${tokenId}`));
  } else {
    const account = client.walletClient?.account?.address;
    const minted = await withMintRecovery({
      what: "the mint",
      send: (onSent) => orgClient.mintProject({ onSent }),
      recover: (hash) => orgClient.recoverMint(hash, account ? { holder: account } : {}),
      fromRecovered: (r, hash) => ({ tokenId: r.tokenId, txHash: hash }),
      whenConfirmed:
        "Once it confirms, the new project's id is in the transaction's Transfer event, and the command below publishes " +
        `the upload into it (put that id in place of <id>). ${rootNote(recovery)}`,
      command: recovery.command(org, "<id>"),
    });
    tokenId = minted.tokenId;
    console.log(kleur.green("✓"), "project minted:", `#${tokenId}`, kleur.gray(`in org ${orgLabel}`), kleur.gray(txHash(minted.txHash)));
  }

  // The ONE publish-and-tag implementation (SDK `publishRootAndTag`). It counts before publishing
  // (aborting if it cannot), takes the version from the receipt, proves `versionAt(v).cid` is the
  // root just published, and only then tags. Do not reintroduce a CLI-local copy: two copies is how
  // this race was fixed in one place and left in another.
  report({ org, tokenId, phase: "publishing" });
  const published = await orgClient.publishAndTag(tokenId, result.rootCid, opts.tag ? { tag: opts.tag } : {});
  report({ published: true, outcome: "published", org, tokenId, root: result.rootCid,
    publishTxHash: published.publishTxHash, versionNumber: published.versionNumber, phase: "published" });
  console.log(
    kleur.green("✓"),
    `${result.rootKind === "file" ? "file " : ""}version published to project`,
    `#${tokenId}`,
    `in org ${orgLabel}`,
    `as v${published.versionNumber}`,
    kleur.gray(txHash(published.publishTxHash)),
  );

  if (opts.tag) {
    console.log(
      kleur.green("✓"),
      `tag "${safe(opts.tag)}" → v${published.versionNumber} on project #${tokenId} in org ${orgLabel}`,
      kleur.gray(txHash(published.tagTxHash)),
    );
  }

  let finalPresentationHash = published.tagTxHash ?? published.publishTxHash;
  if (opts.name) {
    report({ phase: "setting-name" });
    let nameTxHash: Hex | undefined;
    try {
      nameTxHash = await orgClient.setProjectName(tokenId, opts.name);
      finalPresentationHash = nameTxHash;
      report({ nameTxHash });
      console.log(kleur.green("✓"), `name set: "${safe(opts.name)}" on project #${tokenId} in org ${orgLabel}`, kleur.gray(txHash(nameTxHash)));
    } catch (error) {
      throw new PublishedPartialError("setting-name", { root: result.rootCid, org, tokenId,
        publishTxHash: published.publishTxHash, versionNumber: published.versionNumber,
        ...(published.tagTxHash ? { tagTxHash: published.tagTxHash } : {}), ...(nameTxHash ? { nameTxHash } : {}),
        txHashes: [...result.txHashes, published.publishTxHash, ...(published.tagTxHash ? [published.tagTxHash] : [])] }, error);
    }
  }

  if (presentationPlan && (presentationPlan.configureTarget || presentationPlan.configureMethod)) {
    let phase = "set-target";
    let targetConfigured = !presentationPlan.configureTarget;
    let methodConfigured = !presentationPlan.configureMethod;
    const recoveryMethod = presentationPlan.method === PresentationMethod.Embedded ? "embedded"
      : presentationPlan.method === PresentationMethod.Ipfs ? "ipfs" : "chain-gateway";
    const phases: { phase: string; txHash: string }[] = [];
    try {
      if (!targetConfigured) {
        const txHash = await orgClient.configurePresentationTarget(tokenId, presentationPlan.target);
        targetConfigured = true; finalPresentationHash = txHash; phases.push({ phase, txHash }); report({ phases });
      }
      phase = "set-method";
      if (!methodConfigured) {
        const txHash = await orgClient.setPresentationMethod(tokenId, presentationPlan.method);
        methodConfigured = true; finalPresentationHash = txHash; phases.push({ phase, txHash }); report({ phases });
      }
      phase = "inspect-result";
      const presentation = await orgClient.inspectPresentation(tokenId);
      report({ presentation, phases, phase: "completed" });
      console.log(kleur.green("✓"), "presentation:", safe(JSON.stringify({ ...presentation,
        targetError: presentation.targetError ? redact(presentation.targetError) : null,
        reason: presentationPlan.reason, residualDependencies: presentationPlan.residualDependencies, runtimeUncertain: presentationPlan.runtimeUncertain })));
    } catch (error) {
      const flags = `--project-id ${tokenId} --org ${org} --chain ${sh(network.name)}`;
      const target = presentationPlan.target;
      const selection = target.selection === PresentationSelection.Version ? `--version ${target.version}`
        : target.selection === PresentationSelection.Tag ? `--tag ${sh(target.tag)}` : "--latest";
      const commands = [
        ...(!targetConfigured ? [`abxfs presentation set-target ${selection} --path ${sh(presentationPlan.path)} ${flags}`] : []),
        ...(!methodConfigured ? [`abxfs presentation set-method ${sh(recoveryMethod)} ${flags}`] : []),
        `abxfs presentation inspect ${flags}`,
      ];
      report({ phase, phases, retryPublish: false });
      throw new UploadPresentationError({ org, tokenId, root: result.rootCid, chainId: network.chainId, phase }, commands.join(" && "), error);
    }
  }
  if (presentationPlan) {
    const completeMetadata = await orgClient.verifyPresentationTokenUri(tokenId, { afterTransactionHash: finalPresentationHash });
    report({ completeMetadata });
    if (!completeMetadata.ok) {
      const flags = `--project-id ${tokenId} --org ${org} --chain ${sh(network.name)}`;
      const recovery = [`abxfs presentation preview ${flags}`, `abxfs presentation set-method chain-gateway ${flags}`];
      report({ outcome: "published_warning", warning: redact(completeMetadata.reason), retryPublish: false, recovery });
      console.warn(kleur.yellow("!"), `Published successfully; ${redact(completeMetadata.reason)}. Do not publish this root again.`);
      for (const command of recovery) console.warn(command);
    }
  }
  await printProjectLinks(orgClient, tokenId);
}

/** Publication already succeeded; recovery must never mint or publish that root again. */
export class UploadPresentationError extends CliRefusal {
  readonly recoveryCommand: string;
  readonly org: Address;
  readonly tokenId: bigint;
  readonly root: AbxfsCid;
  readonly chainId: number;
  readonly phase: string;

  constructor(state: { org: Address; tokenId: bigint; root: AbxfsCid; chainId: number; phase: string }, command: string, cause: unknown) {
    super(`Root ${state.root} is already published to project #${state.tokenId} in org ${state.org} on chain ${state.chainId}. ` +
      `Presentation setup stopped during ${state.phase}: ${redact(cause instanceof Error ? cause.message : String(cause))}. ` +
      "Do NOT rerun the original upload --name command: it would mint another project. Run the presentation-only recovery command below.");
    this.name = "UploadPresentationError";
    this.cause = cause;
    this.org = state.org;
    this.tokenId = state.tokenId;
    this.root = state.root;
    this.chainId = state.chainId;
    this.phase = state.phase;
    this.recoveryCommand = command;
  }
}

/** `--kind`, validated before any work: `file`, `directory` or `auto` (the default). */
function parseKind(override: string | undefined): Kind {
  const requested: Kind = override == null ? "auto" : (override.toLowerCase() as Kind);
  if (requested !== "auto" && requested !== "file" && requested !== "directory") {
    throw new Error(`--kind must be one of: file, directory, auto (got "${safe(override)}")`);
  }
  return requested;
}

function resolveKind(path: string, requested: Kind, raw: string | undefined): "file" | "directory" {
  // lstat, not stat: a root that is a symlink is refused rather than silently followed.
  assertNotSymlink(path);
  const stat = lstatSync(path);
  const detected: "file" | "directory" = stat.isDirectory() ? "directory" : "file";
  if (requested === "auto") return detected;
  if (requested !== detected) {
    throw new Error(
      `--kind=${safe(raw)} but local path "${safe(path)}" is a ${detected}; remove --kind to auto-detect or fix the path`,
    );
  }
  return detected;
}

/** Accumulator for `--allow-public`: a pattern that names nothing is refused at parse time, before any work. */
export function collectAllowPublic(value: string, previous: string[]): string[] {
  try {
    validateAllowPublicGlob(value);
  } catch (e) {
    // Show what the refused pattern WOULD have approved: the path being uploaded is on the command line
    // (this runs while the options are parsed, before the action sees it). Best effort; never masks the refusal.
    const files = candidateUploadFiles();
    if (files) validateAllowPublicGlob(value, files);
    throw e;
  }
  return [...previous, value];
}

/** The relative paths of the first existing file or directory named on the command line, or undefined. */
function candidateUploadFiles(): string[] | undefined {
  for (const a of process.argv.slice(3)) {
    if (a.startsWith("-")) continue;
    try {
      const st = lstatSync(a);
      if (st.isDirectory()) return scanDirectoryReport(a, {}).files.map((f) => f.path);
      if (st.isFile()) return [basename(a)];
    } catch {
      /* not a path, or unreadable: keep looking */
    }
  }
  return undefined;
}
