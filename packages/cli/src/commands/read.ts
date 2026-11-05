import { Command } from "commander";
import kleur from "kleur";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { autoRegisterNodeCodecs, asAbxfsCid, readDirectory, ProjectKind, type AbxfsCid } from "@artblocks/abxfs-sdk";

import { parsePositiveInt } from "../args.js";
import { createClient } from "../client.js";
import { loadConfig, resolveChain } from "../config.js";
import { safe } from "../text.js";

/** The most directory entries `read` lists unless `--max-entries` says otherwise (a listing is read in full). */
export const DEFAULT_MAX_ENTRIES = 10_000;

export function readCommand(): Command {
  return new Command("read")
    .description("Read a file or directory from ABX FS")
    .argument("<cid>", "bytes32 CID (0x-prefixed) of a file or directory")
    .option("--path <posix>", "relative path within a directory (implies dir lookup)")
    .option("-o, --out <file>", "write a FILE's bytes to this path; otherwise stdout (a directory is listed, never written)")
    .option("--output <file>", "same as --out")
    .option("--force", "write binary data to a terminal anyway")
    .option("--max-entries <n>", `list at most this many directory entries; a bigger directory is refused (default ${DEFAULT_MAX_ENTRIES})`)
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .action(async (cidRaw: string, opts: { path?: string; out?: string; output?: string; force?: boolean; maxEntries?: string; chain?: string }) => {
      const maxEntries = opts.maxEntries !== undefined ? parsePositiveInt("--max-entries", opts.maxEntries) : DEFAULT_MAX_ENTRIES;
      const cid = asAbxfsCid(cidRaw as `0x${string}`);
      await autoRegisterNodeCodecs();
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const client = createClient(chain);
      const out = opts.out ?? opts.output;

      // What the CID is, asked of the chain FIRST. Trying a file read and falling back to a directory listing on any
      // error once reported a failed integrity check on a file (an RPC fabricating bytes) as "directory not found".
      let target: AbxfsCid = cid;
      let isDirectory: boolean;
      if (opts.path) {
        const res = await client.resolvePath(cid, opts.path);
        target = res.cid;
        isDirectory = res.isDirectory;
      } else {
        const kind = await client.cidKind(cid);
        if (kind === ProjectKind.Unset) {
          throw new Error(`${cid} is neither a file nor a directory in this chain's content stores (chain ${chain.chainId})`);
        }
        isDirectory = kind === ProjectKind.Directory;
      }

      if (isDirectory) {
        if (out) {
          throw new Error(
            `${target} is a directory: -o/--out writes one file's bytes, and a directory has none. Pick a file in it with ` +
              "--path <file>, or drop -o to list it.",
          );
        }
        const dir = await readDirectory(client.publicClient, client.addresses, target, { maxEntries });
        printDir(target, dir.entries);
        return;
      }
      const file = await client.readFile(target);
      writeOut(file.bytes, out, opts.force === true);
    });
}

function printDir(
  cid: AbxfsCid,
  entries: Array<{ name: string; cid: string; isDirectory: boolean }>,
): void {
  console.log(kleur.cyan("dir"), cid);
  for (const e of entries) {
    const tag = e.isDirectory ? kleur.blue("d") : kleur.gray("f");
    console.log(" ", tag, e.cid, safe(e.name));
  }
}

/** C1 controls (a lone U+009B is a CSI on many terminals) and bidi / invisible formatting characters. */
const UNSAFE_TEXT = /[\u0080-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e01ef}]/u;

/**
 * Whether bytes are unsafe to print to a terminal: anything but valid UTF-8 text with no C0 controls
 * (besides tab / newline / CR), no ESC, no C1 controls and no bidi or invisible formatting characters.
 * The WHOLE buffer is inspected: a hostile file can put its escape sequence after any prefix.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b === 0 || b === 0x1b || (b < 0x20 && b !== 9 && b !== 10 && b !== 13) || b === 0x7f) return true;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  return UNSAFE_TEXT.test(text);
}

function writeOut(bytes: Uint8Array, out?: string, force = false): void {
  if (out) {
    const abs = resolve(out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    console.log(kleur.green("✓"), `wrote ${bytes.length} bytes → ${safe(abs)}`);
  } else {
    if (process.stdout.isTTY && !force && looksBinary(bytes)) {
      throw new Error(
        "refusing to write binary data (or terminal control, bidi or invisible characters) to a terminal. Pass --output <file> to save it, or --force to print it anyway.",
      );
    }
    process.stdout.write(bytes);
  }
}
