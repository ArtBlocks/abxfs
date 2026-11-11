# @artblocks/abxfs-sdk

## 0.4.0

### Minor Changes

- df91e7e: Validate explicit presentation paths before content writes and keep valid deep-directory Auto uploads on their gateway root when a suggested entrypoint cannot fit the presentation path grammar. Block known codec-incompatible on-chain IPFS choices and proven missing configured URL targets before content writes. Share presentation planning across local publishing workflows, distinguish first publication from later updates, and preserve deliberate owner choices. Add explicit entrypoint and method controls, directory overlay updates, structured CLI outcomes, and bounded complete tokenURI checks with presentation-only recovery after successful publication. Preserve confirmed publication identity through version-readback, tag and name followup failures instead of inviting another publish. Treat Auto size recommendations separately from native codec constraints and uncapped explicit Embedded in the current presentation generation. Explain retired intermediate factory orgs after canonical replacement promotion while preserving supported original generations.

## 0.3.0

### Minor Changes

- 23957df: Add optional native on-chain content reads and generation-specific presentation controls, inspection, preview, and conservative Auto method selection. Recover org creation from one receipt across all configured factory generations and refuse ambiguous receipts.
  
  Do not reuse the current native reader for an older org generation with a different immutable store pair.

### Patch Changes

- 23957df: Pin dependent content simulations and gas estimates to successful prerequisite receipt blocks to avoid stale-replica missing-file or missing-node errors after successful receipts. Keep retries bounded and read-only, and submit the exact gas estimate without repeating a successful write.
- 23957df: Register the verified reader/presentation factory generation on all eight supported networks. Preserve the complete original factory generation on its six original networks, while keeping Robinhood factory history empty because those chains first deployed the current generation.

## 0.2.1

### Patch Changes

- c40ed96: Validate package publishing through the main-only npm-publish environment. Package runtime behavior is unchanged.

## 0.2.0

### Minor Changes

- f24c31f: Drop-in for every consumer: the SDK only adds exports, and the CLI only prints more.
  
  - SDK: `readTokenLinks` (and `AbxfsClient.readTokenLinks`) reads a project's `animation_url` and `external_url` from
    the renderer its token's metadata uses, so they are exactly what a marketplace shows. `orgMetaAbi` and
    `projectLinksAbi` are exported, mirrored from the contracts and checked like the other ABIs.
  - CLI: `upload`, `update` and `info` print where a project is (its token's two links; a content-only upload prints
    the root's gateway URL). Every transaction's full hash is printed, publish, tag and name included. The plan shows
    the likely cost at the current gas price beside the fee-ceiling maximum. A dry run with `--name` or `--project-id`
    lists the project's own transactions, so its count matches the real run.

## 0.1.1

### Patch Changes

- 47416ba: The README links to the specs by full URL, so the links work on npm and in an installed package, which does not ship
  `specs/`.

## 0.1.0

First release on npm.
