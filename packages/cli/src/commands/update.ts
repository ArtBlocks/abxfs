import { lstatSync } from "node:fs";

import { Command } from "commander";
import kleur from "kleur";

import {
  autoRegisterNodeCodecs,
  gasScheduleForChain,
  ProjectKind,
  projectKindName,
  assertValidPublishInputs,
  type FileDescriptor,
} from "@abxfs/sdk";

import { parsePositiveInt, parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { FASTLZ_HELP, resolveContentOptions } from "../codec.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { assertNotSymlink } from "../fsscan.js";
import { summarizeUpload } from "../plan-summary.js";
import { loadSingleFile, scanTreeForUpload } from "../scan-guard.js";
import { safe, shortTxHash } from "../text.js";
import { confirmWrite, describeOrg, WRITE_GAS, type WriteStep } from "../write-plan.js";
import { ALLOW_PUBLIC_HELP, collectAllowPublic } from "./upload.js";

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
        },
      ) => {
        assertValidPublishInputs({ tag: opts.tag });
        const tokenId = parseTokenId("--project-id", opts.projectId);
        const maxBundleGasFlag = opts.maxBundleGas !== undefined ? parsePositiveInt("--max-bundle-gas", opts.maxBundleGas) : undefined;
        await autoRegisterNodeCodecs();
        const cfg = loadConfig();
        const chain = resolveChain(cfg, opts.chain);
        const org = requireOrg(chain, opts.org);
        const client = await createOrgClient(chain, { write: true, org });
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
        const steps: WriteStep[] = [
          { what: `store what is new (of ${summary.files} file(s))`, txs: summary.txs, gas: summary.estimatedGas, upTo: true, scheduled: true },
          { what: "publish the new root as the project's next version", txs: 1, gas: WRITE_GAS.publish },
        ];
        if (opts.tag) steps.push({ what: `point tag "${safe(opts.tag)}" at it (a tag can be moved later)`, txs: 1, gas: WRITE_GAS.setTag });
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
        if (!ok) return;

        const result = await client.update({
          project: { collection: org, hook },
          tokenId,
          existingRootCid,
          newContent,
          ...(opts.tag ? { tag: opts.tag } : {}),
          opts: {
            codec,
            fastLz,
            emptyDirectories,
            ...(maxBundleGas !== undefined ? { maxBundleGas } : {}),
            onBundleSent: (info) =>
              console.log(
                kleur.gray("·"),
                `bundled ${info.callCount} call${info.callCount === 1 ? "" : "s"}`,
                kleur.gray(`(~${info.estimatedGas.toLocaleString()} gas)`),
                kleur.gray(shortTxHash(info.txHash)),
              ),
          },
        });
        // `client.update` publishes through the shared publish-and-tag path: the version number is
        // proven against a settled read of the recorded CID (not predicted or read once), and a tag
        // is only written against that proven version.
        console.log(kleur.green("✓"), `new version: v${String(result.versionNumber)} of project #${tokenId} in org ${orgLabel}`);
        console.log(kleur.green("✓"), "new root:", result.newRootCid);
        if (opts.tag) console.log(kleur.green("✓"), `tag "${safe(opts.tag)}" → v${result.versionNumber} on project #${tokenId} in org ${orgLabel}`);
      },
    );
}
