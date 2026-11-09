# Changesets

The `@artblocks/abxfs-*` packages are released from `main` by [Changesets](https://github.com/changesets/changesets)
and npm trusted publishing: see [`.github/workflows/release.yml`](../.github/workflows/release.yml). Nothing stores an
npm token.

## Shipping a change

1. Make the change on a branch.
2. Run `pnpm changeset`, pick the packages it changes and the bump, and write a one-line summary. Commit the
   `.changeset/<name>.md` it creates with the change. **When the change breaks something, lead with who it breaks and
   who it does not**, in one sentence: it becomes the package's `CHANGELOG.md` entry, which is what an integrator reads
   before upgrading.
3. Open a pull request. Once it merges, the release workflow opens (or updates) a **Version Packages** pull request
   that bumps the versions and writes each package's `CHANGELOG.md`.
4. Merge the Version Packages pull request, and the workflow publishes every bumped package to npm, with provenance,
   and tags the release.

A change that touches no published package (the contracts, the docs site, a test, CI) needs no changeset.

`changeset publish` publishes through pnpm, which writes the version of each `workspace:*` dependency into the tarball.
A plain `npm publish` would ship an uninstallable `workspace:*`.

## The Version Packages pull request and its checks

A pull request the workflow opens with its own token starts no workflow, so the required checks would never report.
The release workflow therefore starts them itself on the release branch (`workflow_dispatch`), and they appear on the
pull request a few minutes after it is opened or updated. If they do not, close the pull request and reopen it.

## Publishing authorization

The release job uses the `npm-publish` GitHub environment, configured with **Selected branches and tags** and exactly
one **branch** rule, `main` (no tag rule). Each package's npm trusted publisher must name `ArtBlocks`, `abxfs`,
`release.yml` and the `npm-publish` environment, with direct `npm publish` enabled. Keep required checks on `main`.

When replacing publisher connections, create the environment first, land the workflow change with a patch changeset
for all four packages, and hold the Version Packages pull request until the npm settings match. Remove any unbound
publisher alternative. Publish through Changesets within two days of creating the replacement connections so each
connection validates. Verify every expected package version, latest tag and provenance before completing the rollout.

After OIDC publishing is verified, select **Require two-factor authentication and disallow tokens** in each package's
publishing access settings. This restricts traditional tokens while preserving trusted publishing. Revoke obsolete
publishing credentials where they exist; never add a fallback npm token to GitHub.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for connection and publishing-access settings.
