# @abxfs/gateway

A reference **gateway** and **mirror** for ABX FS. Run your own, with whatever filtering rules you want
— or none.

ABX FS is a protocol: anyone can write bytes, nothing is owned, nothing can be removed. A gateway is
just a *reader* of it, and every reader makes its own choices about what it will serve. This package is a
complete one, runnable by anyone.

```bash
# one origin per project on a content domain you control (recommended)
abxfs-gateway --content-domain content.example

# one network of your choice, on your own RPC, refusing what a file names
ABXFS_RPC_URL_<chainId>=https://… abxfs-gateway --content-domain content.example --chains <network> --deny denylist.txt
```

> **Not on npm yet.** Until the packages are published, run it from a checkout:
> `pnpm install && pnpm --filter "@abxfs/gateway..." build && node packages/gateway/dist/bin/gateway.js --help`.
> Everywhere below, `abxfs-gateway` and `abxfs-mirror` mean `node packages/gateway/dist/bin/gateway.js`
> and `…/mirror.js`.

**You must choose how projects are addressed**, and there is no default, because it is a security
decision:

| Flag | Serves | Use for |
| --- | --- | --- |
| `--content-domain <host[:port]>` | one origin per project, from the `Host` header | **Anything public.** Recommended. |
| `--project <chain>/<org>/<id>` | one project at the root of the host | your own website at your own domain |
| `--path-mode` | `/g/p/…` and `/g/cid/…` on ONE shared origin | content you control only. **Unsafe for untrusted content.** |

## One origin per project

A project is a website, and anyone can publish one, so its JavaScript is not yours to trust. Served from one
origin, any project's script can read, replace or impersonate every other (local storage, cookies, service
workers) and anything else on that host. So each project gets its own origin, named by the `Host` header:

```text
https://<chain>-<org>-<id>.<content domain>/            a project's head
https://<chain>-<org>-<id>-v<n>.<content domain>/       a fixed version
https://c-<root>.<content domain>/                      raw content by root, no project needed
GET /healthz                                            on any host that is not a content host
```

`<org>` is 40 lowercase hex digits (no `0x`), `<root>` is 52 characters of lowercase base32, and the whole
label is at most 63 characters, so one wildcard certificate covers every project. Parsing is strict and
canonical (it is `parseContentHost` in `@abxfs/sdk`): `+84532`, `0x14a34`, leading
zeros, a `0x` prefix on the address, or a nested label are all a 404. Hostnames are case-insensitive, so the `Host`
is lowercased before it is parsed: an uppercase spelling is the same project, with the same filter subjects.
The request path is the path **inside** the project. Tags are not addressable by host (a tag may hold
characters a hostname cannot); use the version it points to.

You provide wildcard DNS for `*.<content domain>` and a wildcard certificate in front of the gateway (Caddy
with a DNS challenge, a load balancer, a CDN). Use a domain that holds nothing else, and ideally a separate
registrable domain from your app listed on the Public Suffix List. Locally, browsers resolve `*.localhost`:

```bash
abxfs-gateway --content-domain localhost:8080
# http://<chainId>-<org>-3.localhost:8080/
```

## What it does

For a request it works out which root CID is meant, serves the bytes, and tells you how long they may be
cached. It reads **the chain**, through `ChunkStore.read`, which checks every chunk against its record; like any dapp it
trusts the RPC it reads through, so give it one you trust. It serves only orgs the factory created: an address that merely *looks* like a project —
any ABX collection, any contract that answers `tokenParam` — is a 404, so nobody can have your gateway serve
their contract's content under your name.

Content is read from the ABX FS stores: which store holds a root is probed once and remembered. A path inside a
directory is found with the store's own lookup (one call on chain), so a 1,000-entry and a 6-entry directory cost the
same; a directory with no `index.html` is listed 100 entries per page (`?start=N`). A `Range` (`bytes=a-b`, `a-`,
`-n`) on a file without a file codec (FastLZ chunks included: their recorded sizes are of the inflated data) is a seek:
the store records every chunk's size, so one `locateByte` call finds the chunk holding the first byte and only the
chunks the range covers are read, anywhere in a file of any size. A slice is at most the file cap (`maxFileBytes`) and
1,024 chunks; its `Content-Range` states what was sent. A file with a codec (gzip and the like) is read whole under the
cap and decoded, and its output checked against the file's `outputHash`. A whole-file read over the cap is refused from
the file's recorded size, before any chunk is read. `gzip` and `deflate` are decoded everywhere; on Node,
`registerNodeCodecs` (which `abxfs-gateway` calls) adds `br` and `zstd`, capped at the file limit. A codec with no
decoder here is a `501` that names it, known from the file record before any chunk is read; an `outputHash` mismatch
is a `502` that says so. Both are remembered per CID and cacheable, like the `413`. A file whose chunks cannot be read
within the SDK's per-read call budget (the node answered, but the file's storage backend or the node's gas cap refused
the reads; a transport failure never counts against it) is a `502` that says so, remembered for a minute with a 60 s
`s-maxage`, per CID and per READ: a range for a ranged read, the whole file for a whole read (which is what a range of a
file with a codec is), in a map of its own so ranges cannot crowd out the day-long refusals. It would fail the same way
on the next request. A matching `If-None-Match` is a `304`
before any content is read.

Every response is `nosniff` with `Referrer-Policy: no-referrer`; SVG, XHTML, XML and XSL get
`Content-Security-Policy: sandbox` whatever case or parameters the declared type carries, and so do the three types a
browser answers by sniffing (`unknown/unknown`, `application/unknown`, `*/*`); HTML is served as
it is, because a working website is the product. The declared type is sent only when it is exactly ONE valid MIME
type (`mime.ts`): a browser splits `Content-Type` on commas and the last valid type wins, so `image/svg+xml,` is SVG
to it. Anything else is `application/octet-stream`, sandboxed. `X-Frame-Options` is deliberately **not** set, because
marketplaces embed project pages in an iframe. An unexpected failure is a generic `502 upstream error`; the
detail (URLs scrubbed) goes to your log, never to the visitor, because an RPC error can carry its API key.

Paths are strict: `.`, `..`, an empty segment, a backslash, a NUL, an encoded `/`, or a malformed
percent-escape is a `400`, and a redirect never leaves the origin. Paths of any practical depth resolve:
the directory stores take 32 segments per `resolvePath` call, so the SDK chains calls for deeper paths, up
to 256 segments (8 calls) per request; a longer path is a `404`, like any other path that names nothing.

### Caching

| Response | `Cache-Control` |
| --- | --- |
| a **root** host (`c-<root>.…`) serving the root itself | `public, max-age=31536000, immutable` (or `rootMaxAge`) |
| a **root** host serving anything else (`index.html`, a sub-path) | `public, max-age=60, s-maxage=60, stale-while-revalidate=30` |
| a **project** host, latest | `public, max-age=10, s-maxage=60, stale-while-revalidate=30` |
| a **project** host, `-v<n>` | `public, max-age=60, s-maxage=60, stale-while-revalidate=30` |

A pinned version is **not** immutable at the edge. A project's root is only known after it is resolved, so
a block on that root has to be able to reach a response that is already cached, and a minute is the bound. The same
holds for any CID a root host serves that is not the root itself. Only a root host's response for the root, whose
subject is the URL itself, is cached forever, and that is safe only when your filter runs AHEAD of every cache that
holds it. Behind a CDN you cannot purge, set `rootMaxAge` (`--root-max-age`) to a short value.

### No IPFS shortcut

A project's owner can name an `abxfs.gateway` URL (where it pinned the project on IPFS). The gateway does not fetch
through it: bytes from an IPFS gateway can only be trusted once checked against the IPFS CID of the on-chain
content, and deriving that reads the whole file from chain, which is the work the shortcut would exist to avoid.
Every file is served from chain.

## Hosting one project at the root of your own domain

A website uses links like `/style.css`, which mean "the root of this host". Give the project a host of its
own, so its root is the project's root:

```bash
abxfs-gateway --project <network>/0xORG/3 --port 8080     # follows latest
abxfs-gateway --project <network>/0xORG/3 --tag stable    # or pin a tag, or --version 2
```

Every path is now a path inside the project (`/docs/a.html` is `docs/a.html`), and nothing else is
served: no raw roots, no other project. Point your domain at it. The filters (`--deny`) still apply.

## Filtering

Two ways to run one, and you pick by which question you are answering:

| You want | Run |
| --- | --- |
| **Everything, except what I name** (open, with a blocklist) | `--deny denylist.txt` |
| **Only these orgs** | `--allow-orgs 0xAbc…,0xDef…` or `--allow-orgs orgs.txt` |

With neither, nothing is filtered. `--allow-orgs` takes addresses (comma separated, or a file with one
per line and `#` comments) and serves only the projects of those orgs, on any chain. A root host
(`c-<root>.…`) is refused under it: a root names content rather than an org, so there is nothing to
check it against. That is the point of an orgs-only gateway. It works the same on `abxfs-mirror`, so a
mirror can pin only the orgs you trust.

`--deny file` refuses a request that names anything in the file; `--allow file` serves **only**
requests that name something in it. Both are plain text, one **subject** per line, `#` for comments,
and the file is re-read when it changes, so you edit it and the gateway follows — no restart, no
service.

```text
# denylist.txt
project:<chainId>:<org>:<id>   # a comment
org:<chainId>:<org>
root:0x…64 hex…
```

| Subject | Covers |
| --- | --- |
| `project:<chain>:<org>:<id>` | that project's URLs |
| `org:<chain>:<org>` | every project URL under the org. **Not** its content by raw CID. |
| `root:<cid>` | that content, whatever points at it |

A request is refused if **any** subject it names is listed. Refusal is **451**, answered before the
chain is read, so a refused request costs nothing. A malformed line is reported and skipped; if the
file cannot be re-read the *last good list* stays in force (dropping to empty would turn a disk error
into "everything is allowed").

A request may run the filter more than once: with what the URL names, then with the root it resolved to and the CIDs
it serves. A filter you write must therefore be **idempotent** and side-effect free. It may answer
`{ allow: false, status: 503 }` to say "I cannot tell right now", which is served as a `503`, not a pass.

As a library, a filter is a function:

```ts
import { createGateway, chainsFromEnv, allOf, fileFilter } from "@abxfs/gateway";

const { chains, defaultChainId } = chainsFromEnv(); // ABXFS_DEFAULT_CHAIN as the bin reads it: one chain, or it throws
const gateway = createGateway({
  chains,
  defaultChainId,
  hostMode: { baseHost: "content.example" }, // exactly one of hostMode, project, pathMode
  filter: allOf(fileFilter("denylist.txt", "deny"), (ctx) => myPolicy(ctx.subjects)),
});

// gateway is (Request) => Promise<Response>: a Next.js route, node:http, Bun, a Worker.
```

## Configuration

| | |
| --- | --- |
| `ABXFS_RPC_URL_<chainId>` / `ABXFS_RPC_URL` | RPC endpoint. **Give it one.** Without it the registry's public endpoints are used, which are rate limited, and reading a large file costs gas in proportion to its size — more than some public nodes will execute. `ABXFS_RPC_URL_<chainId>` sets one chain; the unsuffixed `ABXFS_RPC_URL` applies to **every** chain this process serves. Each endpoint is asked `eth_chainId` before its first read, and one that answers for another chain fails every read from it (`WrongChainError`, logged; asked again after five minutes, so a fixed endpoint recovers without a restart), so a bare URL falling through to the wrong chain is refused rather than served. Still set a per-chain URL for each served chain, and use the bare form only with `--chains <one chain>`. |
| `--chains` / `ABXFS_CHAINS` | Network names (as the deployments page gives them) or chain ids, comma separated. Default (or blank): every canonical chain, or with `--project` the project's own chain. A value that names none (`,`) is refused, and so is one that leaves out `--project`'s chain. |
| `--content-domain` / `ABXFS_CONTENT_DOMAIN` | Serve per-project origins under this host (`host[:port]`). |
| `--default-chain` / `ABXFS_DEFAULT_CHAIN` | One chain: which chain a root host (`c-<root>.…`) is looked up on first; a CID carries none. Default: the first chain served (the first of `--chains`). If it does not store the root, the other chains this gateway serves are probed alongside it (the default chain gets a 150 ms head start); the first chain that has the root wins and is remembered. |
| `--port`, `--host` / `PORT`, `HOST` | Default `8080` on `127.0.0.1`. The host is an IP address (`0.0.0.0`, `::`) or a host name. |
| `--deny`, `--allow` / `ABXFS_DENYLIST`, `ABXFS_ALLOWLIST` | Filter files. |
| `--allow-orgs` / `ABXFS_ALLOW_ORGS` | Serve only these orgs: addresses or a file of them. |
| `--path-mode`, `--base-path` | The shared-origin layout, and its mount point (default `/g`, a path of plain segments). Unsafe for untrusted content. |
| `--cors <origin>` | Send `access-control-allow-origin`: `*`, or exactly one origin as a browser sends it (`https://app.example`, no path, no trailing slash). Off by default: leave the flag out, an empty value is refused. |
| `--max-file-bytes` / `ABXFS_MAX_FILE_BYTES` | The most one served file may be (stored and, if compressed, inflated). Default 64 MiB; a larger file is a `413`. |
| `--root-max-age <seconds>` / `ABXFS_ROOT_MAX_AGE` | How long a raw-root host's response for the root itself may be cached. Default a year, `immutable`; set a short value behind a CDN you cannot purge. |
| `--project <chain>/<org>/<id>` / `ABXFS_PROJECT`, `--tag`, `--version` | Serve one project at the root of the host; `--tag name` or `--version n` pins it (they are mutually exclusive), otherwise it follows latest. A tag must be one a project can have (`v1.2.0`; not empty, not `latest`: leave both out to follow latest). Either one without `--project` is refused. |

Every flag is checked before any chain is, `--content-domain` included (a URL or a path is refused as that flag). A bad
value, an unknown flag or a stray argument, a missing or doubled choice of mode, and a requested chain the SDK registry
has no addresses for ("not deployed": a chain gains them only once a deployment is verified), each stop the process with ONE
line, `[abxfs-gateway] NOT STARTED: …`, that names the flag, and exit code 2. A bad value read from an environment
variable (when its flag is not given) is named as that variable (`ABXFS_CONTENT_DOMAIN must be a bare host …`).
`abxfs-mirror` refuses the same way (`[mirror] NOT STARTED: …`), a missing `--chain` included; it takes exactly one chain.

### Before you expose one

- **Origin.** Use `--content-domain` on a domain that holds nothing else. A project is a website and HTML is
  deliberately *not* sandboxed, so anything on the same origin as a project (cookies, local storage, an
  admin page) is reachable by its script. `--path-mode` puts every project on one origin and is for
  content you control.
- **Cost.** Every cold request is chain reads. Put a CDN or a cache in front: a root host's root is `immutable`
  and caches forever, everything else for a minute. If your filter runs only in this handler (not ahead of the CDN),
  set `--root-max-age` so a later block can reach what the CDN holds.
- **A filter is a decision.** An empty list serves everything it can resolve. The protocol takes no
  position on content; yours will.

## The mirror

```bash
# follow forever, pin to a local Kubo node
abxfs-mirror --chain <network> --provider local

# catch up and exit — for cron
PINATA_JWT=… abxfs-mirror --chain <network> --provider pinata --once
```

`--chain` may also come from `ABXFS_CHAIN`.

Every publish, in every org, goes into one append-only ledger in the hook contract, and
`Lens.publishRange` reads it back with full records. So **mirroring everything published is one
cursor over one list**: no indexer, no database, and no log scan — providers prune logs, and a mirror
that depends on them silently stops finding things. The cursor lives in a JSON file (default base
`./abxfs-mirror.<chainId>.json`; the file actually written, one per factory, is
`./abxfs-mirror.<chainId>.<hook8>.json`, see below); a restart resumes, and
deleting it starts again from the first publish. It is advanced only *after* an entry is handled, so a crash replays at most one and never
skips one. A root that cannot be pinned is retried, then logged loudly and skipped, so one bad root
cannot hold up everything behind it.

`--deny`, `--allow` and `--allow-orgs` take the same values as the gateway, and are checked against each
entry's project, org and root, and then against every CID inside the root as it is walked (each `root:<cid>` with the
entry's own subjects, so an allowlist that admitted the entry admits its tree): the gateway refuses a blocked CID
wherever it is served, so a root that holds one is **skipped with a log line**, never pinned. That check reads nothing
extra: the directory listings that name those CIDs are read to assess the root anyway.

A root is permissionless input, and a mirror pins every publish, so one root has a budget:
`--max-root-bytes` (estimated stored size, default 256 MiB), `--max-files-per-root` (default 20,000),
`--max-entries-per-root` (directory entries read to assess a root, default 100,000) and, for a bounded cron run,
`--max-roots-per-run`. A root over a cap is **skipped with a log line saying why**
and the cursor moves past it. A directory has no size limit, but a large one has no flat IPFS form: Kubo shards a directory
whose name bytes plus 36 per entry pass 262,144 (`specs/abx-fs.md` §8), the HAMT-sharded form is not implemented, so
such a directory is skipped with a log line, never pinned under a wrong CID. Every other root, empty directories included, is pinned as exactly the blocks
ABX FS derives (a CAR), so the pinned root is the derived root. The key comes from `PINATA_JWT`; `--api-key` works but
warns, because a key on the command line is visible in shell history and `ps`.

A chain can have **more than one factory** once a factory has been superseded: orgs the old one made keep publishing
into its ledger. The mirror follows every factory the SDK registry lists, with **one cursor file each, named for that
factory's hook**: `<--cursor, minus .json>.<first 8 hex of the hook>.json`. It is keyed by hook and never by
position, because position changes the day a new factory ships (an index-keyed file would move to the new factory and
silently skip its ledger up to that index). Each file records its hook, and a file read for a different hook is
refused.

Factories run independently: one that fails (a stale cursor, an RPC error) is logged as `GENERATION FAILED`, the
others carry on, and the process exits `1` at the end. A factory with no lens in the registry is a startup error (exit
`2`), never a silent skip.

**What it cannot do:** pin content that was written to the stores but never published by any project.
The stores keep no enumeration of those, so mirroring *literally every byte* means watching the stores
directly. This mirrors everything anyone has *published*.

Providers: `local` (Kubo's HTTP API) and `pinata` from `@abxfs/pinning`, or implement `PinningProvider`.

## Docker

```bash
docker build -f packages/gateway/Dockerfile -t abxfs-gateway .      # from the repo root
docker run --rm -p 8080:8080 -e ABXFS_RPC_URL_<chainId>=https://… abxfs-gateway --content-domain content.example --chains <network>
```

The image also contains the mirror: `docker run … --entrypoint node abxfs-gateway dist/bin/mirror.js …`.
