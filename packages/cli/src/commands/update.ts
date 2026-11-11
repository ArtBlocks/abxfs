import { lstatSync } from "node:fs";

import { Command } from "commander";
import kleur from "kleur";

import {
  autoRegisterNodeCodecs,
  gasScheduleForChain,
  ProjectKind,
  PresentationStatus,
  projectKindName,
  assertValidPublishInputs,
  type DraftOp,
  type FileDescriptor,
} from "@artblocks/abxfs-sdk";

import { parsePositiveInt, parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { FASTLZ_HELP, resolveContentOptions } from "../codec.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { assertNotSymlink } from "../fsscan.js";
import { summarizeUpload } from "../plan-summary.js";
import { loadSingleFile, scanTreeForUpload } from "../scan-guard.js";
import { printProjectLinks } from "../links.js";
import { redact } from "../redact.js";
import { safe, shellArg, txHash } from "../text.js";
import { confirmWrite, describeOrg, WRITE_GAS, type WriteStep } from "../write-plan.js";
import { ALLOW_PUBLIC_HELP, collectAllowPublic, UploadPresentationError } from "./upload.js";
import { parsePresentationMethod } from "./presentation.js";
import { publicationPresentation } from "../publication-presentation.js";
import { jsonAction } from "../json-action.js";

export function updateCommand(): Command {
  return new Command("update")
    .description("Update an existing ABX FS project from a local directory or single file")
    .argument("<path>", "local directory or file (must match project's existing kind)")
    .requiredOption("--project-id <id>", "project id to update")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option("--codec <codec>", "file codec, decoded off chain by readers: none|gzip (defaults to the chain's defaultCodec, else none)")
    .option("--fastlz", FASTLZ_HELP)
    .option("--no-fastlz", "store every chunk raw instead of through the FastLZ backend where it shrinks them")
    .option("--tag <tag>", "after publishing, set/move this tag to point at the new version ('latest' is reserved)")
    .option("--include-hidden", "include dotfiles and dot-directories (skipped by default, except .well-known)")
    .option("--allow-public <glob>", ALLOW_PUBLIC_HELP, collectAllowPublic, [] as string[])
    .option(
      "--max-bundle-gas <gas>",
      "max estimated gas per multicall bundle, a positive whole number, counted as the chain's per-transaction cap counts it " +
        "(all gas, or only execution gas under EIP-8037); defaults to the chain's defaultBundleGasBudget, else 12000000",
    )
    .option("--presentation <method>", "explicit presentation choice: auto|chain-gateway|embedded|ipfs (omitted preserves saved method)")
    .option("--presentation-path <path>", "explicit presentation entrypoint (omitted preserves saved source/path)")
    .option("--overlay", "add/replace the supplied directory files; preserve omitted paths through SDK draft operations")
    .option("--json", "one structured result; progress is printed to stderr")
    .option("--dry-run", "plan the update without a signer or transactions")
    .option("--yes", "send without asking (the plan is still printed). Required when there is no terminal to confirm on")
    .action(
      async (
        path: string,
        opts: {
          projectId: string;
          chain?: string;
          org?: string;
          codec?: string;
          fastlz?: boolean;
          tag?: string;
          includeHidden?: boolean;
          allowPublic?: string[];
          maxBundleGas?: string;
          yes?: boolean;
          dryRun?: boolean;
          presentation?: string;
          presentationPath?: string;
          overlay?: boolean;
          json?: boolean;
        },
      ) => jsonAction(opts.json, async (report) => {
        assertValidPublishInputs({ tag: opts.tag });
        if (opts.presentation !== undefined) parsePresentationMethod(opts.presentation);
        const tokenId = parseTokenId("--project-id", opts.projectId);
        const maxBundleGasFlag = opts.maxBundleGas !== undefined ? parsePositiveInt("--max-bundle-gas", opts.maxBundleGas) : undefined;
        await autoRegisterNodeCodecs();
        const cfg = loadConfig();
        const chain = resolveChain(cfg, opts.chain);
        const org = requireOrg(chain, opts.org);
        const client = await createOrgClient(chain, { write: !opts.dryRun, org });
        const orgLabel = await describeOrg(client, org);

        const project = await client.readProject(tokenId);
        const projectKind = projectKindName(project.kind);
        const existingRootCid = project.cid;
        if (!existingRootCid) {
          throw new Error(
            `project #${tokenId} in org ${orgLabel} has not published anything yet — use \`abxfs upload --project-id\` for a first version`,
          );
        }

        const hook = client.addresses.projectHook;
        if (!hook) {
          throw new Error(`this chain (${chain.chainId}) has no projectHook configured, so no project can be updated on it`);
        }
        console.log(
          kleur.cyan("→"),
          `updating ${projectKind} project #${tokenId} ("${safe(project.name ?? "")}") in org ${orgLabel} —`,
          "current root:",
          existingRootCid,
        );

        // Reject mismatched local input early — we'd rather fail before any chunks hit
        // the chain than discover the kind clash via a `RootKindLocked` revert.
        assertNotSymlink(path);
        const stat = lstatSync(path);
        const localKind = stat.isDirectory() ? "directory" : "file";
        if (localKind !== projectKind) {
          throw new Error(
            `project #${tokenId} is ${projectKind}-kind but local path "${safe(path)}" is a ${localKind}; ` +
              `provide a matching ${projectKind} or pick a different project`,
          );
        }

        const { codec, fastLz } = resolveContentOptions(chain, opts);
        const maxBundleGas = maxBundleGasFlag ?? chain.defaultBundleGasBudget;

        let newContent: FileDescriptor[] | FileDescriptor;
        let emptyDirectories: string[] = [];
        if (project.kind === ProjectKind.File) {
          newContent = await loadSingleFile(path, { allowPublic: opts.allowPublic ?? [] });
        } else {
          const tree = await scanTreeForUpload(path, {
            includeHidden: opts.includeHidden === true,
            allowPublic: opts.allowPublic ?? [],
          });
          if (tree.files.length === 0 && tree.emptyDirectories.length === 0) throw new Error(`nothing to upload in ${safe(path)}`);
          newContent = tree.files;
          emptyDirectories = tree.emptyDirectories;
        }

        // An upper bound: the update writes only what is not on chain yet, which is usually far less.
        const summary = await summarizeUpload({
          addresses: client.addresses,
          files: Array.isArray(newContent) ? newContent : [newContent],
          ...(Array.isArray(newContent) ? { emptyDirectories } : { asFile: true }),
          codec,
          fastLz,
          maxBundleGas,
          gasSchedule: gasScheduleForChain(chain.chainId),
        });
        if (opts.overlay && !Array.isArray(newContent)) throw new Error("--overlay requires a directory project; file projects use a single replacement");
        const ops: DraftOp[] = Array.isArray(newContent) ? newContent.map(file => ({ kind: "add", ...file })) : [];
        const overlay = opts.overlay ? await client.planUpdate({ baseRootCid: existingRootCid, ops,
          tag: opts.tag, opts: { codec, fastLz, emptyDirectories, ...(maxBundleGas !== undefined ? { maxBundleGas } : {}) } }) : undefined;
        const preflight = overlay ? { rootCid: overlay.applied.newRootCid }
          : Array.isArray(newContent) ? await client.planUpload(newContent, { codec, fastLz, emptyDirectories })
            : await client.uploadFile(newContent, { codec, fastLz, dryRun: true });
        const presentation = await publicationPresentation(client, tokenId, { root: preflight.rootCid,
          files: Array.isArray(newContent) ? newContent : [newContent], rootIsDirectory: Array.isArray(newContent), codec,
          emptyDirectories: overlay ? overlay.applied.emptyDirectories ?? [] : emptyDirectories,
          ...(overlay ? { entries: overlay.applied.files.filter(file => file.kind !== "removed").map(file => ({ path: file.path, cid: file.newCid })) } : {}),
          ...(opts.presentation !== undefined ? { method: parsePresentationMethod(opts.presentation) } : {}),
          ...(opts.presentationPath !== undefined ? { path: opts.presentationPath } : {}),
        });
        report({ chainId: chain.chainId, org, tokenId, existingRootCid, root: preflight.rootCid,
          contentMode: opts.overlay ? "overlay" : "snapshot", presentation, files: overlay?.applied.files, phase: "review" });
        const steps: WriteStep[] = [
          { what: `store what is new (of ${summary.files} file(s))`, txs: summary.txs, gas: summary.estimatedGas, upTo: true, scheduled: true },
          { what: "publish the new root as the project's next version", txs: 1, gas: WRITE_GAS.publish },
        ];
        if (opts.tag) steps.push({ what: `point tag "${safe(opts.tag)}" at it (a tag can be moved later)`, txs: 1, gas: WRITE_GAS.setTag });
        if (presentation?.configureTarget || presentation?.configureMethod)
          steps.push({ what: "configure the reviewed presentation choice", txs: Number(presentation.configureTarget) + Number(presentation.configureMethod), gas: 600_000 });
        if (opts.dryRun) {
          const result = { newRootCid: preflight.rootCid, dryRun: true, chainId: chain.chainId, org, tokenId: tokenId.toString(), existingRootCid, summary, steps, presentation,
            contentMode: opts.overlay ? "overlay" : "snapshot", files: overlay?.applied.files };
          report({ ...result, outcome: "planned" });
          console.log(JSON.stringify(result)); return;
        }
        const ok = await confirmWrite(
          client,
          {
            action: `publish ${safe(path)} as a new version of project #${tokenId}`,
            chainId: chain.chainId,
            org: orgLabel,
            steps,
            permanent: [
              "the new content: PUBLIC, and it can never be deleted",
              `the version: the new root is appended to project #${tokenId}'s history for good`,
            ],
          },
          { yes: opts.yes },
        );
        if (!ok) { report({ outcome: "cancelled" }); return; }

        const runOptions = {
          codec, fastLz, emptyDirectories, ...(maxBundleGas !== undefined ? { maxBundleGas } : {}),
          onBundleSent: (info: { callCount: number; estimatedGas: number; txHash: string }) =>
            console.log(kleur.gray("·"), `bundled ${info.callCount} call${info.callCount === 1 ? "" : "s"}`, kleur.gray(`(~${info.estimatedGas.toLocaleString()} gas)`), kleur.gray(txHash(info.txHash))),
        };
        const drafted = overlay ? await client.publishUpdate({ tokenId, baseRootCid: existingRootCid, ops, applied: overlay.applied,
          ...(opts.tag ? { tag: opts.tag } : {}), opts: runOptions }) : undefined;
        const result = drafted ? { ...drafted, txHash: drafted.publishTxHash } : await client.update({
          project: { collection: org, hook },
          tokenId,
          existingRootCid,
          newContent,
          ...(opts.tag ? { tag: opts.tag } : {}),
          opts: runOptions,
        });
        report({ published: true, outcome: "published", phase: "published", root: result.newRootCid,
          versionNumber: result.versionNumber, publishTxHash: result.txHash, tagTxHash: result.tagTxHash });
        // `client.update` publishes through the shared publish-and-tag path: the version number is
        // proven against a settled read of the recorded CID (not predicted or read once), and a tag
        // is only written against that proven version.
        console.log(
          kleur.green("✓"),
          `new version: v${String(result.versionNumber)} of project #${tokenId} in org ${orgLabel}`,
          kleur.gray(txHash(result.txHash)),
        );
        console.log(kleur.green("✓"), "new root:", result.newRootCid);
        if (opts.tag) {
          console.log(
            kleur.green("✓"),
            `tag "${safe(opts.tag)}" → v${result.versionNumber} on project #${tokenId} in org ${orgLabel}`,
            kleur.gray(txHash(result.tagTxHash)),
          );
        }
        let finalPresentationHash = result.tagTxHash ?? result.txHash;
        if (presentation && (presentation.configureTarget || presentation.configureMethod)) {
          let phase = "set-target";
          let targetDone = !presentation.configureTarget;
          let methodDone = !presentation.configureMethod;
          const phases: { phase: string; txHash: string }[] = [];
          try {
            if (!targetDone) { const hash = await client.configurePresentationTarget(tokenId, presentation.target); phases.push({ phase, txHash: hash }); finalPresentationHash = hash; targetDone = true; report({ phases }); }
            phase = "set-method";
            if (!methodDone) { const hash = await client.setPresentationMethod(tokenId, presentation.method); phases.push({ phase, txHash: hash }); finalPresentationHash = hash; methodDone = true; report({ phases }); }
          } catch (error) {
            const chainName = opts.chain ?? (process.env["ABXFS_CHAIN"]?.trim() || undefined) ?? cfg.defaultChain ?? Object.keys(cfg.chains)[0]!;
            const flags = `--project-id ${tokenId} --org ${org} --chain ${shellArg(chainName)}`;
            const target = presentation.target;
            const selection = target.selection === 1 ? `--version ${target.version}` : target.selection === 2 ? `--tag ${shellArg(target.tag)}` : "--latest";
            const method = ["chain-gateway", "embedded", "ipfs"][presentation.method]!;
            const commands = [ ...(!targetDone ? [`abxfs presentation set-target ${selection} --path ${shellArg(presentation.path)} ${flags}`] : []),
              ...(!methodDone ? [`abxfs presentation set-method ${method} ${flags}`] : []), `abxfs presentation preview ${flags}` ];
            report({ phase, phases, retryPublish: false });
            throw new UploadPresentationError({ org, tokenId, root: result.newRootCid, chainId: chain.chainId, phase }, commands.join(" && "), error);
          }
        }
        if (presentation) {
          const completeMetadata = await client.verifyPresentationTokenUri(tokenId, { afterTransactionHash: finalPresentationHash });
          report({ completeMetadata });
          if (!completeMetadata.ok) {
            const chainName = opts.chain ?? (process.env["ABXFS_CHAIN"]?.trim() || undefined) ?? cfg.defaultChain ?? Object.keys(cfg.chains)[0]!;
            const flags = `--project-id ${tokenId} --org ${org} --chain ${shellArg(chainName)}`;
            report({ outcome: "published_warning", warning: redact(completeMetadata.reason), retryPublish: false,
              recovery: [`abxfs presentation preview ${flags}`, `abxfs presentation set-method chain-gateway ${flags}`] });
            console.warn(kleur.yellow("!"), `Published successfully; ${redact(completeMetadata.reason)}. Do not rerun update.`);
            console.warn(`Inspect: abxfs presentation preview ${flags}`);
            console.warn(`Review a gateway method change if needed: abxfs presentation set-method chain-gateway ${flags}`);
          }
        }
        await printProjectLinks(client, tokenId);
        if (client.addresses.projectPresentation) {
          // Publishing is settled. A presentation read must never turn it into a failed update or another write.
          let warning: string | undefined;
          try {
            const preview = await client.previewPresentation(tokenId);
            if (preview.status !== PresentationStatus.Ready)
              warning = `presentation preview reports ${PresentationStatus[preview.status] ?? String(preview.status)}`;
          } catch (error) {
            warning = `could not preview presentation: ${redact(error instanceof Error ? error.message.split("\n")[0]! : String(error))}`;
          }
          if (warning) {
            const chainName = opts.chain ?? (process.env["ABXFS_CHAIN"]?.trim() || undefined)
              ?? cfg.defaultChain ?? Object.keys(cfg.chains)[0]!;
            const flags = `--project-id ${tokenId} --org ${org} --chain ${shellArg(chainName)}`;
            report({ outcome: "published_warning", warning, retryPublish: false,
              recovery: [`abxfs presentation preview ${flags}`, `abxfs presentation set-method chain-gateway ${flags}`] });
            console.warn(kleur.yellow("!"), safe(`Published successfully, but ${warning}. The existing presentation method is preserved; do not rerun update.`));
            console.warn(`Inspect: abxfs presentation preview ${flags}`);
            console.warn(`Review a gateway method change if needed: abxfs presentation set-method chain-gateway ${flags}`);
          }
        }
      }),
    );
}
