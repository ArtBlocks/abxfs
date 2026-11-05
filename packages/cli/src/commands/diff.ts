import { Command } from "commander";
import kleur from "kleur";

import { autoRegisterNodeCodecs } from "@artblocks/abxfs-sdk";

import { parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { resolveContentOptions } from "../codec.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { scanDirectoryReport } from "../fsscan.js";
import { safe } from "../text.js";

export function diffCommand(): Command {
  return new Command("diff")
    .description("Show the diff between a local directory and an on-chain directory tree")
    .argument("<dir>", "local directory to compare")
    .requiredOption("--project-id <id>", "project id whose current directory is the baseline")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option("--include-hidden", "include dotfiles and dot-directories, matching an upload that used --include-hidden")
    .option(
      "--codec <codec>",
      "file codec (none|gzip) when recomputing expected CIDs. MUST match what the upload used, or every file reports as changed (defaults to the chain's defaultCodec, else none)",
    )
    .option("--fastlz", "recompute as if chunks went through FastLZ where it shrinks them (the default; overrides a chain's fastLz: false)")
    .option("--no-fastlz", "recompute as if chunks were stored raw, matching an upload that used --no-fastlz")
    .action(async (dir: string, opts: { projectId: string; chain?: string; org?: string; codec?: string; fastlz?: boolean; includeHidden?: boolean }) => {
      const id = parseTokenId("--project-id", opts.projectId);
      await autoRegisterNodeCodecs();
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const client = await createOrgClient(chain, { org: requireOrg(chain, opts.org) });

      const project = await client.readProject(id);
      const { files, emptyDirectories } = scanDirectoryReport(dir, opts.includeHidden ? { includeHidden: true } : {});
      // MUST match how the content was uploaded. A file CID commits to its codec and every chunk id to
      // its backend, so recomputing under different choices reports every file as changed and yields a
      // root `update` will never produce.
      const content = resolveContentOptions(chain, opts);
      if (!project.cid) {
        throw new Error(
          `project #${id} has not published anything yet — nothing to diff against`,
        );
      }
      const diff = await client.diff(project.cid, files, { ...content, emptyDirectories });

      console.log(kleur.cyan("diff"), `baseline=${project.cid} new=${diff.newRootCid}`);
      for (const e of diff.entries) {
        const tag =
          e.kind === "added"
            ? kleur.green("+")
            : e.kind === "removed"
              ? kleur.red("-")
              : e.kind === "changed"
                ? kleur.yellow("~")
                : kleur.gray("=");
        console.log(" ", tag, safe(e.path));
      }
      for (const d of diff.emptyDirectoriesAdded) console.log(" ", kleur.green("+"), `${safe(d)}/`, kleur.gray("(empty folder)"));
      for (const d of diff.emptyDirectoriesRemoved) console.log(" ", kleur.red("-"), `${safe(d)}/`, kleur.gray("(empty folder)"));
      const emptyChanges = diff.emptyDirectoriesAdded.length + diff.emptyDirectoriesRemoved.length;
      console.log(
        kleur.gray(
          `${diff.changed.length} changed / ${diff.unchanged.length} unchanged` +
            (emptyChanges ? ` / ${emptyChanges} empty folder${emptyChanges === 1 ? "" : "s"} differ` : "") +
            (diff.rootChanged ? "" : " (root unchanged)"),
        ),
      );
    });
}
