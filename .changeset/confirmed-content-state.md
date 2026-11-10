---
"@artblocks/abxfs-sdk": patch
---

Pin dependent content simulations and gas estimates to successful prerequisite receipt blocks to avoid stale-replica missing-file or missing-node errors after successful receipts. Keep retries bounded and read-only, and submit the exact gas estimate without repeating a successful write.
