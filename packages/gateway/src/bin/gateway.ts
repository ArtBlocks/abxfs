#!/usr/bin/env node
/**
 * `abxfs-gateway` — serve ABX FS content over HTTP.
 *
 *   abxfs-gateway --content-domain content.example           one origin per project (recommended)
 *   abxfs-gateway --project <chain>/<org>/<id>                one project at the host root
 *   abxfs-gateway --path-mode                                 shared-origin /g/… (UNSAFE for untrusted content)
 *   … --chains <network> --port 8080
 *   … --deny denylist.txt                                     refuse what the list names
 *   … --allow allowlist.txt                                   serve ONLY what the list names
 *
 * RPC endpoints come from ABXFS_RPC_URL_<chainId> (or ABXFS_RPC_URL); without them the registry's
 * public endpoints are used, which are rate limited. See the README.
 */
import { parseArgs } from "node:util";

import { validateTagName } from "@abxfs/sdk";

import {
  CHAIN_NAMES,
  chainsFromEnv,
  parseBasePath,
  parseChainList,
  parseCorsOrigin,
  parseListenHost,
  parseMaxFileBytes,
  parseOneChain,
  parseRootMaxAge,
  requireDeployed,
} from "../config.js";
import { allOf, fileFilter, orgAllowlistFromArg } from "../filters.js";
import { registerNodeCodecs } from "../codecs.js";
import { DEFAULT_MAX_FILE_BYTES, createGateway, normalizeBaseHost } from "../handler.js";
import { createGatewayServer } from "../server.js";
import type { Filter } from "../types.js";

/**
 * A start-up refusal: ONE line on stderr and exit 2, never a stack trace (as `abxfs-mirror` refuses to start). A bad
 * flag, an unknown one, the choice of mode and a chain that is not deployed are all the operator's to fix, and each is
 * said as what it is. One line even when the error is several (node's "argument is ambiguous" for `--port -1` is three).
 */
function notStarted(err: unknown): never {
  console.error(`[abxfs-gateway] NOT STARTED: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim()}`);
  process.exit(2);
}
function atStartup<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    return notStarted(err);
  }
}

/** The environment variable each option falls back to when its flag is not given. */
const ENV = {
  port: "PORT",
  host: "HOST",
  chains: "ABXFS_CHAINS",
  "default-chain": "ABXFS_DEFAULT_CHAIN",
  deny: "ABXFS_DENYLIST",
  allow: "ABXFS_ALLOWLIST",
  "allow-orgs": "ABXFS_ALLOW_ORGS",
  "content-domain": "ABXFS_CONTENT_DOMAIN",
  project: "ABXFS_PROJECT",
  "max-file-bytes": "ABXFS_MAX_FILE_BYTES",
  "root-max-age": "ABXFS_ROOT_MAX_AGE",
} as const;

// An unknown flag (a typo such as --content-domian), a stray argument or a flag without its value is a refusal too.
const { values, tokens } = atStartup(() => parseArgs({
  tokens: true,
  options: {
    port: { type: "string", short: "p", default: process.env[ENV.port] ?? "8080" },
    host: { type: "string", default: process.env[ENV.host] ?? "127.0.0.1" },
    chains: { type: "string", default: process.env[ENV.chains] },
    "default-chain": { type: "string", default: process.env[ENV["default-chain"]] },
    deny: { type: "string", default: process.env[ENV.deny] },
    allow: { type: "string", default: process.env[ENV.allow] },
    "allow-orgs": { type: "string", default: process.env[ENV["allow-orgs"]] },
    "content-domain": { type: "string", default: process.env[ENV["content-domain"]] },
    "path-mode": { type: "boolean", default: false },
    project: { type: "string", default: process.env[ENV.project] },
    tag: { type: "string" },
    version: { type: "string" },
    "base-path": { type: "string", default: "/g" },
    cors: { type: "string" },
    "max-file-bytes": { type: "string", default: process.env[ENV["max-file-bytes"]] },
    "root-max-age": { type: "string", default: process.env[ENV["root-max-age"]] },
    help: { type: "boolean", short: "h", default: false },
  },
}));

const onCommandLine = new Set<string>(tokens.flatMap((t) => (t.kind === "option" ? [t.name] : [])));
/** What a refusal calls an option: its flag, or the environment variable its value came from when the flag was not given. */
function named(option: string): string {
  const env = (ENV as Record<string, string | undefined>)[option];
  return env !== undefined && !onCommandLine.has(option) && process.env[env] !== undefined ? env : `--${option}`;
}
/**
 * {@link atStartup} for one option's check, said as {@link named} says it: the flag (or the variable) replaces the flag
 * in the error, and names it when the error does not (an unreadable list file says only its path).
 */
function flagAtStartup<T>(option: string, check: () => T): T {
  const name = named(option);
  return atStartup(() => {
    try {
      return check();
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split(`--${option}`).join(name);
      throw new Error(message.includes(name) ? message : `${name}: ${message}`);
    }
  });
}

if (values.help) {
  console.log(`abxfs-gateway [--port 8080] [--host 127.0.0.1] [--chains <network>,…]
              [--default-chain <network>] [--allow-orgs 0xA,0xB|file] [--deny file] [--allow file]
              [--base-path /g] [--cors <origin>]
              [--max-file-bytes 67108864] [--root-max-age 31536000]

  Choose exactly ONE way to address content:

  --content-domain <host[:port]>
                one origin per project (recommended). A project is served at
                https://<chain>-<org>-<id>[-v<n>].<host>/ and raw content at https://c-<root>.<host>/,
                so a website's own /style.css works and one project's script can never touch another's.
                Put wildcard DNS and TLS for *.<host> in front. Use a SEPARATE registrable domain from
                anything that holds cookies or logins. Local: --content-domain localhost:8080 and open
                http://<chain>-<org>-<id>.localhost:8080/ (browsers resolve *.localhost to loopback).
  --path-mode   the shared-origin /g/p/… and /g/cid/… layout. UNSAFE for content you do not trust: every
                project shares ONE origin, so any project's script can read and impersonate every other.

  --project <chain>/<org>/<id>
                serve ONE project at the root of this host, for a website that uses root-absolute
                links (/style.css). [--tag name | --version n] to pin it; default follows latest.
  --max-file-bytes
                the most one served file may be (stored and, if compressed, inflated). Default 64 MiB;
                a larger file is a 413.
  --root-max-age <seconds>
                how long a raw-root host's response for the root itself may be cached. Default a year,
                immutable: right only when your filter runs AHEAD of every cache (a CDN in front of this
                process keeps an immutable response after a block). Behind a CDN you cannot purge, set a
                short value (60). Anything under a root other than the root itself is never immutable.
  --allow-orgs  serve ONLY these orgs' projects: addresses, comma separated, or a file of them.
                Bare /g/cid/<root> URLs are refused (a root names content, not an org).
  --deny   one subject per line; refuse any request that names one. # comments ok.
  --allow  one subject per line; serve ONLY requests that name one.
  subjects: project:<chain>:<org>:<id>  org:<chain>:<org>  root:<0x…cid>`);
  process.exit(0);
}

const log = (line: string) => console.error(`[gateway] ${line}`);

// EVERY flag is checked before any chain is: a bad value is the operator's to fix first, deployed chain or not.
const filters: Filter[] = [];
const fileOpts = {
  onInvalid: (line: string, n: number) => log(`ignoring line ${n}, not a subject: ${line}`),
  onError: (err: unknown) => log(`could not re-read list, keeping the last good one: ${String(err)}`),
};
if (values.deny) filters.push(flagAtStartup("deny", () => fileFilter(values.deny!, "deny", fileOpts)));
if (values.allow) filters.push(flagAtStartup("allow", () => fileFilter(values.allow!, "allow", fileOpts)));
if (values["allow-orgs"]) filters.push(flagAtStartup("allow-orgs", () => orgAllowlistFromArg(values["allow-orgs"]!, fileOpts)));
const rootMaxAge = values["root-max-age"] ? flagAtStartup("root-max-age", () => parseRootMaxAge(values["root-max-age"]!)) : undefined;
const maxFileBytes = values["max-file-bytes"] ? flagAtStartup("max-file-bytes", () => parseMaxFileBytes(values["max-file-bytes"]!)) : DEFAULT_MAX_FILE_BYTES;
const port = flagAtStartup("port", () => {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(values.port) || Number(values.port) > 65_535) throw new Error(`--port expects a port number, 0 to 65535 (got "${values.port}")`);
  return Number(values.port);
});
const host = flagAtStartup("host", () => parseListenHost(values.host));
const cors = values.cors !== undefined ? flagAtStartup("cors", () => parseCorsOrigin(values.cors!)) : undefined;
const basePath = flagAtStartup("base-path", () => parseBasePath(values["base-path"]));
const requestedChains = flagAtStartup("chains", () => {
  // Blank is unset (every deployed chain, or --project's own); a value that names no chain (",") is a mistake, never "every chain".
  const ids = parseChainList(values.chains);
  if (ids?.length === 0) throw new Error(`--chains expects chains, comma separated: ${CHAIN_NAMES} (got "${values.chains}")`);
  return ids;
});
const requestedDefault = flagAtStartup("default-chain", () => parseOneChain(values["default-chain"], "--default-chain"));
// The same check `createGateway` makes, made here so a URL or a path is refused as the flag (or variable) it came from,
// before any chain.
const contentDomainFlag = values["content-domain"]?.trim();
const contentDomain = contentDomainFlag ? flagAtStartup("content-domain", () => normalizeBaseHost(contentDomainFlag, "--content-domain")) : undefined;

function projectOption() {
  if (!values.project) {
    // A pin of nothing: --tag or --version without --project used to be ignored, and the gateway served something else.
    for (const pin of ["tag", "version"] as const) if (values[pin] !== undefined) throw new Error(`--${pin} pins --project, and no project is given`);
    return undefined;
  }
  const flag = named("project");
  const [chain, org, id, ...extra] = values.project.split("/");
  // One chain: a list is refused, never read as its first. Its errors name the flag (or variable) already.
  const chainId = parseOneChain(chain, flag);
  if (!chainId || !org || !/^0x[0-9a-fA-F]{40}$/.test(org) || !id || !/^(0|[1-9][0-9]*)$/.test(id) || extra.length) {
    throw new Error(`${flag} expects <chain>/<org>/<id> (got "${values.project}")`);
  }
  if (values.tag !== undefined && values.version !== undefined) throw new Error("--tag and --version are mutually exclusive");
  if (values.tag !== undefined) {
    // An empty or malformed tag used to be dropped, and the gateway followed latest: a pin that silently was not one.
    const tag = validateTagName(values.tag);
    if (!tag.ok) throw new Error(`--tag expects a tag name such as v1.2.0 (got "${values.tag}")${values.tag === "" ? "" : `: ${tag.error}`}`);
  }
  if (values.version !== undefined && !/^[1-9][0-9]{0,8}$/.test(values.version)) {
    throw new Error(`--version expects a version number, 1 or more (got "${values.version}")`);
  }
  return {
    chainId,
    org,
    tokenId: BigInt(id),
    ...(values.tag !== undefined ? { tag: values.tag } : {}),
    ...(values.version !== undefined ? { version: Number(values.version) } : {}),
  };
}
const project = atStartup(projectOption);

const chosen = [Boolean(contentDomain), values["path-mode"], Boolean(project)].filter(Boolean).length;
if (chosen !== 1) {
  notStarted(
    "choose exactly one of --content-domain <host> (recommended), --project <chain>/<org>/<id>, or --path-mode " +
      "(--help says what each one means). There is no default: how a gateway separates projects is a security decision.",
  );
}

// Then the chains: --chains, else the project's own chain for --project, else every one in the registry. A chain the
// registry has no addresses for is "not deployed", and a request that names no deployed chain is one line, exit 2.
const { chains, defaultChainId } = atStartup(() =>
  requireDeployed(chainsFromEnv(process.env, requestedChains ?? (project ? [project.chainId] : undefined), requestedDefault), (msg) =>
    console.error(`[abxfs-gateway] not serving ${msg}`),
  ),
);

if (values["path-mode"]) {
  console.error(
    "[gateway] WARNING: --path-mode serves every project from ONE origin. Any project's script can read and\n" +
      "[gateway] impersonate every other project and anything else on this host. Do not use it for content you do not control.",
  );
}

// br and zstd from node:zlib (gzip and deflate come from the platform's streams), each capped at the file limit.
await registerNodeCodecs({ maxOutputBytes: maxFileBytes });

// Every option was checked above; this is the backstop, so a check `createGateway` makes and this file does not is
// still one line and exit 2, never a stack trace.
const handler = atStartup(() =>
  createGateway({
    chains,
    defaultChainId,
    // A raw-root host names no chain: try the default first, then every other chain this gateway serves.
    ...(contentDomain ? { hostMode: { baseHost: contentDomain }, rootChains: chains.map((c) => c.id) } : {}),
    ...(values["path-mode"] ? { pathMode: { basePath } } : {}),
    ...(project ? { project } : {}),
    maxFileBytes,
    ...(rootMaxAge !== undefined ? { rootMaxAge } : {}),
    ...(filters.length ? { filter: filters.length === 1 ? filters[0]! : allOf(...filters) } : {}),
  }),
);

const server = createGatewayServer({
  handler,
  basePath,
  ...(project ? { projectMode: true } : {}),
  ...(contentDomain ? { hostMode: { baseHost: contentDomain } } : {}),
  ...(cors ? { cors } : {}),
  onRequest: ({ method, path, status, ms }) => log(`${status} ${method} ${path} ${ms}ms`),
});

server.listen(port, host, () => {
  log(
    project
      ? `serving ${values.project} at http://${host}:${port}/`
      : contentDomain
        ? `listening on http://${host}:${port}; serving https://<project>.${contentDomain}/ (send Host: <chain>-<org>-<id>.${contentDomain})`
        : `listening on http://${host}:${port}${basePath} (path mode)`,
  );
  log(`chains: ${chains.map((c) => `${c.name ?? c.id} (${c.id})`).join(", ")}; /cid defaults to ${defaultChainId}`);
  log(filters.length ? `filtering: ${[values.deny && `deny ${values.deny}`, values.allow && `allow ${values.allow}`, values["allow-orgs"] && `orgs only (${values["allow-orgs"]})`].filter(Boolean).join(", ")}` : "filtering: none");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
