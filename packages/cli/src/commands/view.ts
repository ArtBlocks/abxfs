/**
 * `abxfs view` — choose where a project's token links point on marketplaces.
 *
 * Marketplaces show two links from a token's metadata: `animation_url` (the live project, embedded)
 * and `external_url`. By default they point at a path on the ABX FS site. Set `abxfs.view` and both
 * point at exactly the URL you give, with nothing appended — your own gateway, your own domain, a
 * single-project host (`abxfs-gateway --project …`). It assumes nothing about what serves it.
 */
import { Command } from "commander";
import kleur from "kleur";
import { isSafeExternalUrl, isUsableViewUrl } from "@abxfs/sdk";

import { parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { safe, txHash } from "../text.js";
import { confirmWrite, describeOrg, WRITE_GAS } from "../write-plan.js";

export function viewCommand(): Command {
  return new Command("view")
    .description("Set where a project's token links point on marketplaces (default: the ABX FS site)")
    .argument("[url]", "the whole URL, https only; used as is")
    .requiredOption("--project-id <id>", "project (token) id")
    .option("--clear", "remove it and use the default again")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option("--yes", "send without asking (the plan is still printed). Required when there is no terminal to confirm on")
    .action(
      async (
        url: string | undefined,
        opts: { projectId: string; clear?: boolean; chain?: string; org?: string; yes?: boolean },
      ) => {
        // Exactly one: `opts.clear` is undefined (not false) without the flag, so neither once read as "clear it".
        if ((opts.clear === true) === Boolean(url)) {
          throw new Error(url ? "give a URL or --clear, not both" : "give a URL, or --clear to remove it");
        }
        if (url && !isUsableViewUrl(url)) {
          throw new Error(
            "not a URL the token will emit: it must be https://, at most 512 bytes of visible ASCII, " +
              "with none of \" ' & ( ) < > [ \\ ] ^ ` { | }. Write those, and non-ASCII paths, percent-encoded, and non-ASCII hosts as punycode.",
          );
        }
        if (url && !isSafeExternalUrl(url)) {
          throw new Error(
            "refusing that URL: it must be a public https URL (no credentials, not localhost or a private/loopback address)",
          );
        }
        const id = parseTokenId("--project-id", opts.projectId);
        const chain = resolveChain(loadConfig(), opts.chain);
        const org = requireOrg(chain, opts.org);
        const client = await createOrgClient(chain, { write: true, org });
        const orgLabel = await describeOrg(client, org);
        const ok = await confirmWrite(
          client,
          {
            action: url ? `point project #${id}'s token links at ${safe(url)}` : `clear project #${id}'s token links (back to the default)`,
            chainId: chain.chainId,
            org: orgLabel,
            steps: [{ what: url ? "set abxfs.view" : "clear abxfs.view", txs: 1, gas: WRITE_GAS.setView }],
            permanent: [],
            ...(url ? { warnings: ["marketplaces send people to exactly this URL, and may cache it for a while after a change"] } : {}),
          },
          { yes: opts.yes },
        );
        if (!ok) return;
        const tx = await client.setViewUrl(id, url ?? "");
        console.log(
          kleur.green("✓"),
          url
            ? `token links for project #${id} in org ${orgLabel} now point at ${safe(url)}`
            : `project #${id} in org ${orgLabel} uses the default links again`,
          kleur.gray(txHash(tx)),
        );
      },
    );
}
