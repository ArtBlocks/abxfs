# Security policy

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/ArtBlocks/abxfs/security/advisories/new).
Do not open a public issue, discussion, or pull request containing exploit details, credentials, or
private user data.

Include the affected contract, package, or app, the chain and address if it is deployed, the impact,
reproduction steps, and any suggested remediation. Reports are acknowledged as soon as practical. We
will coordinate validation, remediation, and disclosure with the reporter.

If private vulnerability reporting is unavailable, contact an Art Blocks maintainer through an
existing trusted channel and ask for a private security contact. Do not send exploit details until a
private channel is established.

Content served by the site (phishing, malware, infringement, abuse) is not a vulnerability report:
email `legal@artblocks.io`, as its [content policy](https://fs.abx.io/policy) describes.

## Supported versions

Security fixes are applied to the current canonical deployments listed in
[the deployments reference](https://docs.fs.abx.io/docs/reference/deployments), the latest release of each
`@artblocks/abxfs-*` package on npm, and the site at fs.abx.io and its content domain.

The contracts are immutable: nothing deployed has an owner, an upgrade path, or a setter. A
contract fix ships as a new deployment at new addresses, and orgs created by an earlier factory keep
working through it ([Superseding a factory](docs/deploy-runbook.md#superseding-a-factory)).

## Operational safety

Never include private keys, seed phrases, API tokens, authenticated RPC URLs, storage credentials, or
unredacted environment files in a report. If a credential may have been exposed, revoke or rotate it
before reporting.
