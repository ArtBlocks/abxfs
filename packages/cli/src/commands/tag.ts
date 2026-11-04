/**
 * `abxfs tag <subcommand>` — manage tag pointers.
 *
 * Tags are mutable, owner-managed pointers from `(tokenId, tag) → version`, stored in
 * `ProjectHook` and authorized against `ownerOf` — so tag rights follow the NFT with no
 * extra step. `"latest"` is reserved and virtual: it always tracks the head, has no storage, and
 * writes to it revert.
 *
 * Note that a tag write is a SEPARATE transaction from a publish. The CID lands on the ABX
 * collection and the tag on the hook, so no single-contract multicall can cover both.
 */
import { Command } from "commander";
import kleur from "kleur";
import type { Address } from "viem";

import { parsePositiveInt, parseTokenId } from "../args.js";
import { createOrgClient } from "../client.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { safe, txHash } from "../text.js";
import { confirmWrite, describeOrg, WRITE_GAS } from "../write-plan.js";

const ORG_HELP = "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)";
const YES_HELP = "send without asking (the plan is still printed). Required when there is no terminal to confirm on";

export function tagCommand(): Command {
  const cmd = new Command("tag")
    .description("Manage on-chain project tags (mutable named pointers to versions)");

  cmd
    .command("set")
    .description("Set or move a tag to point at a specific version")
    .argument("<projectId>", "project id")
    .argument("<tag>", "tag name (1-64 bytes; ^[a-z0-9][a-z0-9._-]*$; 'latest' is reserved)")
    .argument("<versionNumber>", "version number (1-indexed)")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", ORG_HELP)
    .option("--yes", YES_HELP)
    .action(async (projectId: string, tag: string, versionNumber: string, opts: { chain?: string; org?: string; yes?: boolean }) => {
      const id = parseTokenId("<projectId>", projectId);
      const ver = parsePositiveInt("<versionNumber>", versionNumber);
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const org = requireOrg(chain, opts.org);
      const client = await createOrgClient(chain, { write: true, org });
      const orgLabel = await describeOrg(client, org);
      const ok = await confirmWrite(
        client,
        {
          action: `point tag "${safe(tag)}" on project #${id} at v${ver}`,
          chainId: chain.chainId,
          org: orgLabel,
          steps: [{ what: "set the tag", txs: 1, gas: WRITE_GAS.setTag }],
          permanent: [],
        },
        { yes: opts.yes },
      );
      if (!ok) return;
      const hash = await client.setTag(id, tag, ver);
      console.log(kleur.green("✓"), `tag "${safe(tag)}" → v${ver} on project #${id} in org ${orgLabel}`, kleur.gray(txHash(hash)));
    });

  cmd
    .command("remove")
    .description("Remove a tag")
    .argument("<projectId>", "project id")
    .argument("<tag>", "tag name")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", ORG_HELP)
    .option("--yes", YES_HELP)
    .action(async (projectId: string, tag: string, opts: { chain?: string; org?: string; yes?: boolean }) => {
      const id = parseTokenId("<projectId>", projectId);
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const org = requireOrg(chain, opts.org);
      const client = await createOrgClient(chain, { write: true, org });
      const orgLabel = await describeOrg(client, org);
      const ok = await confirmWrite(
        client,
        {
          action: `remove tag "${safe(tag)}" from project #${id}`,
          chainId: chain.chainId,
          org: orgLabel,
          steps: [{ what: "remove the tag", txs: 1, gas: WRITE_GAS.removeTag }],
          permanent: [],
        },
        { yes: opts.yes },
      );
      if (!ok) return;
      const hash = await client.removeTag(id, tag);
      console.log(kleur.green("✓"), `tag "${safe(tag)}" removed from project #${id} in org ${orgLabel}`, kleur.gray(txHash(hash)));
    });

  cmd
    .command("get")
    .description("Resolve a tag (use 'latest' for the project head)")
    .argument("<projectId>", "project id")
    .argument("<tag>", "tag name")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", ORG_HELP)
    .action(async (projectId: string, tag: string, opts: { chain?: string; org?: string }) => {
      const id = parseTokenId("<projectId>", projectId);
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const client = await createOrgClient(chain, { org: requireOrg(chain, opts.org) });
      const t = await client.readTag(id, tag);
      console.log(kleur.cyan("tag"), `"${safe(tag)}"`, "→", `v${t.version}`, kleur.gray(t.cid));
    });

  cmd
    .command("list")
    .description("List all (non-virtual) tags on a project")
    .argument("<projectId>", "project id")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", ORG_HELP)
    .action(async (projectId: string, opts: { chain?: string; org?: string }) => {
      const id = parseTokenId("<projectId>", projectId);
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const client = await createOrgClient(chain, { org: requireOrg(chain, opts.org) });
      // "Nothing published" is read from the project itself. A failed read of the head (an RPC error, a project
      // that does not exist) is an error, not "nothing published": a bare catch here once reported both alike.
      const project = await client.readProject(id);
      if (project.versionCount === 0) {
        console.log(kleur.cyan("project"), `#${id}`, kleur.gray("(nothing published yet)"));
      } else {
        const head = await client.readTag(id, "latest");
        console.log(kleur.cyan("project"), `#${id}`, "head:", `v${head.version}`, kleur.gray(head.cid));
      }

      const names = await client.listTags(id);
      if (names.length === 0) {
        console.log(kleur.gray("  no tags — 'latest' always resolves to the head"));
        return;
      }
      for (const name of names) {
        const t = await client.readTag(id, name);
        console.log("  ", kleur.yellow(safe(name)), "→", `v${t.version}`, kleur.gray(t.cid));
      }
    });

  return cmd;
}

/** Re-exported for tests / programmatic use. */
export type { Address };
