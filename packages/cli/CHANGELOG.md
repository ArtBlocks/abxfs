# @artblocks/abxfs-cli

## 0.1.2

### Patch Changes

- f24c31f: Drop-in for every consumer: the SDK only adds exports, and the CLI only prints more.
  
  - SDK: `readTokenLinks` (and `AbxfsClient.readTokenLinks`) reads a project's `animation_url` and `external_url` from
    the renderer its token's metadata uses, so they are exactly what a marketplace shows. `orgMetaAbi` and
    `projectLinksAbi` are exported, mirrored from the contracts and checked like the other ABIs.
  - CLI: `upload`, `update` and `info` print where a project is (its token's two links; a content-only upload prints
    the root's gateway URL). Every transaction's full hash is printed, publish, tag and name included. The plan shows
    the likely cost at the current gas price beside the fee-ceiling maximum. A dry run with `--name` or `--project-id`
    lists the project's own transactions, so its count matches the real run.
- Updated dependencies [f24c31f]
  - @artblocks/abxfs-sdk@0.2.0
  - @artblocks/abxfs-pinning@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [47416ba]
  - @artblocks/abxfs-sdk@0.1.1
  - @artblocks/abxfs-pinning@0.1.1

## 0.1.0

First release on npm.
