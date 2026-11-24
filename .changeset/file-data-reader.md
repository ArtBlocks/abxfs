---
"@artblocks/abxfs-sdk": minor
"@artblocks/abxfs-cli": minor
---

Add the `FileDataReader` companion to the SDK and CLI: `ContractAddresses.fileDataReader`, `fileDataReaderAbi`, `readNativeFileData`, `readNativePathData` and `readNativeFileDataRange` (a file's stored data for any codec, whole or as a range, in one call), and `decodeFileData`, the decode-and-check `readFile` now uses. No chain lists the reader until a deployment is verified; the CLI accepts a `fileDataReader` address in config, and `abxfs dev --companion` deploys it and `ContentReader` locally. Nothing existing changes.
