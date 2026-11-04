#!/usr/bin/env node
/**
 * ABX FS CLI entry point.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import kleur from "kleur";
import { isUserRejection } from "@abxfs/sdk";

import { setAllowConfigOverrides } from "./config.js";
import { formatCliError } from "./redact.js";
import { diffCommand } from "./commands/diff.js";
import { devCommand } from "./commands/dev.js";
import { infoCommand } from "./commands/info.js";
import { orgCommand } from "./commands/org.js";
import { pinCommand } from "./commands/pin.js";
import { readCommand } from "./commands/read.js";
import { tagCommand } from "./commands/tag.js";
import { viewCommand } from "./commands/view.js";
import { transferCommand } from "./commands/transfer.js";
import { updateCommand } from "./commands/update.js";
import { uploadCommand } from "./commands/upload.js";
import { verifyCommand } from "./commands/verify.js";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("abxfs")
    .description(
      "ABX FS command-line interface — content-addressed, immutable file storage on any EVM chain.",
    )
    .version("0.0.0")
    // Program options only BEFORE the subcommand: otherwise `pin --project-version`'s old spelling, `--version`,
    // was taken by the program, which printed its version and exited 0 having done nothing.
    .enablePositionalOptions()
    .option(
      "--allow-config-overrides",
      "honour contract-address overrides from ./.abxfs.json (otherwise ignored with a warning; ABXFS_CONFIG and ~/.config/abxfs/config.json are always honoured)",
    )
    .hook("preAction", (thisCommand) => {
      if (thisCommand.opts()["allowConfigOverrides"]) setAllowConfigOverrides(true);
    });

  program.addCommand(orgCommand());
  program.addCommand(uploadCommand());
  program.addCommand(updateCommand());
  program.addCommand(readCommand());
  program.addCommand(infoCommand());
  program.addCommand(diffCommand());
  program.addCommand(tagCommand());
  program.addCommand(viewCommand());
  program.addCommand(transferCommand());
  program.addCommand(verifyCommand());
  program.addCommand(pinCommand());
  program.addCommand(devCommand());
  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  // The flag is global: accept it anywhere on the line (commander only knows it before the subcommand).
  const args = argv.filter((a) => a !== "--allow-config-overrides");
  if (args.length !== argv.length) setAllowConfigOverrides(true);
  try {
    await program.parseAsync(args);
  } catch (err) {
    const { label, message, details } = describeCliError(err);
    console.error(label === "cancelled" ? kleur.yellow("cancelled:") : kleur.red("error:"), message);
    for (const line of details ?? []) console.error(line);
    process.exitCode = 1;
  }
}

/**
 * What a failed command prints. Declining in a wallet is a cancellation, not a failure: it says so, without a viem
 * stack of "errors" (decided by type and EIP-1193 code, `isUserRejection`). Anything else is the error's message,
 * scrubbed: viem errors embed the RPC URL (often with an API key in the path), and on-chain strings may carry terminal
 * escapes, so nothing reaches the terminal unscrubbed (see `formatCliError`: a refusal the CLI made is printed as
 * itself, long hex is collapsed, and a timed-out transaction's explorer link comes back as a `details` line).
 */
export function describeCliError(err: unknown): { label: "cancelled" | "error"; message: string; details?: string[] } {
  if (isUserRejection(err)) {
    return {
      label: "cancelled",
      message:
        "the request was rejected in the wallet. Nothing more was sent; anything already written stays on chain, and " +
        "running the command again carries on from there.",
    };
  }
  const [message = "", ...details] = formatCliError(err);
  return { label: "error", message, ...(details.length > 0 ? { details } : {}) };
}

export { buildProgram };

/**
 * Whether this module is the program being run, as opposed to being imported (by a test, or by
 * another tool that wants `buildProgram`).
 *
 * Compares REAL paths. An installed CLI is started through a symlink — `node_modules/.bin/abxfs`
 * points at `dist/index.js`, and so does a global install — so `process.argv[1]` is the symlink, not
 * this file. Comparing the raw strings concluded "I was imported", ran nothing, and printed nothing,
 * not even an error: the published CLI would have installed cleanly and then silently done nothing.
 * It only ever worked when invoked by its direct path, which is how it is run inside the repo.
 */
const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  await run();
}
