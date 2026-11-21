# @artblocks/abxfs-cli

## 0.4.0

### Minor Changes

- 2acb262: Add shared ABX account login and an opt-in creator-wallet lane for eligible Base Sepolia uploads.

### Patch Changes

- 112b8b3: Include required presentation target and method writes in the upload dry-run transaction total.

## 0.3.1

### Patch Changes

- b67bebd: SDK callers of `lockPresentation` must now pass the reviewed preview (`previewPresentation` at the commitment's block) as a new last argument. Tooling now refuses, before sending anything, a presentation chain base containing `& ( ) [ ] ^ { | }` or an empty host, and a lock that would leave content and method both locked over a failing render.
  
  - `setPresentationEndpoints` and `abxfs presentation set-endpoints` check both endpoints against every rule the presentation contract applies and against the characters the token links renderer refuses, and name the offending character (`presentationEndpointProblem`).
  - `lockPresentation` refuses a lock that would leave content and method both locked over a `ReadFailed` or `IpfsFailed` status (`presentationLockProblem`). `abxfs presentation lock` also refuses when the preview itself reverts.
  - In orgs with presentation, `upload`, `update` and `info` no longer label the links renderer's `animation_url` as the token's own, and point to `abxfs presentation inspect` instead. `abxfs view` names only the page link (`external_url`) it sets there. The `abxfs.view` and `readTokenLinks` documentation now says `abxfs.view` drives `animation_url` only in orgs from the original factory.
- Updated dependencies [b67bebd]
  - @artblocks/abxfs-sdk@0.5.0
  - @artblocks/abxfs-pinning@0.1.6

## 0.3.0

### Minor Changes

- df91e7e: Validate explicit presentation paths before content writes and keep valid deep-directory Auto uploads on their gateway root when a suggested entrypoint cannot fit the presentation path grammar. Block known codec-incompatible on-chain IPFS choices and proven missing configured URL targets before content writes. Share presentation planning across local publishing workflows, distinguish first publication from later updates, and preserve deliberate owner choices. Add explicit entrypoint and method controls, directory overlay updates, structured CLI outcomes, and bounded complete tokenURI checks with presentation-only recovery after successful publication. Preserve confirmed publication identity through version-readback, tag and name followup failures instead of inviting another publish. Treat Auto size recommendations separately from native codec constraints and uncapped explicit Embedded in the current presentation generation. Explain retired intermediate factory orgs after canonical replacement promotion while preserving supported original generations.

### Patch Changes

- Updated dependencies [df91e7e]
  - @artblocks/abxfs-sdk@0.4.0
  - @artblocks/abxfs-pinning@0.1.5

## 0.2.0

### Minor Changes

- 23957df: Add generation-aware project presentation inspect, preview, configuration and immutable lock commands with JSON results and signer-free dry runs. Configure new supported projects through the SDK's auto presentation choice, preserve existing methods on updates, limit implicit new-project org choices to the current factory, and add a no-write update preview.
  
  Warn after a successful update when the preserved presentation is not ready or cannot be previewed, with presentation-only recovery commands and no repeated publish.

### Patch Changes

- Updated dependencies [23957df]
- Updated dependencies [23957df]
- Updated dependencies [23957df]
  - @artblocks/abxfs-sdk@0.3.0
  - @artblocks/abxfs-pinning@0.1.4

## 0.1.3

### Patch Changes

- c40ed96: Validate package publishing through the main-only npm-publish environment. Package runtime behavior is unchanged.
- Updated dependencies [c40ed96]
  - @artblocks/abxfs-sdk@0.2.1
  - @artblocks/abxfs-pinning@0.1.3

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
