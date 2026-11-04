/**
 * Walk a local directory and produce ABX FS FileDescriptor[]s.
 *
 * What gets uploaded is public and permanent, so the walk is conservative:
 *   - it uses `lstat` and NEVER follows a symlink (a repo can ship `assets -> ~/.ssh`); symlinks are
 *     skipped and reported;
 *   - dotfiles and dot-directories are skipped unless `includeHidden`, except `.well-known`;
 *   - names that look like secrets are reported so the caller can demand explicit confirmation
 *     (see `scan-guard.ts`).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, type Stats } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import type { FileDescriptor } from "@abxfs/sdk";
import { UPLOAD_DOT_ALLOWLIST, UPLOAD_IGNORE_NAMES, UPLOAD_VCS_NAMES, inferMimeType, isSecretLikePath, sniffSecret } from "@abxfs/sdk";

import { safe } from "./text.js";

export { isSecretLikePath };

export interface ScanOptions {
  /** Glob-ish ignore names. Defaults to common VCS/build dirs. */
  ignore?: string[];
  /** Include dotfiles and dot-directories (and `.git`). Default false. */
  includeHidden?: boolean;
  /** Most bytes read for the whole scan. Default {@link MAX_TOTAL_READ_BYTES}. */
  maxTotalBytes?: number;
}

export interface ScanReport {
  files: FileDescriptor[];
  /**
   * Relative paths of directories the upload keeps with nothing in them: no included file and no included
   * subdirectory (one whose only contents were skipped, hidden for example, counts). `ipfs add -r` keeps them too,
   * so the on-chain tree and its IPFS root match the folder.
   */
  emptyDirectories: string[];
  /** Relative paths of symlinks that were skipped. */
  skippedSymlinks: string[];
  /** Relative paths of dotfiles / dot-directories that were skipped. */
  skippedHidden: string[];
  /** Relative paths (of included files) whose name looks like a secret, or whose contents do (read in full up to 8 MiB, the first and last 4 MiB beyond that). */
  secretLike: string[];
  /** Why a content-sniffed file was flagged (path -> reason). Name-only hits are not listed. */
  secretReasons: Record<string, string>;
  /** Relative paths of files too large to be read in full for the secret scan: only their two ends were checked. */
  partiallyScanned: string[];
}

/**
 * The largest file the CLI will read at all. This is a CLIENT memory bound, not a protocol one: files are trees
 * of chunk nodes and have no size limit short of the level cap, but the CLI holds a file's bytes
 * (and its chunks) in memory to hash and plan it. Checked from `lstat`, before a byte is read: a 4 GB file adds
 * nothing to the process.
 */
export const MAX_READ_FILE_BYTES = 256 * 1024 * 1024;

/**
 * The most the CLI reads for one upload, all files together: 1 GiB. Like {@link MAX_READ_FILE_BYTES} a client memory
 * bound (every file is held in memory to be hashed and planned), checked from `lstat` sizes as the walk goes, before
 * the file that would cross it is read.
 */
export const MAX_TOTAL_READ_BYTES = 1024 * 1024 * 1024;

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MiB`;

/** The refusal for a file over {@link MAX_READ_FILE_BYTES} (also what replaces Node's raw ERR_FS_FILE_TOO_LARGE past 2 GiB). */
export function tooLargeToReadError(path: string, size: number): Error {
  return new Error(
    `"${safe(path)}" is ${mib(size)}, too large to upload from the CLI: it reads at most ` +
      `${mib(MAX_READ_FILE_BYTES)} of any one file into memory (the protocol itself has no such limit). ` +
      "Exclude it or split it into parts. Nothing was uploaded.",
  );
}

/** The refusal for an upload whose files add up to more than {@link MAX_TOTAL_READ_BYTES}. */
export function tooMuchToReadError(path: string, total: number, max = MAX_TOTAL_READ_BYTES): Error {
  return new Error(
    `the files to upload add up to more than ${mib(max)} (at least ${mib(total)} with "${safe(path)}"): the CLI ` +
      "holds an upload in memory to hash and plan it (the protocol itself has no such limit). Upload it in parts " +
      "(separate directories, then a directory that names them is cheap). Nothing was uploaded.",
  );
}

// Shared with the web app through the SDK, so a folder gives the same root from either.
const DEFAULT_IGNORE = UPLOAD_IGNORE_NAMES;
const VCS_IGNORE = UPLOAD_VCS_NAMES;
/** Dot entries that are meant to be published. */
const HIDDEN_ALLOWLIST = UPLOAD_DOT_ALLOWLIST;

/**
 * Refuse an upload ROOT that is itself a symlink. The walk never follows symlinks INSIDE the tree, but a
 * root of `public -> ~/.ssh` would otherwise be followed by the very first `readdir`, which is the
 * documented-as-impossible case. Says where it points so the fix (pass the real path) is obvious.
 * A path that does not exist is left for the caller's own error.
 */
export function assertNotSymlink(path: string, what = "upload root"): void {
  const abs = resolve(path);
  const root = parse(abs).root;
  // EVERY component, from the filesystem root down: `link/sub` resolves into whatever `link` points at, so
  // checking only the last component let a symlinked PARENT carry the upload anywhere. A symlink that sits
  // directly under the filesystem root (`/var`, `/tmp`, `/etc` on macOS) is an operating-system alias that
  // only an administrator can create, so it is not treated as a redirect.
  let cur = root;
  for (const seg of abs.slice(root.length).split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch {
      return; // does not exist (yet): the caller's own error is the better message
    }
    if (!st.isSymbolicLink()) continue;
    if (dirname(cur) === root) continue;
    let target = "(unreadable)";
    try {
      target = readlinkSync(cur);
    } catch {
      /* keep placeholder */
    }
    const last = cur === abs;
    throw new Error(
      last
        ? `refusing to use ${what} "${abs}": it is a symlink (to "${target}"). Symlinks are never followed; pass the real path instead.`
        : `refusing to use ${what} "${abs}": its parent "${cur}" is a symlink (to "${target}"). Symlinks are never followed; pass the real path instead.`,
    );
  }
}

export function scanDirectoryReport(root: string, opts: ScanOptions = {}): ScanReport {
  assertNotSymlink(root);
  const absRoot = resolve(root);
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.includeHidden ? [] : VCS_IGNORE), ...(opts.ignore ?? [])]);
  const report: ScanReport = {
    files: [],
    emptyDirectories: [],
    skippedSymlinks: [],
    skippedHidden: [],
    secretLike: [],
    secretReasons: {},
    partiallyScanned: [],
  };
  walk(absRoot, absRoot, ignore, opts.includeHidden === true, report, { bytes: 0, max: opts.maxTotalBytes ?? MAX_TOTAL_READ_BYTES });
  report.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  report.emptyDirectories.sort();
  report.secretLike.sort();
  return report;
}

/** Recursively collect files under `root`. All paths are POSIX-relative to `root`. */
export function scanDirectory(root: string, opts: ScanOptions = {}): FileDescriptor[] {
  return scanDirectoryReport(root, opts).files;
}

/** Walk one directory; returns how many entries it kept (files and subdirectories). */
function walk(cwd: string, root: string, ignore: Set<string>, includeHidden: boolean, out: ScanReport, read: { bytes: number; max: number }): number {
  let kept = 0;
  for (const name of readdirSync(cwd)) {
    if (ignore.has(name)) continue;
    const abs = resolve(cwd, name);
    const rel = relative(root, abs).split(sep).join("/");
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      out.skippedSymlinks.push(rel);
      continue;
    }
    if (name.startsWith(".") && !includeHidden && !HIDDEN_ALLOWLIST.has(name)) {
      out.skippedHidden.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      if (walk(abs, root, ignore, includeHidden, out, read) === 0) out.emptyDirectories.push(rel);
      kept++;
    } else if (stat.isFile()) {
      if (stat.size > MAX_READ_FILE_BYTES) throw tooLargeToReadError(rel, stat.size);
      if (read.bytes + stat.size > read.max) throw tooMuchToReadError(rel, read.bytes + stat.size, read.max);
      read.bytes += stat.size;
      const bytes = readRegularFile(abs, stat);
      if (bytes === null) {
        // Swapped for a symlink between lstat and open: never followed.
        out.skippedSymlinks.push(rel);
        continue;
      }
      out.files.push({ path: rel, bytes, mimeType: inferMimeType(rel) });
      kept++;
      const sniff = sniffSecret(bytes, name);
      const reason = sniff.reason;
      if (sniff.partial) out.partiallyScanned.push(rel);
      if (reason) out.secretReasons[rel] = reason;
      if (reason || isSecretLikePath(rel)) out.secretLike.push(rel);
    }
  }
  return kept;
}

/**
 * Read a file the walk just `lstat`ed, without a window in which it can be swapped for a symlink to
 * something private: open with O_NOFOLLOW, then require the opened file to be the very inode that was
 * scanned. `null` when the path became a symlink; throws if it became a different file.
 */
function readRegularFile(abs: string, scanned: Stats): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== scanned.dev || st.ino !== scanned.ino) {
      throw new Error(`"${abs}" changed while it was being scanned; refusing to read it`);
    }
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}
