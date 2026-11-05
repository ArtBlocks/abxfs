# site

The ABX FS documentation site. [fumadocs](https://fumadocs.dev) on Next.js,
deployed to **docs.fs.abx.io** as its own Vercel project.

```bash
pnpm --filter @artblocks/abxfs-docs dev     # http://localhost:3002
pnpm --filter @artblocks/abxfs-docs build
```

To run it on another port: `pnpm --filter @artblocks/abxfs-docs exec next dev --port <port>`.

## Where the words are

Everything user-facing is MDX under `content/docs/`, in three sections:

| Section | For |
| --- | --- |
| `using-abxfs/` | Getting something on chain: quickstart, projects, token links, compression, IPFS, running a gateway. |
| `protocol/` | How it works: architecture, storage backends. |
| `reference/` | Look-it-up: deployments, CLI, SDK, batched reads. |

`meta.json` in each folder sets the section title, its sidebar icon (a
[lucide](https://lucide.dev) name — v1 renamed several, so a bad one shows up as
an `Unknown icon detected` warning at build time), and page order.

The repo has no second copy of any of this. `docs/` at the root holds operator
runbooks and the audit record, which are not part of the docs site.

## Vercel

Root Directory `site`, with "Include files outside the Root Directory" on — it
is a pnpm workspace package and resolves dependencies from the repo root.
Framework preset Next.js; everything else is default.
