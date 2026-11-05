/**
 * `abxfs pin` — pin ABX FS content (a directory tree or a single file) to IPFS.
 *
 * Resolution rules:
 *   --cid <bytes32>                  pin that exact root (a directory or a file)
 *   --project-id <id>                pin the project's current root
 *   --project-id <id> --project-version <n>  pin the root at version `n` (1-based)
 *
 * The tree is read from chain and its IPFS DAG derived locally; every block goes to the service as one CAR, which the
 * service imports and pins. Destinations:
 *   --provider local      (Kubo RPC API; defaults to http://127.0.0.1:5001)
 *   --provider pinata     (Pinata v3 files API; requires PINATA_JWT or --api-key)
 *   --car <path>          write the CAR to a file instead of uploading it
 *
 * The pinned root is checked against the derived one, and then against the on-chain resolver where it can derive the
 * CID (not for a file stored with a codec, or on a chain without a resolver); a mismatch exits non-zero.
 */
import { closeSync, createWriteStream, openSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { Command, Option } from "commander";
import kleur from "kleur";

import { autoRegisterNodeCodecs, asAbxfsCid, CodecNotSupportedOnChainError, type AbxfsCid, type AbxfsClient } from "@artblocks/abxfs-sdk";
import {
  deriveCar,
  localPinningProvider,
  pinataPinningProvider,
  pinRoot,
  type PinnedFile,
  type PinningProvider,
} from "@artblocks/abxfs-pinning";

import { parsePositiveInt, parseTokenId } from "../args.js";
import { createClient, createOrgClient } from "../client.js";
import { loadConfig, requireOrg, resolveChain } from "../config.js";
import { redactUrl, registerSecret } from "../redact.js";
import { ipfsCidText, safe } from "../text.js";

interface PinCmdOpts {
  cid?: string;
  projectId?: string;
  projectVersion?: string;
  /** The old spelling of `--project-version`, kept only to refuse it with a pointer to the new one. */
  version?: string;
  provider: "local" | "pinata";
  endpoint?: string;
  apiKey?: string;
  car?: string;
  chain?: string;
  org?: string;
  /** Commander's `--no-verify`: false when passed. */
  verify?: boolean;
}

export function pinCommand(): Command {
  return new Command("pin")
    .description("Pin ABX FS content (a directory or a file) to IPFS: local Kubo, Pinata, or a CAR file")
    .option("--cid <bytes32>", "root to pin (a directory or a file)")
    .option("--project-id <id>", "project id; pins the current version unless --project-version is set")
    .option("--project-version <n>", "1-based version of the project to pin (default: its current version)")
    // `abxfs --version` is the program's own flag; a subcommand flag of the same name was swallowed by it.
    .addOption(new Option("--version <n>", "renamed: use --project-version").hideHelp())
    .option("--provider <name>", "local | pinata", "local")
    .option("--endpoint <url>", "override the provider endpoint")
    .option(
      "--api-key <key>",
      "API key for a hosted provider (prefer env PINATA_JWT: a flag leaks to shell history and `ps`)",
    )
    .option("--car <path>", "write the CAR to <path> instead of uploading it (`ipfs dag import`, or any service that takes CARs)")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--org <address>", "the org the project lives in (default: ABXFS_ORG or the chain's `org` in config)")
    .option("--no-verify", "skip comparing the pinned root with the on-chain resolver's CID")
    .action(async (opts: PinCmdOpts) => {
      if (opts.version !== undefined) {
        throw new Error("`pin --version` is now `--project-version` (`abxfs --version` prints the CLI's own version)");
      }
      // Offline checks first: a bad id or version, or a missing Pinata key, must not wait for a chain read.
      if (opts.cid) asAbxfsCid(opts.cid as `0x${string}`);
      const projectId = opts.projectId !== undefined ? parseTokenId("--project-id", opts.projectId) : undefined;
      const projectVersion = opts.projectVersion !== undefined ? parsePositiveInt("--project-version", opts.projectVersion) : undefined;
      if (projectVersion !== undefined && projectId === undefined) throw new Error("--project-version needs --project-id");
      const provider = opts.car ? undefined : makeProvider(opts);

      await autoRegisterNodeCodecs();
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const org = projectId !== undefined ? requireOrg(chain, opts.org) : undefined;

      // The destination is checked before anything is read from chain (the org's factory included) and the tree is
      // hashed: an unreachable node or a rejected key used to surface only after the whole derivation. `--car` opens
      // its file now, refusing to overwrite one.
      let carFd: number | undefined;
      if (provider) {
        console.log(kleur.cyan("provider"), provider.name);
        await provider.preflight?.();
      } else if (opts.car) {
        carFd = openSync(opts.car, "wx");
      }

      let carWritten = false;
      try {
        // An org is only needed to name a project; `--cid` pins content with no project at all.
        const client = org !== undefined ? await createOrgClient(chain, { org }) : createClient(chain);
        const root = await resolveRoot(client, opts, projectId, projectVersion);
        console.log(kleur.cyan("pin"), root);
        const onFile = ({ path, ipfsCid }: PinnedFile) => {
          console.log(kleur.gray("  + "), path ? safe(path) : kleur.gray("(file)"), kleur.gray(ipfsCidText(ipfsCid)));
        };

        let pinned: string;
        if (carFd !== undefined) {
          const derived = await deriveCar({ client, root, onFile });
          // Streamed to disk: a large CAR is never copied into one more buffer.
          const out = createWriteStream(opts.car!, { fd: carFd });
          carFd = undefined; // the stream owns (and closes) it now
          await pipeline(Readable.fromWeb(derived.car.stream() as unknown as NodeReadableStream<Uint8Array>), out);
          carWritten = true;
          console.log(
            kleur.green("wrote"),
            safe(opts.car),
            kleur.gray(`(${derived.kind}, ${derived.blockCount} blocks, ${derived.car.size} bytes)`),
          );
          console.log(kleur.green("root"), ipfsCidText(derived.root));
          console.log(kleur.gray("  import it with `ipfs dag import --pin-roots <file>`, or upload it to any service that takes CAR files"));
          pinned = derived.root;
        } else {
          // pinRoot throws if the provider reports any root but the derived one.
          const result = await pinRoot({ client, root, provider: provider!, onFile });
          console.log(
            kleur.green("pinned"),
            ipfsCidText(result.pinnedCid),
            kleur.gray(`(${result.kind}, ${result.blockCount} blocks, ${result.carBytes} bytes)`),
          );
          pinned = result.pinnedCid;
        }

        if (opts.verify === false) return;
        const onChain = await onChainIpfsCid(client, root);
        if (onChain === undefined) {
          console.log(kleur.green("✓ root derived from chain"), kleur.gray("(the on-chain resolver cannot derive this one)"));
          return;
        }
        if (onChain !== pinned) {
          throw new Error(`on-chain IPFS CID (${ipfsCidText(onChain)}) differs from pinned root (${ipfsCidText(pinned)})`);
        }
        console.log(kleur.green("✓ on-chain CID matches pinned root"));
      } catch (e) {
        // A CAR file this run created (the open above refused an existing one) and did not finish is removed, so a
        // half-written archive is never left behind. A finished one stays even if the check after it fails.
        if (carFd !== undefined) closeSync(carFd);
        if (opts.car && !carWritten) rmSync(opts.car, { force: true });
        throw e;
      }
    });
}

async function resolveRoot(
  client: ReturnType<typeof createClient>,
  opts: PinCmdOpts,
  projectId: bigint | undefined,
  projectVersion: number | undefined,
): Promise<AbxfsCid> {
  if (opts.cid) {
    return asAbxfsCid(opts.cid as `0x${string}`);
  }
  if (projectId === undefined) {
    throw new Error("provide --cid or --project-id");
  }
  const id = projectId;
  const project = await client.readProject(id);

  if (projectVersion !== undefined) {
    const version = projectVersion;
    if (version > project.versionCount) {
      throw new Error(
        `--project-version ${version} is out of range (project #${id} has ${project.versionCount} versions)`,
      );
    }
    // The hook holds the history, so fetch just the one record rather than the whole array.
    const [record] = await client.projectVersions(id, { start: version - 1, end: version });
    if (!record) throw new Error(`version ${version} not found for project #${id}`);
    return record.cid;
  }

  if (!project.cid) {
    throw new Error(`project #${id} has not published anything yet — nothing to pin`);
  }
  return project.cid;
}

/** `localhost`, `127.0.0.1` and `[::1]` only. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * The credential for a hosted provider: `--api-key`, else the provider's env var. A key must never be
 * attached to a plaintext request, so a non-https `--endpoint` is refused (loopback excepted).
 */
export function resolveApiKey(opts: Pick<PinCmdOpts, "provider" | "apiKey" | "endpoint">): string | undefined {
  const envName = opts.provider === "pinata" ? "PINATA_JWT" : undefined;
  let key = opts.apiKey;
  if (key) {
    registerSecret(key);
    console.error(
      kleur.yellow("warning:"),
      "--api-key puts the secret in your shell history and the process list (`ps`)." +
        (envName ? ` Prefer the ${envName} environment variable.` : ""),
    );
  } else if (envName) {
    key = process.env[envName];
  }
  if (key && opts.endpoint) {
    let u: URL;
    try {
      u = new URL(opts.endpoint);
    } catch {
      throw new Error("--endpoint is not a valid URL");
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
      throw new Error(
        `refusing to send an API key to ${safe(redactUrl(opts.endpoint))}: a non-https --endpoint is only allowed for localhost`,
      );
    }
  }
  return key;
}

function makeProvider(opts: PinCmdOpts): PinningProvider {
  switch (opts.provider) {
    case "local":
      return localPinningProvider({ endpoint: opts.endpoint ?? "http://127.0.0.1:5001" });
    case "pinata": {
      const apiKey = resolveApiKey(opts);
      if (!apiKey) throw new Error("an API key is required for the pinata provider: set PINATA_JWT (or pass --api-key)");
      // A custom --endpoint (a proxy) stands in for both of Pinata's hosts.
      return pinataPinningProvider(opts.endpoint ? { apiKey, endpoint: opts.endpoint } : { apiKey });
    }
    default:
      throw new Error(`unknown provider "${safe(String(opts.provider))}": use local or pinata, or --car <path> for any other service`);
  }
}

/** The on-chain resolver's IPFS CID for `root`, or undefined where it cannot derive one (no resolver, or a codec file). */
async function onChainIpfsCid(client: AbxfsClient, root: AbxfsCid): Promise<string | undefined> {
  if (!client.addresses.ipfsCidResolver) return undefined;
  try {
    return await client.verifyOnChainIpfsCid(root);
  } catch (e) {
    if (e instanceof CodecNotSupportedOnChainError) return undefined;
    throw e;
  }
}

/**
 * The IPFS CID of `cid`, from the on-chain resolver when it can derive it, else locally. Says which, because "the
 * chain computed this" is a stronger statement than "this machine read the chain and computed it".
 */
export async function deriveIpfsCid(
  client: AbxfsClient,
  cid: AbxfsCid,
): Promise<{ cid: string; where: "on-chain" | "locally derived" }> {
  const onChain = await onChainIpfsCid(client, cid);
  if (onChain !== undefined) return { cid: onChain, where: "on-chain" };
  return { cid: await client.verifyLocalIpfsCid(cid), where: "locally derived" };
}
