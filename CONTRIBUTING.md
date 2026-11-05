# Contributing to ABX FS

Thanks for helping improve ABX FS.

## Before opening a change

Use a GitHub Issue for a bug report or a proposal that needs design discussion. Small fixes can go
directly to a pull request. Security vulnerabilities belong in the private process described in
[SECURITY.md](SECURITY.md), never in a public issue.

Pull requests are reviewed and merged here: this repository is the source of every ABX FS package, contract and
document.

Keep pull requests focused. Explain the behavior being changed, how it was verified, and whether it
affects contracts, deployed addresses, content addresses (CIDs), package APIs, the CLI, the site, or
the public documentation.

Read [AGENTS.md](AGENTS.md) first. It is written for coding agents and is the shortest accurate account
of what is load-bearing here, for people too.

## Set up

```bash
corepack enable
pnpm install --frozen-lockfile
./scripts/install-forge-deps.sh                 # the Solidity libraries, each checked against its pinned commit
pnpm build:contracts
pnpm -r --filter "./packages/*" build
pnpm test
```

Node 22.13 or later and Foundry 1.4.3 are required. No environment variables are needed for builds
or tests. The fork tests need an RPC URL and are skipped without one (see Testing in
[AGENTS.md](AGENTS.md#testing)).

## Project conventions

- Add or update tests for behavior changes.
- Update `site/content/docs/` with user-visible changes. `docs/` holds operator documentation only.
- Install Solidity libraries only with `scripts/install-forge-deps.sh`, and never edit or format `lib/`.
- Do not add planning, strategy, research notebooks, review transcripts, or private triage records.
  Use GitHub Issues and pull requests for work tracking and design discussion.

## Contract changes

A deployed contract's address is a function of its exact source text, comments included, and every
chunk id commits to its storage backend's address. So a change to a pinned contract moves its
address, and for the content layer it forks the content-address space.

1. Run the complete Foundry test suite (`pnpm test:contracts`), and the fork tests when you touch the
   factory, a hook, the deploy script or the ABX version.
2. If an interface changes, update the SDK's mirrored ABIs (`packages/sdk/src/abi*.ts`);
   `test/abi-drift.test.ts` fails until they match.
3. Re-pin deliberately, and only for a planned deployment. Follow
   [the deploy runbook](docs/deploy-runbook.md).

Treat any change to a deployed address or a CID as a public compatibility event.

## Verification

At minimum, run the checks relevant to your change:

```bash
pnpm typecheck
pnpm test
pnpm check:hygiene
```

For documentation changes, also run `pnpm --dir site build`.

## Releases

A change to a published package (`packages/sdk`, `cli`, `gateway`, `pinning`) carries a changeset: run
`pnpm changeset`, pick the packages and the bump, and commit the file it writes with your change. The maintainers
release from `main`; [`.changeset/README.md`](.changeset/README.md) describes how.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
