/**
 * `abxfs transfer` — hand a project to a new owner.
 *
 * One transaction, because a project is an ABX NFT and this is an ERC-721 transfer, with no
 * handshake. Pushing an unwanted project onto someone is ordinary NFT spam, which wallets and
 * marketplaces already handle.
 *
 * The trade it makes is real, though: there is no window in which to reconsider. Transferring the
 * token transfers the sole right to publish versions and move tags, immediately and irreversibly.
 * Hence the explicit confirmation prompt unless `--yes`.
 */
import { Command } from "commander";
import kleur from "kleur";

import { createOrgClient } from "../client.js";
import { assertSafeRecipient, type ContractAddresses } from "@artblocks/abxfs-sdk";

import { parseTokenId } from "../args.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { safe, txHash } from "../text.js";
import { confirmWrite, describeOrg, WRITE_GAS } from "../write-plan.js";

/**
 * Every contract address in a chain's address book: the content layer, and the org layer of the current generation AND
 * of every earlier one (`previousGenerations`). A project token sent to any of them is gone for good.
 */
export function protocolAddresses(addresses: ContractAddresses | undefined): string[] {
  if (!addresses) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(addresses)) {
    if (key === "previousGenerations" && Array.isArray(value)) {
      for (const g of value) for (const v of Object.values(g as Record<string, unknown>)) if (typeof v === "string") out.push(v);
    } else if (typeof value === "string") {
      out.push(value);
    }
  }
  return out;
}

export function transferCommand(): Command {
  return new Command("transfer")
    .description("Transfer a project to a new owner (one tx — takes effect immediately)")
    .argument("<projectId>", "project token id")
    .argument("<newOwner>", "address of the new owner")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option("--yes", "send without asking (the plan is still printed). Required when there is no terminal to confirm on")
    .action(async (projectId: string, newOwner: string, opts: { chain?: string; org?: string; yes?: boolean }) => {
      const id = parseTokenId("<projectId>", projectId);
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);

      const org = requireOrg(chain, opts.org);
      // Strict: checksum-validated; never the zero/burn address, the org, or an ABX FS contract of ANY factory generation
      // (an org made by a superseded factory is frozen against that generation's hooks, which take a token for good).
      const to = assertSafeRecipient(newOwner, { forbid: [org, ...protocolAddresses(chain.addresses)], what: "new owner" });
      const client = await createOrgClient(chain, { write: true, org });
      const orgLabel = await describeOrg(client, org);
      const project = await client.readProject(id);

      console.log(kleur.cyan("project"), `#${id}`, kleur.gray(`in org ${orgLabel}`), project.name ? `"${safe(project.name)}"` : "");
      console.log("  current owner:", project.owner);
      console.log("  new owner:    ", kleur.yellow(to));
      console.log("  versions:     ", project.versionCount);
      const ok = await confirmWrite(
        client,
        {
          action: `transfer project #${id} to ${to}`,
          chainId: chain.chainId,
          org: orgLabel,
          steps: [{ what: "transfer the project token", txs: 1, gas: WRITE_GAS.transfer }],
          permanent: [`the transfer: ${to} gains the sole right to publish versions and move tags, at once; you cannot take it back`],
        },
        { yes: opts.yes },
      );
      if (!ok) return;

      const hash = await client.transferProject(id, to);
      console.log(
        kleur.green("✓"),
        `project #${id} in org ${orgLabel} transferred to`,
        kleur.yellow(to),
        kleur.gray(txHash(hash)),
      );
    });
}
