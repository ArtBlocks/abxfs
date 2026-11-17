---
"@artblocks/abxfs-sdk": minor
"@artblocks/abxfs-cli": patch
---

Only callers that set a presentation chain base containing `& ( ) [ ] ^ { | }` or an empty host, or that lock content and method over a failing render, are affected: those are now refused before anything is sent. `setPresentationEndpoints` and `abxfs presentation set-endpoints` check both endpoints against every rule the presentation contract applies and against the characters the token links renderer refuses, and name the offending character (`presentationEndpointProblem`). `lockPresentation` takes the reviewed preview and refuses a lock that would leave content and method both locked over a `ReadFailed` or `IpfsFailed` status (`presentationLockProblem`); `abxfs presentation lock` always passes it, and also refuses when the preview itself reverts.
