/**
 * `abxfs org` — create and administer orgs.
 *
 * An org is its own ABX collection, deployed by one immutable factory that renounces ABX ownership
 * at creation. Its *admin* is a record in the factory with three powers: decide who may mint into
 * the org, open or close it, and hand the role on. The admin has no power over any project — a
 * project belongs to whoever `ownerOf` says, and nothing here can touch one.
 *
 * Mostly you will not run `org create` yourself: `abxfs upload --name …` creates your personal org
 * the first time you publish.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Command } from "commander";
import kleur from "kleur";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { assertSafeRecipient, defaultOrgName, validateOrgDescription, validateOrgName, type Org } from "@abxfs/sdk";

import { createClient, createOrgClient } from "../client.js";
import { getPrivateKey, isAddress, loadConfig, resolveChain } from "../config.js";
import { withMintRecovery } from "../recover.js";
import { safe, txHash } from "../text.js";
import { confirmWrite, describeOrg, estimateCreateOrgGas, WRITE_GAS, type WritePlan } from "../write-plan.js";

const YES_HELP = "send without asking (the plan is still printed). Required when there is no terminal to confirm on";

/** How many projects an org can ever hold (`OrgFactory.MAX_PROJECTS`). ABX lets a cap go down, never up. */
export const ORG_PROJECT_CAP = 1_000_000;

/** What `org open` says before it sends: an open org can be filled by anyone, and the cap never rises. */
export const OPEN_ORG_WARNING =
  `anyone may then mint projects into this org, until you close it. An open org can be filled to its ` +
  `${ORG_PROJECT_CAP.toLocaleString("en-US")}-project cap by anyone, and the cap never rises: once it is reached, ` +
  "nobody, you included, can ever mint into it again.";

function asAddress(value: string, what = "address"): Address {
  if (!isAddress(value)) throw new Error(`not a valid ${what}: ${safe(value)}`);
  return value;
}

/**
 * The one-line warning `org mint --to` prints when the recipient is not the signer, or null when it is.
 * A minted project belongs to its holder: the admin cannot publish to it, rename it or take it back.
 */
export function mintRecipientWarning(to: Address, signer: Address): string | null {
  if (to.toLowerCase() === signer.toLowerCase()) return null;
  return (
    `warning: this gives the project to ${to}. Once minted, only its holder can publish to it, rename it or ` +
    "transfer it; you, as the org's admin, cannot edit it or take it back. To keep control, mint it to your own " +
    "wallet (or the org's Safe)."
  );
}

/**
 * The org description `org create` will send, from `--description` or `--description-file` (not both),
 * validated against the factory's rule so a bad one is refused before any transaction. Empty when neither
 * is given. A file's trailing newlines are dropped; anything else in it is kept exactly, and a CR (a
 * Windows line ending) is refused rather than silently rewritten into a permanent value.
 */
export function orgDescriptionFromOptions(opts: { description?: string; descriptionFile?: string }): string {
  if (opts.description !== undefined && opts.descriptionFile !== undefined) {
    throw new Error("pass --description or --description-file, not both");
  }
  const description =
    opts.descriptionFile !== undefined
      ? readFileSync(resolve(process.cwd(), opts.descriptionFile), "utf8").replace(/\n+$/, "")
      : (opts.description ?? "");
  validateOrgDescription(description);
  return description;
}

/**
 * Why `signer` may not run an admin command on `o`, or null when it may: `"admin"` commands need the org's admin,
 * `accept-admin` needs the address the role was offered to. Checked before the prompt, so a write the factory would
 * revert (`NotAdmin`, `NotPendingAdmin`) is one sentence instead of viem's revert dump.
 */
export function adminRefusal(o: Org, signer: Address, may: "admin" | "offered", what: string): string | null {
  const me = signer.toLowerCase();
  if (may === "admin") {
    if (o.admin.toLowerCase() === me) return null;
    return `your account ${signer} is not the admin of org ${o.org} (${o.admin} is): only the admin can ${what}. Nothing was sent.`;
  }
  if (o.pendingAdmin?.toLowerCase() === me) return null;
  if (o.pendingAdmin) {
    return `the admin role of org ${o.org} was offered to ${o.pendingAdmin}, not to your account ${signer}: only they can ${what}. Nothing was sent.`;
  }
  if (o.admin.toLowerCase() === me) return `your account ${signer} is already the admin of org ${o.org}. Nothing was sent.`;
  return (
    `the admin role of org ${o.org} has not been offered to anyone. Its admin (${o.admin}) offers it with ` +
    `\`abxfs org transfer-admin ${o.org} ${signer}\`; if they just did, try again in a few seconds. Nothing was sent.`
  );
}

/** The address a read-only command should act for: `--address`, else the configured key's account. */
function subject(flag: string | undefined): Address {
  if (flag) return asAddress(flag);
  const pk = getPrivateKey();
  if (pk) return privateKeyToAccount(pk).address;
  throw new Error("pass --address <account>, or set ABXFS_PRIVATE_KEY to use its account");
}

export function orgCommand(): Command {
  const cmd = new Command("org").description(
    "Create and administer orgs (the namespace projects live in)",
  );

  cmd
    .command("create")
    .description("Create an org, administered by you, and mint its first project to you (one tx)")
    .argument("[name]", "org name, 1-64 bytes, fixed for life (default: your shortened address)")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option(
      "--description <text>",
      "optional, PERMANENT: shown as the collection description on marketplaces like OpenSea. " +
        "Up to 1000 bytes of printable ASCII and newlines",
    )
    .option("--description-file <path>", "read the description from a file instead (trailing newlines dropped)")
    .option(
      "--salt <bytes32>",
      "deterministic address. First 20 bytes must be zero (anyone may use it) or your address",
    )
    .option("--yes", YES_HELP)
    .action(
      async (
        name: string | undefined,
        opts: { chain?: string; salt?: string; description?: string; descriptionFile?: string; yes?: boolean },
      ) => {
        // Before any client exists: a description or salt the factory would refuse never costs a round trip.
        const description = orgDescriptionFromOptions(opts);
        if (opts.salt !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(opts.salt)) {
          throw new Error(`--salt must be 32 bytes of hex (0x followed by 64 hex digits), got "${safe(opts.salt)}"`);
        }
        if (name !== undefined) validateOrgName(name);
        const chain = resolveChain(loadConfig(), opts.chain);
        const client = createClient(chain, { write: true });
        const me = client.walletClient!.account!.address;

        const orgName = name ?? defaultOrgName(me);
        validateOrgName(orgName);
        if (description) {
          console.log(kleur.gray(`  description (permanent, ${description.length} bytes):`));
          for (const line of description.split("\n")) console.log(kleur.gray(`    ${safe(line)}`));
        }
        const salt = opts.salt as Hex | undefined;
        const est = await estimateCreateOrgGas(client, { name: orgName, description, ...(salt ? { salt } : {}) });
        const ok = await confirmWrite(
          client,
          {
            action: `create the org "${safe(orgName)}"`,
            chainId: chain.chainId,
            org: `a new org "${safe(orgName)}", administered by you (${me})`,
            steps: [
              {
                what: "create the org and mint its first project to you" + (est.estimated ? "" : " (gas: at most)"),
                txs: 1,
                gas: est.gas,
                scheduled: est.estimated,
              },
            ],
            permanent: [
              `the org's name, "${safe(orgName)}": fixed for life, and shown on every project in it`,
              ...(description ? [`its description (${description.length} bytes, above): shown on marketplaces, and fixed for life`] : []),
              "its first project, #0, minted to you",
              "you as its admin (the role can only be handed on, never removed)",
            ],
          },
          { yes: opts.yes },
        );
        if (!ok) return;
        console.log(kleur.cyan("→"), `creating org "${safe(orgName)}"`);
        const created = await withMintRecovery({
          what: "creating the org",
          send: (onSent) => client.createOrg({ name: orgName, description, ...(salt ? { salt } : {}), onSent }),
          recover: (hash) => client.recoverCreateOrg(hash),
          fromRecovered: (r, hash) => ({ org: r.org, firstTokenId: r.tokenId, txHash: hash }),
          whenConfirmed: "Once it confirms, `abxfs org list` shows the new org.",
        });
        console.log(kleur.green("✓"), `org: "${safe(orgName)}" ${created.org}`, kleur.gray(txHash(created.txHash)));
        console.log(
          kleur.gray(
            `  admin ${me}; first project is #${created.firstTokenId}. Use it with --org ${created.org}`,
          ),
        );
      },
    );

  cmd
    .command("list")
    .description("List the orgs an account administers or holds a project in, newest first")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--address <account>", "account to list for (default: the ABXFS_PRIVATE_KEY account)")
    .action(async (opts: { chain?: string; address?: string }) => {
      const chain = resolveChain(loadConfig(), opts.chain);
      const client = createClient(chain);
      const account = subject(opts.address);

      const mine = await client.myOrgs(account);
      if (mine.length === 0) {
        console.log(
          kleur.gray(`no orgs for ${account} — \`abxfs upload --name …\` creates one on first publish`),
        );
        return;
      }
      for (const o of mine) {
        console.log(
          kleur.cyan(o.org),
          `"${safe(o.name)}"`,
          kleur.gray(`[${o.roles.join(", ")}]${o.open ? " open" : ""}`),
        );
      }
    });

  cmd
    .command("info")
    .description("Show one org's admin, mint rule and creation block")
    .argument("<org>", "org address")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .action(async (orgArg: string, opts: { chain?: string }) => {
      const chain = resolveChain(loadConfig(), opts.chain);
      const client = createClient(chain);
      const org = await client.readOrg(asAddress(orgArg, "org address"));
      if (!org) throw new Error(`${orgArg} is not an org created by this chain's factory`);

      console.log(kleur.cyan("org"), org.org, `"${safe(org.name)}"`);
      console.log("  admin:    ", org.admin, kleur.gray("(decides who may mint; no power over any project)"));
      if (org.pendingAdmin) console.log("  offered to:", org.pendingAdmin, kleur.yellow("(awaiting acceptance)"));
      console.log("  minting:  ", org.open ? kleur.yellow("open to anyone") : "admin only");
      console.log("  created at block", org.createdBlock.toString());
    });

  cmd
    .command("mint")
    .description("Mint the next project in an org to an address (default: you). The recipient owns it.")
    .argument("<org>", "org address")
    .option("--to <address>", "who receives the project token")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--yes", YES_HELP)
    .action(async (orgArg: string, opts: { chain?: string; to?: string; yes?: boolean }) => {
      const org = asAddress(orgArg, "org address");
      // Strict: checksum-validated, and never the zero/burn address or the org itself. Before anything is read.
      const to = opts.to ? assertSafeRecipient(opts.to, { forbid: [org], what: "recipient" }) : undefined;
      const chain = resolveChain(loadConfig(), opts.chain);
      const client = await createOrgClient(chain, { write: true, org });
      const signer = client.walletClient!.account!.address;
      const warning = to ? mintRecipientWarning(to, signer) : null;
      if (warning) console.error(kleur.yellow(warning));
      const orgLabel = await describeOrg(client, org);
      const ok = await confirmWrite(
        client,
        {
          action: `mint the next project in this org to ${to ?? `you (${signer})`}`,
          chainId: chain.chainId,
          org: orgLabel,
          steps: [{ what: "mint a project token", txs: 1, gas: WRITE_GAS.mint }],
          permanent: [
            warning
              ? `a new project token GIVEN to ${to}: only they can publish to it, rename it or transfer it; you cannot take it back`
              : "a new project token, held by you",
          ],
        },
        { yes: opts.yes },
      );
      if (!ok) return;
      const minted = await withMintRecovery({
        what: "the mint",
        send: (onSent) => client.mintProject(to ? { to, onSent } : { onSent }),
        recover: (hash) => client.recoverMint(hash, { holder: to ?? signer }),
        fromRecovered: (r, hash) => ({ tokenId: r.tokenId, txHash: hash }),
        whenConfirmed:
          `Once it confirms, the new project's id is in the transaction's Transfer event; \`abxfs info --project-id <id> --org ${org}\` shows it.`,
      });
      console.log(kleur.green("✓"), `project #${minted.tokenId} in org ${orgLabel} minted to ${to ?? "you"}`, kleur.gray(txHash(minted.txHash)));
      if (to) {
        console.log(
          kleur.gray(
            "  They own it from this moment, and can publish to it or give it away.",
          ),
        );
      }
    });

  const write = (
    name: string,
    description: string,
    args: Array<[string, string]>,
    run: (ctx: {
      client: ReturnType<typeof createClient>;
      org: Address;
      args: string[];
    }) => Promise<Hex>,
    done: (args: string[]) => string,
    /** The plan's specifics. Runs BEFORE any client exists, so a bad argument fails before anything is read. */
    plan: (args: string[], org: Address) => Pick<WritePlan, "action" | "permanent" | "warnings"> & { gas: number },
    /** Who may send it, and what to call it in the refusal ({@link adminRefusal}). */
    may: ["admin" | "offered", string],
  ) => {
    const c = cmd.command(name).description(description);
    c.argument("<org>", "org address");
    for (const [n, d] of args) c.argument(n, d);
    c.option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)");
    c.option("--yes", YES_HELP);
    c.action(async (...all: unknown[]) => {
      const opts = all[all.length - 2] as { chain?: string; yes?: boolean };
      const positional = all.slice(0, all.length - 2) as string[];
      const [orgArg, ...rest] = positional as [string, ...string[]];
      const org = asAddress(orgArg, "org address");
      const p = plan(rest, org);
      const chain = resolveChain(loadConfig(), opts.chain);
      const client = await createOrgClient(chain, { write: true, org });
      // An unreadable record is left to the chain to decide; the org's label below says why it could not be read.
      const record = await client.readOrg(org).catch(() => null);
      const refusal = record && adminRefusal(record, client.walletClient!.account!.address, ...may);
      if (refusal) throw new Error(refusal);
      const orgLabel = await describeOrg(client, org);
      const ok = await confirmWrite(
        client,
        {
          action: p.action,
          chainId: chain.chainId,
          org: orgLabel,
          steps: [{ what: name, txs: 1, gas: p.gas }],
          permanent: p.permanent,
          ...(p.warnings ? { warnings: p.warnings } : {}),
        },
        { yes: opts.yes },
      );
      if (!ok) return;
      const hash = await run({ client, org, args: rest });
      console.log(kleur.green("✓"), `${done(rest)} (org ${orgLabel})`, kleur.gray(txHash(hash)));
    });
  };

  write(
    "transfer-admin",
    "Offer the admin role to another address. It changes only when they accept",
    [["<to>", "address to offer the role to"]],
    async ({ client, org, args }) =>
      (await client.transferAdmin(assertSafeRecipient(args[0]!, { forbid: [org], what: "admin offer target" }))) as Hex,
    (a) => `offered the admin role to ${a[0]} — they must run \`abxfs org accept-admin\``,
    (a, org) => {
      // Validated BEFORE the prompt, so a mistyped address fails fast instead of after a "yes".
      const to = assertSafeRecipient(a[0]!, { forbid: [org], what: "admin offer target" });
      return {
        action: `offer this org's admin role to ${to}`,
        gas: WRITE_GAS.transferAdmin,
        permanent: [],
        warnings: [
          `You are offering the admin role to ${to}. If they accept, THEY decide who may mint into the org ` +
            "and whether it is open, and you lose that. Their address becomes public as admin. Check it carefully.",
        ],
      };
    },
    ["admin", "offer the admin role"],
  );
  write(
    "accept-admin",
    "Accept an admin role offered to you",
    [],
    async ({ client }) => (await client.acceptAdmin()) as Hex,
    () => "you are now the admin",
    () => ({
      action: "accept this org's admin role (it also closes the org)",
      gas: WRITE_GAS.acceptAdmin,
      permanent: ["your address, recorded as the org's admin (public; the role can only be handed on)"],
      warnings: [
        "Accepting makes YOUR address the org's public admin: you decide who may mint and whether it is open, " +
          "and your address is publicly tied to what is minted in it. Only accept an org you recognise.",
      ],
    }),
    ["offered", "accept it"],
  );
  write(
    "open",
    "Let anyone mint projects into the org (until it is closed; see the warning it prints)",
    [],
    async ({ client }) => (await client.setOpen(true)) as Hex,
    () => "org is open: anyone may mint",
    () => ({
      action: "open this org: let anyone mint projects into it",
      gas: WRITE_GAS.setOpen,
      permanent: ["every project anyone mints while it is open: projects are never removed from an org"],
      warnings: [OPEN_ORG_WARNING],
    }),
    ["admin", "open it"],
  );
  write(
    "close",
    "Restrict minting to the admin",
    [],
    async ({ client }) => (await client.setOpen(false)) as Hex,
    () => "org is closed: only the admin may mint",
    () => ({ action: "close this org: only the admin may mint", gas: WRITE_GAS.setOpen, permanent: [] }),
    ["admin", "close it"],
  );

  return cmd;
}
