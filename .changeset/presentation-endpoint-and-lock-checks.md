---
"@artblocks/abxfs-sdk": minor
"@artblocks/abxfs-cli": patch
---

SDK callers of `lockPresentation` must now pass the reviewed preview (`previewPresentation` at the commitment's block) as a new last argument. Tooling now refuses, before sending anything, a presentation chain base containing `& ( ) [ ] ^ { | }` or an empty host, and a lock that would leave content and method both locked over a failing render.

- `setPresentationEndpoints` and `abxfs presentation set-endpoints` check both endpoints against every rule the presentation contract applies and against the characters the token links renderer refuses, and name the offending character (`presentationEndpointProblem`).
- `lockPresentation` refuses a lock that would leave content and method both locked over a `ReadFailed` or `IpfsFailed` status (`presentationLockProblem`). `abxfs presentation lock` also refuses when the preview itself reverts.
- In orgs with presentation, `upload`, `update` and `info` no longer label the links renderer's `animation_url` as the token's own, and point to `abxfs presentation inspect` instead. `abxfs view` names only the page link (`external_url`) it sets there. The `abxfs.view` and `readTokenLinks` documentation now says `abxfs.view` drives `animation_url` only in orgs from the original factory.
