# @abxfs/cli

Command-line client for ABX FS: upload content, publish projects, and administer orgs.

> **Not on npm yet.** Until the packages are published, run it from a checkout:
> `pnpm install && pnpm --filter "@abxfs/cli..." build && node packages/cli/dist/index.js --help`.

```bash
abxfs upload ./site --name my-site --chain <network>     # first run creates your own org
abxfs info --project-id 0 --org 0x… --chain <network>
abxfs org list --chain <network>
```

Needs `ABXFS_PRIVATE_KEY` for anything that writes (never read from disk). Reads need nothing: the
canonical deployments and public RPC endpoints are built in, though you should set
`ABXFS_RPC_URL_<chainId>` to your own — the public ones are rate limited and cap `eth_call` gas. The unsuffixed
`ABXFS_RPC_URL` applies only to the chain a command selects (and never over a configured `rpcUrl` or an
`ABXFS_RPC_URL_<chainId>`); the CLI says which chain it applied to. A custom chain in your config with no `rpcUrl` is
refused when selected (give it an `rpcUrl` or `ABXFS_RPC_URL_<chainId>`; the unsuffixed variable does not apply to
it), and never stops commands on other chains.

**Every paid write shows its plan and asks first.** Before the first transaction the CLI prints the chain, the org,
how many transactions, the estimated gas, the most it can cost at the fee ceiling, and what becomes permanent; on a
terminal you type `yes`. Without a terminal it refuses unless you pass `--yes`. `--dry-run` needs neither. The max
cost is gas only: on an OP-stack rollup each transaction also pays an L1 data fee for its calldata, which it does
not include (the plan says so there).

**Every command takes `--chain <network>`** (except `dev`, which runs its own local chain): the production or test
network of your choice, by the name the
[deployments](https://docs.fs.abx.io/docs/reference/deployments) page gives it. There is no default, and a command
without one lists the names; to stop passing it, set `ABXFS_CHAIN`, or `defaultChain` in
`~/.config/abxfs/config.json`. On a production network every write
costs real funds, so try a flow on a testnet first. `abxfs dev --i-trust-this-dir` runs a local chain with the content layer deployed and writes a config for it.

`upload` keeps empty folders, as `ipfs add -r` does.

## Compression

Two choices, and both are part of every CID, so `upload`, `update` and `diff` must agree on them:

- `--codec <none|gzip>` — a file codec, decoded off chain by readers. Default `none`, or the chain's `defaultCodec`
  in your config. gzip is the only one offered because it is the one every reader decodes natively.
- `--no-fastlz` — store every chunk raw. By default each chunk goes through the FastLZ storage backend wherever that
  makes it smaller, and the chain inflates it itself. Config key `fastLz`, applied when neither `--fastlz` nor
  `--no-fastlz` is given.

`--codec fastlz` is refused: FastLZ is a per-chunk storage backend, not a file codec.

## Orgs

Projects live in **orgs**, and token ids repeat across them, so every command that names a project
takes `--org <address>` (or `ABXFS_ORG`, or `org` on the chain in your own `ABXFS_CONFIG` / home config; an `org`
in a `./.abxfs.json` in the working directory is IGNORED, see Config trust below).

`abxfs upload --name …` uses `--org`, else `ABXFS_ORG`, else `org` in your config, else the newest org you
**administer**, and otherwise creates your own —
in the same transaction as the first project. An org where you only hold a project (anyone can mint one into your
wallet from an open org) is never chosen for you: pass `--org` to mint into it. If any org connected to your account
could not be read, it stops and asks for `--org` rather than conclude you administer none. The org is named before
anything is sent. It checks that you may mint **before** uploading anything, so an account that is not allowed does not pay for
an upload it cannot use.

| Command | |
| --- | --- |
| `org create [name] [--yes]` | an org administered by you, and its first project. The name is fixed for life. |
| `org list [--address a]` | orgs an account administers or holds a project in |
| `org info <org>` | admin, mint rule, creation block |
| `org transfer-admin <org> <to> [--yes]` | offer the admin role; nothing changes until accepted |
| `org accept-admin <org> [--yes]` | accept an offer. **Closes the org**, so an open door the previous admin left does not outlive them |
| `org open <org> [--yes]` / `org close <org> [--yes]` | let anyone mint, or only the admin. `open` warns that anyone can then fill the org to its 1,000,000-project cap, which never rises |
| `org mint <org> [--to a] [--yes]` | mint the next project to an address (default: you). The recipient owns it. |

Every one of these that writes prints its plan and asks you to type `yes`; without a terminal it needs `--yes`.

The admin is one wallet, and controls who may *create* projects: itself, or anyone while the org is open, or
anyone it mints to with `org mint --to`. It has no power over any project. For a team, make the admin a Safe or
another smart account. When a factory is superseded, its orgs keep working with every command here.

## Safety

Everything uploaded is **public and permanent**, and what a project or org looks like is written by other people.

- **Publish and tag.** `upload --project-id N --tag T` and `update --tag T` share one SDK
  implementation with any app built on it. It counts versions before publishing (and aborts, sending nothing, if it cannot), takes the
  version from the publish receipt, proves `versionAt(v)` holds the root just published, and only then tags.
  A reverted transaction is an error, never a success message.
- **Bad input stops before anything is sent.** `upload` and `update` validate `--tag` and `--name` (and that
  `--tag` has a project to point at) at command entry, before any upload, mint or RPC call.
- **Upload scan.** Symlinks are never followed: inside the tree they are skipped and listed, and an upload ROOT
  that is itself a symlink is refused (the message says where it points). A single file is opened with
  `O_NOFOLLOW` and the bytes that were sniffed are the bytes that are uploaded. Dotfiles and dot-directories are
  skipped (except `.well-known`) and summarised; `--include-hidden` includes them. `node_modules`, `dist`, `build`,
  `out`, `cache`, `broadcast`, `.next`, `.turbo` and `.DS_Store` are never uploaded, at any depth, and are not
  listed. A file is held for
  confirmation if its name says it is a secret (`.env*`/`*.env` but not `.env.example|sample|template`, `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.kdbx` including a backup suffix such as `server.pem.bak`, `id_rsa` and
  friends, `wallet.json`, `keystore*.json`, `UTC--*`, `*.tfstate`, `secrets.json`-style files, `*.secret`,
  `credentials` / `credentials.json`, `.npmrc`, `.netrc`, `.aws`, `.ssh`, `.git`, …; `credentials.html`,
  `secret.png` or `private-keys-explained.html` are not), or if its contents hold a private key block
  (any case, PGP included), an AWS key id, a labelled 64-hex key, a Slack/GitHub/Google/`sk-` token, or a recovery
  phrase next to a label (the whole file is read up to 8 MiB, the first and last 4 MiB beyond that); a `wallet.txt` / `seed.txt` is held only when it really holds a 12 to 24 word phrase.
  UTF-16 files are decoded first.
  **Confirmation is per file.** On a terminal you are asked, file by file, to type `yes`. Without a TTY (CI) pass
  `--allow-public <glob>` once for each file you mean to publish (`--allow-public .env.production`,
  `--allow-public 'keys/*.pem'`; repeatable, a glob without `/` matches the name at any depth): any hit no glob
  names stops the run, so the next surprise file still stops the pipeline. There is deliberately no blanket flag,
  and a glob that names nothing (`*`, `**`, `**/*`, `?*`, `*.*`, `**/.*`) is refused with "name the files you
  approve"; a pattern needs a literal name, extension or directory, at most 256 characters and 8 `*`.
  Applies to `upload` and `update`, including single files. The scan reads each file in full up to 8 MiB (the first
  and last 4 MiB beyond, and says so), skips real binary data, and also catches `.env`-style lines in
  `env.txt`/`config`-named files, keystore JSON, Stripe/SendGrid/npm tokens, labelled JWTs and `://user:password@`
  URLs. A file over 256 MiB is refused before it is read, and an upload (or a `diff`'s folder) over 1 GiB in all is
  stopped at the file that would cross it (the CLI holds an upload in memory). The upload root and every parent directory above it must not be a symlink.
- **Config trust.** `~/.config/abxfs/config.json` is the BASE, `ABXFS_CONFIG` layers over it, and both are yours and
  always honoured (a malformed one is an error). A `./.abxfs.json` in the working directory is only a vetted
  overlay on top, and a malformed one, or anything with that name that is not a regular file of at most 256 KiB (a
  directory, a FIFO, a symlink), is ignored with a warning instead of aborting every command, and never followed or
  read past that size. A cloned repo can ship one, so it may not steer writes: without
  `--allow-config-overrides` (or `ABXFS_ALLOW_CONFIG_OVERRIDES=1`) its `defaultChain`, `org`, `rpcUrl` /
  `fallbackRpcUrls`, non-canonical addresses or `chainId`, upload tunables (`defaultBundleGasBudget`,
  `defaultCodec`, `fastLz`) and any chain without a canonical deployment are ignored, with a loud warning listing
  each key. Put a local-anvil chain in `ABXFS_CONFIG`. Every config's values are checked (URLs, addresses, a
  positive whole `defaultBundleGasBudget`); unknown keys are reported and ignored, and a key named like a secret
  (`privateKey`, `mnemonic`, `apiKey`, …) is reported loudly and never used. Nothing a config file says reaches the
  terminal with escape sequences in it.
- **Confirmation.** `upload`, `update`, `tag set` / `tag remove`, `view`, `transfer` and every `org` write print the
  chain, the org, the number of transactions, the estimated gas, the maximum cost at the fee ceiling and what becomes
  permanent, refuse an account with no ETH, and then ask you to type `yes`. Without a terminal they refuse unless
  `--yes` is passed. `upload --dry-run` sends nothing and asks nothing.
- **Fee ceiling.** Every write caps `maxFeePerGas` and `maxPriorityFeePerGas` at `ABXFS_MAX_FEE_GWEI` (default 50
  gwei; 200 on Ethereum L1 and its testnets) and refuses, signing nothing, if the node quotes above it. The check
  covers `eth_sendRawTransaction` and `eth_sendRawTransactionSync`, and the refusal prints gwei and names the
  ceiling (`above the 50 gwei ceiling (ABXFS_MAX_FEE_GWEI)`). Chain, RPC host
  and account are printed before the first write.
- **Chain id.** Every RPC endpoint must answer `eth_chainId` with the chain it is configured for, before anything is
  read or sent (a fallback endpoint on its first use; a mismatch is reported, never routed around). A transaction
  the node fills for another chain is refused, and a signed transaction for any other chain id (or none) never
  reaches `eth_sendRawTransaction`.
- **`abxfs dev`** builds and runs Solidity from the current directory, and a Foundry project can run arbitrary
  commands, so it needs `--i-trust-this-dir` (you saying this directory is a checkout of this repository you trust) AND the
  `packages/contracts-core` marker. A `package.json` name is not trusted. It gives anvil/forge a minimal
  environment (no `ABXFS_PRIVATE_KEY` or other secrets, `FOUNDRY_FFI=false`). It refuses a `--port` something already
  listens on, deploys only to the anvil it started (`web3_clientVersion`, the chain id), and stops anvil when forge
  fails or the command ends, Ctrl-C and SIGTERM included (a forge script still running is stopped too). It takes no
  `--chain`.
- **`abxfs read`** inspects the WHOLE buffer and refuses to print binary data, terminal escape sequences, C1
  controls, or bidi / invisible formatting characters to a terminal without `--output <file>` or `--force`. It asks
  the chain whether a CID is a file or a directory first; `-o` on a directory is refused, and a listing is capped by
  `--max-entries` (default 10,000).
- **Receipt timeouts.** If a transaction's receipt does not arrive in time the CLI says it was sent and **may still
  confirm**, with its hash and the block explorer link, and does not resend it. For a mint (or `org create`) it reads
  the chain to find the project that transaction made and carries on with it; still pending, it stops with the hash,
  the explorer link and what to run once it confirms (for `upload`, the command that publishes into that project,
  carrying every flag that decides the root, and the root it must give). Never run a minting command again after a
  timeout: it would mint a second, empty project.
- **Keys.** Only `ABXFS_PRIVATE_KEY` is read (no generic `PRIVATE_KEY`). Error output has RPC URLs reduced to
  scheme and host (viem errors embed the API key), and the key itself removed.
- **Recipients.** `org mint --to`, `org transfer-admin` and `transfer` require a valid address (a mixed-case
  address must carry a correct EIP-55 checksum) and refuse the zero address, burn addresses (`0x…dEaD` and its
  look-alikes), precompile addresses (0x01 to 0x0a), the all-ones address and the org itself; `transfer` also
  refuses every ABX FS contract in the address book, every factory generation's hooks included. `transfer` and
  `transfer-admin` ask for confirmation (`--yes` to skip).
- **Pinning.** `pin` derives the IPFS DAG from chain and sends exactly those blocks as one CAR, so any tree pins under
  the derived root, empty folders and codec files included: `--provider local` (Kubo `dag/import`) or `--provider
  pinata` (v3 CAR upload, reads `PINATA_JWT`), or `--car <path>` to write the archive for any other service.
  `--api-key` works but warns: it lands in shell history and `ps`. A non-https `--endpoint` is refused when a key is
  attached (localhost excepted). The provider is checked first, before anything is read from chain (Kubo
  `/api/v0/version`, the Pinata key), uploads
  time out on lack of progress rather than a fixed clock, replies are read up to 1 MiB and redirects are never
  followed. `--project-version <n>` pins an older version.
- **Printed text.** File, project, org and tag names come from chain; control characters and escape sequences are
  stripped before printing. An `abxfs.gateway` / `abxfs.view` that is not a public https URL is shown as ignored.
- **Large histories.** `info` prints at most 200 versions (newest) by default; widen with `--max-versions`.
- **Numbers.** Project ids, versions, `--max-versions` and `--max-bundle-gas` are whole decimal numbers; anything
  else (`0x10`, `1.5`, `12,000,000`) is refused, naming the flag.
- **IPFS.** `verify` derives a root's IPFS CID on chain (`IpfsCidResolver`) and locally, and compares; for content
  holding a file with a codec, which the chain cannot decode, it reports the local CID and says why. `pin` checks the
  provider's root the same way.

Everything else: `abxfs --help`, and <https://docs.fs.abx.io>.

## Token links

Marketplaces show two links from a project's token. By default they go to a path on `https://fs.abx.io`. Point
them at your own URL, used exactly as given (your own gateway, your own domain):

```bash
abxfs view https://my-site.example/ --project-id 3 --org 0x…
abxfs view --clear --project-id 3 --org 0x…
```

See [Token links and your own gateway](https://docs.fs.abx.io/docs/using-abxfs/token-links).
