/**
 * Ready-made filters, and the one rule they share.
 *
 * A policy here is a list of **subjects** — `project:<chain>:<org>:<id>`, `org:<chain>:<org>`,
 * `root:<cid>` — one per line. Those are the only things a URL can name, so they are the only things a
 * gateway can refuse without reading the chain, which is what keeps a filter cheap and its answer
 * independent of whatever the RPC is doing.
 *
 * Nothing here is protocol state, and nothing may become so: a gateway has opinions and the protocol
 * does not. Run yours with an empty list, a long one, or none.
 */
import { readFileSync, statSync } from "node:fs";

import { isAddress } from "viem";

import { orgSubjectParts, parseSubject } from "./subjects.js";
import type { Filter } from "./types.js";

/** Refuse a request if ANY subject it names is in the list. */
export function denylistFilter(subjects: Iterable<string>): Filter {
  const set = new Set<string>();
  for (const s of subjects) {
    const parsed = parseSubject(s);
    if (parsed) set.add(parsed);
  }
  return ({ subjects: named }) =>
    named.some((s) => set.has(s)) ? { allow: false, reason: "denylisted" } : { allow: true };
}

/**
 * Serve ONLY requests that name something in the list: a project, its org, or a root.
 *
 * A request that names nothing recognisable is refused too — an allowlist that waved through what it
 * cannot classify would not be one. Note `org:` admits every project under it but not those projects'
 * raw-CID URLs; list the roots too if you want those served.
 */
export function allowlistFilter(subjects: Iterable<string>): Filter {
  const set = new Set<string>();
  for (const s of subjects) {
    const parsed = parseSubject(s);
    if (parsed) set.add(parsed);
  }
  return ({ subjects: named }) =>
    named.some((s) => set.has(s)) ? { allow: true } : { allow: false, reason: "not allowlisted" };
}

/**
 * Serve ONLY the projects of the orgs listed — the simplest allowlist, for "this gateway is for these
 * orgs and nothing else".
 *
 * An org is named by address alone, on whichever chain the gateway serves. A request is served when
 * the org it names is listed. `/g/cid/<chain>/<root>` URLs are refused: a raw root names content, not an org,
 * so there is nothing to check it against. That is the point of an orgs-only gateway, and it is why
 * a project's own pages (`/g/p/…`) keep working while a bare CID does not.
 */
export function orgAllowlistFilter(orgs: Iterable<string>): Filter {
  const set = new Set<string>();
  for (const o of orgs) if (isAddress(o)) set.add(o.toLowerCase());
  return ({ subjects: named }) => {
    for (const s of named) {
      const parts = orgSubjectParts(s);
      if (parts && set.has(parts.org.toLowerCase())) return { allow: true };
    }
    return { allow: false, reason: "org not allowlisted" };
  };
}

/** Every filter must allow. The first refusal wins and its reason is kept. */
export function allOf(...filters: Filter[]): Filter {
  return async (ctx) => {
    for (const f of filters) {
      const d = await f(ctx);
      if (!d.allow) return d;
    }
    return { allow: true };
  };
}

export interface FileFilterOptions {
  /** How often to look at the file's modification time. Default 5s. */
  refreshMs?: number;
  /** Called with a line that is not a valid subject. Default: ignored. */
  onInvalid?: (line: string, lineNumber: number) => void;
  /** Called when a re-read fails. The last good list stays in force. */
  onError?: (err: unknown) => void;
}

/**
 * Parse a list file: one subject per line, `#` starts a comment, blank lines ignored. Invalid lines
 * are reported and skipped rather than failing the whole file, since one typo must not unblock or
 * block everything.
 */
export function parseListFile(contents: string, onInvalid?: FileFilterOptions["onInvalid"]): string[] {
  const out: string[] = [];
  contents.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const parsed = parseSubject(line);
    if (parsed) out.push(parsed);
    else onInvalid?.(line, i + 1);
  });
  return out;
}

/**
 * Parse an org list: one address per line (an `org:<chain>:<address>` subject is accepted too), `#`
 * starts a comment. Anything else is reported and skipped.
 */
export function parseOrgList(contents: string, onInvalid?: FileFilterOptions["onInvalid"]): string[] {
  const out: string[] = [];
  contents.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const address = isAddress(line) ? line : orgSubjectParts(line)?.org;
    if (address) out.push(address);
    else onInvalid?.(line, i + 1);
  });
  return out;
}

/**
 * What `--allow-orgs` takes: addresses separated by commas, or the path of a file of them.
 * Anything with a comma, or that is itself an address, is a list; the rest is a path.
 */
export function orgAllowlistFromArg(value: string, options: FileFilterOptions = {}): Filter {
  const v = value.trim();
  if (v.includes(",") || isAddress(v)) {
    const items = v.split(",").map((x) => x.trim()).filter(Boolean);
    const bad = items.find((x) => !isAddress(x));
    if (bad) throw new Error(`"${bad}" is not an address`);
    return orgAllowlistFilter(items);
  }
  return fileFilter(v, "allow-orgs", options);
}

/**
 * A list kept in a file, re-read when it changes — so an operator edits a text file and the gateway
 * follows, with no restart and no service in between.
 *
 * The file must be readable at startup: a gateway that was told to apply a policy and could not load
 * it should not start serving without one. After that, a failed re-read keeps the LAST GOOD list
 * rather than dropping to empty, which would turn a transient disk error into "everything is
 * allowed" (deny) or "nothing is" (allow).
 */
export function fileFilter(
  path: string,
  mode: "deny" | "allow" | "allow-orgs",
  options: FileFilterOptions = {},
): Filter {
  const refreshMs = options.refreshMs ?? 5_000;
  let current: Filter;
  let mtime = -1;
  let lastCheck = 0;

  const load = () => {
    const stat = statSync(path);
    if (stat.mtimeMs === mtime) return;
    const text = readFileSync(path, "utf8");
    current =
      mode === "allow-orgs"
        ? orgAllowlistFilter(parseOrgList(text, options.onInvalid))
        : mode === "deny"
          ? denylistFilter(parseListFile(text, options.onInvalid))
          : allowlistFilter(parseListFile(text, options.onInvalid));
    mtime = stat.mtimeMs;
  };

  load(); // throws if unreadable: see above

  return (ctx) => {
    const now = Date.now();
    if (now - lastCheck >= refreshMs) {
      lastCheck = now;
      try {
        load();
      } catch (err) {
        options.onError?.(err);
      }
    }
    return current(ctx);
  };
}
