/**
 * The upload-time gate around the directory scan: print what was skipped, and never ship
 * secret-looking files without an explicit, informed yes THAT NAMES THE FILE.
 *
 * Confirmation is per file. There is deliberately no blanket "yes to everything" flag: a flag that
 * approves whatever the scan finds would also approve a hit the author never saw (a token that crept
 * into a build output). Non-interactive runs (CI) approve specific files with `--allow-public <glob>`,
 * repeatable; a hit no glob covers fails the run, so the next surprise file still stops the pipeline.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import kleur from "kleur";
import { inferMimeType, sniffSecret, type FileDescriptor } from "@artblocks/abxfs-sdk";

import { MAX_READ_FILE_BYTES, assertNotSymlink, isSecretLikePath, scanDirectoryReport, tooLargeToReadError } from "./fsscan.js";
import { confirmTyped } from "./prompt.js";
import { safe } from "./text.js";

export interface GuardOptions {
  includeHidden?: boolean;
  /** `--allow-public <glob>` (repeatable): files these globs match are uploaded without asking. */
  allowPublic?: string[];
}

const FLAG = "--allow-public <glob>";

const MAX_GLOB_LENGTH = 256;
const MAX_GLOB_STARS = 8;

/** What `--allow-public` says when a pattern does not name what it approves. */
function nameTheFiles(glob: string, why: string): Error {
  return new Error(
    `--allow-public '${glob}' ${why}: name the files you approve (a file name, an extension like '*.pub', ` +
      "or a path like 'keys/*.pub'). A pattern that matches everything would also approve the secret you did not see.",
  );
}

/** How many matching files an error lists. */
const LIST_MATCHES = 10;

/** Letters and digits only: `_`, `-` and `.` are punctuation and name nothing. */
function alnumCount(s: string): number {
  let n = 0;
  for (const ch of s) if (/[\p{L}\p{N}]/u.test(ch)) n++;
  return n;
}

/**
 * Refuse an `--allow-public` pattern that does not name what it approves. `*`, `**`, `**\/*`, `?*`, `*.*`,
 * `*_*`, `*-*`, `*a*`, `?e*` each match (nearly) every file, which makes a per-file approval a blanket one: the
 * next surprise file in the upload would be approved unseen. Only LETTERS and DIGITS count as naming anything.
 * A pattern needs at least three of them, or a real extension (`*.pub`: a literal `.` + two or more letters or
 * digits, no wildcard inside it), and a segment that is wildcard + at most two literal characters + wildcard is
 * refused outright. The pattern must also stay small enough to be matched in bounded time.
 *
 * Pass the upload's relative paths as `files` and the error lists what the pattern would have approved, so the
 * effect is visible rather than guessed at.
 */
export function validateAllowPublicGlob(glob: string, files?: readonly string[]): void {
  const clean = glob.replace(/^\.\//, "");
  if (clean === "" || clean.trim() === "") throw nameTheFiles(glob, "is empty");
  if (clean.length > MAX_GLOB_LENGTH) throw nameTheFiles(glob, `is longer than ${MAX_GLOB_LENGTH} characters`);
  if ((clean.match(/\*/g) ?? []).length > MAX_GLOB_STARS) throw nameTheFiles(glob, `has more than ${MAX_GLOB_STARS} '*'`);
  const segs = clean.split("/");
  const literal = alnumCount(clean.replace(/[*?]/g, ""));
  const last = segs[segs.length - 1] ?? "";
  const ext = /\.([\p{L}\p{N}]{2,})$/u.exec(last);
  const realExtension = ext !== null && !/[*?]/.test(ext[1]!);
  // wildcard + at most two literal characters + wildcard, in any segment: `*a*`, `*_*`, `?e*`, `*ab*`.
  const bracketed = segs.some((seg) => /^[*?]+[^*?]{1,2}[*?]+$/.test(seg));
  let why: string | null = null;
  if (literal === 0) why = "has no literal file name or extension";
  else if (bracketed) why = "is a wildcard around one or two characters";
  else if (literal < 3 && !realExtension) why = "has fewer than 3 literal letters or digits and no real extension";
  if (why === null && /[*?]/.test(clean)) {
    const hit = secretClassProbe(clean);
    if (hit !== null) why = `would approve a whole class of secrets (it matches names like '${hit}' by extension or substring alone)`;
  }
  if (why === null) return;
  let listing = "";
  if (files && files.length > 0) {
    let matched: string[] = [];
    try {
      const m = globToRegExp(clean);
      matched = files.filter((f) => m.test(f) || (!clean.includes("/") && m.test(f.split("/").pop() ?? f)));
    } catch {
      /* an unusable pattern lists nothing */
    }
    listing =
      ` In this upload it would approve ${matched.length} of ${files.length} file(s)` +
      (matched.length > 0 ? `: ${matched.slice(0, LIST_MATCHES).map(safe).join(", ")}${matched.length > LIST_MATCHES ? ", ..." : ""}` : "") +
      ".";
  }
  const err = nameTheFiles(glob, why);
  err.message += listing;
  throw err;
}

/** Names each secret-name rule flags, one or more per rule. A wildcard glob matching any of them approves a CLASS. */
const SECRET_CLASS_PROBES: readonly string[] = [
  ".env", ".env.local", "prod.env", "server.pem", "server.key", "cert.p12", "cert.pfx", "store.jks", "db.kdbx", "x.keystore", "x.p8",
  "id_rsa", "id_ed25519", "wallet.json", "keystore.json", "UTC--2020-01-01", "terraform.tfstate", "terraform.tfvars", "secrets.json", "secret.yaml",
  "app.secret", "credentials", "credentials.json", "client_secret.json", "service-account.json", "mnemonic", "mnemonic.txt", "private-key.pem",
  ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".aws", ".ssh", "kubeconfig", "server.key.bak", "server.key~",
];

/** The first secret-looking name `glob` would approve (bare, or under the glob's own directory), or null. */
function secretClassProbe(clean: string): string | null {
  let m: GlobMatcher;
  try {
    m = globToRegExp(clean);
  } catch {
    return null;
  }
  const slash = clean.lastIndexOf("/");
  const dir = slash >= 0 ? clean.slice(0, slash).replace(/\*\*?|\?/g, "a") : "";
  for (const probe of SECRET_CLASS_PROBES) {
    for (const name of [probe, probe.toUpperCase()]) {
      if (!isSecretLikePath(name)) continue;
      const full = dir ? `${dir}/${name}` : name;
      if (m.test(full) || (!clean.includes("/") && m.test(name))) return probe;
    }
  }
  return null;
}

type GlobToken = { t: "lit"; c: string } | { t: "q" } | { t: "star" } | { t: "dstar" } | { t: "dstarSlash" };

function tokenize(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out.push({ t: "dstarSlash" });
        } else out.push({ t: "dstar" });
      } else out.push({ t: "star" });
    } else if (c === "?") out.push({ t: "q" });
    else out.push({ t: "lit", c });
  }
  return out;
}

/** A compiled glob. `test` is O(pattern x path): a state-set walk, never a backtracking regex. */
export interface GlobMatcher {
  test(path: string): boolean;
}

/**
 * Translate a glob (`*` within a segment, `**` across them, `?`) into a matcher over a POSIX relative path.
 *
 * A regex made of stacked `[^/]*` backtracks exponentially (12 stars against 30 characters took seconds), so
 * this walks the set of live pattern positions once per character instead: linear in the path, bounded by the
 * pattern, whatever the input. Length and star count are capped.
 */
export function globToRegExp(glob: string): GlobMatcher {
  if (glob.length > MAX_GLOB_LENGTH) throw nameTheFiles(glob, `is longer than ${MAX_GLOB_LENGTH} characters`);
  if ((glob.match(/\*/g) ?? []).length > MAX_GLOB_STARS) throw nameTheFiles(glob, `has more than ${MAX_GLOB_STARS} '*'`);
  const tokens = tokenize(glob);
  const closure = (set: Set<number>): Set<number> => {
    for (const i of [...set].sort((a, b) => a - b)) {
      let k = i;
      while (k < tokens.length && (tokens[k]!.t === "star" || tokens[k]!.t === "dstar" || tokens[k]!.t === "dstarSlash")) {
        k++;
        set.add(k);
      }
    }
    return set;
  };
  return {
    test(path: string): boolean {
      let cur = closure(new Set([0]));
      for (const ch of path) {
        const next = new Set<number>();
        for (const i of cur) {
          const tk = tokens[i];
          if (!tk) continue;
          switch (tk.t) {
            case "lit":
              if (ch === tk.c) next.add(i + 1);
              break;
            case "q":
              if (ch !== "/") next.add(i + 1);
              break;
            case "star":
              if (ch !== "/") next.add(i);
              break;
            case "dstar":
              next.add(i);
              break;
            case "dstarSlash":
              next.add(i);
              if (ch === "/") next.add(i + 1);
              break;
          }
        }
        if (next.size === 0) return false;
        cur = closure(next);
      }
      return cur.has(tokens.length);
    },
  };
}

/**
 * Whether `path` is covered by an `--allow-public` glob. A glob with no `/` matches the file name at any
 * depth (`--allow-public .env.production`); one with a `/` matches the whole relative path. A pattern that
 * names nothing (see {@link validateAllowPublicGlob}) approves nothing.
 */
export function isAllowedPublic(path: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  const norm = path.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return globs.some((g) => {
    const clean = g.replace(/^\.\//, "");
    try {
      validateAllowPublicGlob(g);
    } catch {
      return false;
    }
    const re = globToRegExp(clean);
    return re.test(norm) || (!clean.includes("/") && re.test(base));
  });
}

async function confirmSecrets(paths: string[], opts: GuardOptions, reasons: Record<string, string> = {}): Promise<void> {
  const allowed = paths.filter((p) => isAllowedPublic(p, opts.allowPublic));
  const pending = paths.filter((p) => !allowed.includes(p));
  for (const p of allowed) console.error(kleur.yellow(`  --allow-public matched ${safe(p)}: uploading it. It will be PUBLIC and PERMANENT.`));
  if (pending.length === 0) return;

  console.error(
    kleur.red("WARNING:"),
    "these files look like credentials or repository metadata. Everything uploaded to ABX FS is PUBLIC and PERMANENT; it can never be deleted.",
  );
  for (const p of pending.slice(0, 20)) console.error("   ", kleur.red(safe(p)), reasons[p] ? kleur.gray(`(contents: ${reasons[p]})`) : "");
  if (pending.length > 20) console.error(`    … and ${pending.length - 20} more`);

  if (!process.stdin.isTTY) {
    throw new Error(
      `${pending.length} secret-looking file(s) were not approved and nothing was uploaded. ` +
        `Approve each one deliberately with ${FLAG} (repeatable), or remove it from the upload.`,
    );
  }
  for (const p of pending) {
    const ok = await confirmTyped(`Upload ${safe(p)} publicly and permanently?`, { flag: FLAG });
    if (!ok) throw new Error(`aborted: ${safe(p)} was not confirmed. Nothing was uploaded.`);
  }
}

/** Say, once, that these files were too large to be read in full for the secret scan. */
function warnPartlyScanned(paths: string[]): void {
  console.log(
    kleur.yellow("!"),
    `large file, only partly scanned for secrets (the first and last 4 MiB were checked, not the middle): ` +
      paths.slice(0, 10).map(safe).join(", ") + (paths.length > 10 ? ", …" : ""),
  );
}

/** Scan a directory for upload: skip symlinks and hidden files, report, and confirm secret-like files one by one. */
export async function scanForUpload(root: string, opts: GuardOptions = {}): Promise<FileDescriptor[]> {
  return (await scanTreeForUpload(root, opts)).files;
}

/** {@link scanForUpload}, plus the directories that are kept with nothing in them. */
export async function scanTreeForUpload(
  root: string,
  opts: GuardOptions = {},
): Promise<{ files: FileDescriptor[]; emptyDirectories: string[] }> {
  let report: ReturnType<typeof scanDirectoryReport> | undefined;
  for (const g of opts.allowPublic ?? []) {
    try {
      validateAllowPublicGlob(g);
    } catch (e) {
      // Say what the refused pattern WOULD have approved in this upload (the scan reads, never uploads).
      report ??= scanDirectoryReport(root, opts.includeHidden ? { includeHidden: true } : {});
      validateAllowPublicGlob(g, report.files.map((f) => f.path));
      throw e;
    }
  }
  report ??= scanDirectoryReport(root, opts.includeHidden ? { includeHidden: true } : {});
  if (report.partiallyScanned.length > 0) warnPartlyScanned(report.partiallyScanned);
  if (report.skippedSymlinks.length > 0) {
    console.log(
      kleur.yellow("!"),
      `skipped ${report.skippedSymlinks.length} symlink(s) (never followed):`,
      report.skippedSymlinks.slice(0, 10).map(safe).join(", ") + (report.skippedSymlinks.length > 10 ? ", …" : ""),
    );
  }
  if (report.skippedHidden.length > 0) {
    console.log(
      kleur.yellow("!"),
      `skipped ${report.skippedHidden.length} hidden entr${report.skippedHidden.length === 1 ? "y" : "ies"} (pass --include-hidden to include):`,
      report.skippedHidden.slice(0, 10).map(safe).join(", ") + (report.skippedHidden.length > 10 ? ", …" : ""),
    );
  }
  if (report.secretLike.length > 0) await confirmSecrets(report.secretLike, opts, report.secretReasons);
  return { files: report.files, emptyDirectories: report.emptyDirectories };
}

/**
 * The single-file equivalent: refuse a symlink (including the path itself), open with `O_NOFOLLOW`, require
 * the opened file to be the very inode that was `lstat`ed, sniff the bytes that will actually be uploaded
 * (the same buffer, so nothing can be swapped in between the check and the read), and confirm a secret.
 */
export async function loadSingleFile(path: string, opts: GuardOptions = {}): Promise<FileDescriptor> {
  for (const g of opts.allowPublic ?? []) validateAllowPublicGlob(g, [basename(resolve(path))]);
  assertNotSymlink(path, "file");
  const abs = resolve(path);
  const scanned = lstatSync(abs);
  if (!scanned.isFile()) throw new Error(`"${safe(path)}" is not a regular file`);
  if (scanned.size > MAX_READ_FILE_BYTES) throw tooLargeToReadError(safe(path), scanned.size);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`refusing to upload "${safe(path)}": it became a symlink while it was being read.`);
    }
    throw e;
  }
  let bytes: Uint8Array;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== scanned.dev || st.ino !== scanned.ino) {
      throw new Error(`"${safe(path)}" changed while it was being read; refusing to upload it`);
    }
    bytes = new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
  const name = basename(abs);
  const sniff = sniffSecret(bytes, name);
  const reason = sniff.reason;
  if (sniff.partial) warnPartlyScanned([name]);
  if (reason || isSecretLikePath(name)) await confirmSecrets([name], opts, reason ? { [name]: reason } : {});
  return { path: name, bytes, mimeType: inferMimeType(name) };
}

/** Check-only form of {@link loadSingleFile} (kept for callers that read the file themselves). */
export async function checkSingleFile(path: string, opts: GuardOptions = {}): Promise<void> {
  await loadSingleFile(path, opts);
}
