# @artblocks/abxfs-pinning

Pin ABX FS content (a directory tree or a single file) to IPFS, from chain.

## What it does

- Reads the content from chain with `@artblocks/abxfs-sdk`, each distinct file and directory once (FastLZ chunks inflated on
  chain, a file codec decoded and checked against its `outputHash`).
- Derives its IPFS DAG with the SDK's profile (CIDv1, sha2-256, 256 KiB raw leaves, balanced dag-pb files, flat dag-pb
  directories) and keeps every block.
- Writes those blocks to a CARv1 whose root is the derived root, and hands it to a provider, which imports the blocks
  and pins the root. The provider rebuilds nothing, so the pinned DAG is the derived DAG for any tree: empty
  directories, empty files and files stored with a codec need no special handling.
- Checks the root the provider reports against the derived one.
- Refuses a directory that IPFS would shard into a HAMT (the sum, over its entries, of each name's bytes plus 36
  passes 262,144: never at 900 entries or fewer, always at 7,085 or more), with
  `DirectoryTooLargeForFlatIpfsError`, before reading any file: the sharded form is not implemented yet, so no
  correct IPFS CID exists for it.

## Installation

> **Not on npm yet.** Until the packages are published, build it from a checkout:
> `pnpm install && pnpm --filter "@artblocks/abxfs-pinning..." build`. Once they are:

```bash
pnpm add @artblocks/abxfs-pinning @artblocks/abxfs-sdk
```

## Usage

```typescript
import { AbxfsClient } from "@artblocks/abxfs-sdk";
import { pinRoot, deriveCar, localPinningProvider } from "@artblocks/abxfs-pinning";

const client = new AbxfsClient({ publicClient, addresses });
const provider = localPinningProvider({ endpoint: "http://127.0.0.1:5001" });

// A directory or a file: the kind is probed when not given.
const result = await pinRoot({ client, root: "0xabcd…", provider });
console.log(result.pinnedCid, result.verified);

// Or just the CAR, for any service that takes one (`ipfs dag import`, Storacha, Filebase, …).
const { root, car } = await deriveCar({ client, root: "0xabcd…" });
```

`pinDirectory` and `pinFile` are `pinRoot` with the kind fixed.

## Built-in providers

| Provider                | Service                                         | Auth                              |
| ----------------------- | ----------------------------------------------- | --------------------------------- |
| `localPinningProvider`  | Kubo RPC API (`/api/v0/dag/import`, pins roots) | optional headers                  |
| `pinataPinningProvider` | Pinata v3 files API (`POST /v3/files`, `car=true`, public network) | `apiKey` (a v3 JWT that can write, read and delete files) |

A provider is one method, `pinCar({ root, car, name })`, plus `name`, `unpin`, `isPinned` and an optional
`preflight()` that `pinRoot` calls before it reads anything from chain: implement
[`PinningProvider`](./src/types.ts) for any other service that accepts a CAR.

`deriveCar` and `pinRoot` take a `limits` option (`{ maxNodes, maxBytes }`, 100,000 nodes and 1 GiB by default;
`LimitExceededError` past either). The providers' HTTP calls time out on progress, not on a fixed clock: connect
30 s, a stalled upload or response body 60 s, the response headers 300 s after the upload ends (`DEFAULT_TIMEOUTS`);
replies are read up to 1 MiB and redirects are never followed. On Node's own `fetch` that needs a dispatcher without
undici's fixed 300 s header timeout, so the providers make one of the global dispatcher's class when it is Node's
default `Agent` or an `EnvHttpProxyAgent`: options of a global `Agent` you configured yourself (TLS, connection limits)
are not carried over, and any other global dispatcher (a `ProxyAgent`, say) is used as it is, with undici's timeouts.
To keep your own transport and still get the progress timeouts, pass the provider a `fetch` that sets its dispatcher.

Pinning is opt-in: the content is on chain and the gateway serves it from there. Use `abxfs pin`, or call
`pinRoot` directly; `abxfs-mirror` (`@artblocks/abxfs-gateway`) pins everything published.

See [the IPFS docs](https://docs.fs.abx.io/docs/using-abxfs/ipfs) for how a pinned root can be advertised
(a project's `abxfs.gateway`, a hint the ABX FS gateway itself does not fetch through).
