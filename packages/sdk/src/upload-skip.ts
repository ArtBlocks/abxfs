/**
 * What an upload of a folder leaves out. The CLI and the web app both read these, so the same folder gives the same
 * files, the same empty folders and therefore the same root from either.
 */

/** Names never walked into, wherever they appear: build output, tooling caches and `.DS_Store`. */
export const UPLOAD_IGNORE_NAMES: readonly string[] = Object.freeze([
  "node_modules",
  ".DS_Store",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "cache",
  "broadcast",
]);

/** Version-control directories, skipped unless hidden files are included on purpose. */
export const UPLOAD_VCS_NAMES: readonly string[] = Object.freeze([".git"]);

/** Dot-names that ARE uploaded even when other hidden files are skipped. */
export const UPLOAD_DOT_ALLOWLIST: ReadonlySet<string> = new Set([".well-known"]);
