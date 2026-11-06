import { Command } from "commander";
import kleur from "kleur";

import { isSafeExternalUrl, isUsableViewUrl, projectKindName } from "@artblocks/abxfs-sdk";

import { parsePositiveInt, parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { printProjectLinks } from "../links.js";
import { safe } from "../text.js";

/** How many versions `info` prints unless `--max-versions` says otherwise. */
export const DEFAULT_MAX_VERSIONS = 200;

export function infoCommand(): Command {
  return new Command("info")
    .description("Show project metadata, version history, and tags")
    .requiredOption("--project-id <id>", "project token id")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option(
      "--max-versions <n>",
      `how many versions to print, newest first, a positive whole number (default ${DEFAULT_MAX_VERSIONS}; ` +
        "older ones are counted, not printed)",
    )
    .action(
      async (opts: { projectId: string; chain?: string; org?: string; maxVersions?: string }) => {
        const id = parseTokenId("--project-id", opts.projectId);
        const maxVersions = opts.maxVersions !== undefined ? parsePositiveInt("--max-versions", opts.maxVersions) : DEFAULT_MAX_VERSIONS;
        const cfg = loadConfig();
        const chain = resolveChain(cfg, opts.chain);
        const client = await createOrgClient(chain, { org: requireOrg(chain, opts.org) });

        const p = await client.readProject(id);

        console.log(kleur.cyan("project"), `#${p.tokenId}`, kleur.gray(`in org ${p.collection}`), p.name ? `"${safe(p.name)}"` : kleur.gray("(unnamed)"));
        console.log("  owner:   ", p.owner, kleur.gray("(the only address that can publish)"));
        console.log("  kind:    ", projectKindName(p.kind));
        console.log("  current: ", p.cid ?? kleur.gray("(nothing published yet)"));
        console.log("  versions:", p.versionCount);
        console.log(
          "  gateway: ",
          p.preferredGateway === null
            ? kleur.gray("(none — always served from chain)")
            : isSafeExternalUrl(p.preferredGateway)
              ? safe(p.preferredGateway)
              : kleur.yellow("(set, but ignored: not a public https URL)"),
        );

        console.log(
          "  view:    ",
          p.viewUrl === null
            ? kleur.gray("(unset: the token links to the ABX FS site, below; set one with `abxfs view`)")
            : isUsableViewUrl(p.viewUrl) && isSafeExternalUrl(p.viewUrl)
              ? safe(p.viewUrl)
              : kleur.yellow("(set, but ignored: not a public https URL)"),
        );
        await printProjectLinks(client, id, { afterWrite: false });

        // The hook keeps the full history, and a Version[] window is requested directly.
        if (p.versionCount > 0) {
          // Paged by the SDK (at most 200 per eth_call by default): an inherited project can hold an
          // enormous history. `--max-versions` raises the window explicitly.
          const cap = Math.min(maxVersions, p.versionCount);
          const start = Math.max(0, p.versionCount - cap);
          const versions = await client.projectVersions(id, { start, end: p.versionCount, limit: cap });

          for (const v of versions) {
            const when = new Date(v.publishedAt * 1000).toISOString();
            console.log("   ", `v${v.version}`, v.cid, kleur.gray(`${when} by ${v.publisher}`));
          }
          if (start > 0) {
            console.log(
              kleur.gray(
                `  (omitted ${start} older version${start === 1 ? "" : "s"} — pass --max-versions to widen)`,
              ),
            );
          }
        }

        const names = await client.listTags(id);
        if (names.length > 0) {
          console.log("  tags:");
          for (const name of names) {
            const t = await client.readTag(id, name);
            console.log("   ", kleur.yellow(safe(name)), "→", `v${t.version}`, kleur.gray(t.cid));
          }
        } else {
          console.log("  tags:", kleur.gray("(none — 'latest' always resolves to the head)"));
        }
      },
    );
}
