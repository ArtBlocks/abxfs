/**
 * Semantic-versioning conventions for tag strings.
 *
 * The on-chain `ProjectHook` treats tag strings as opaque names. Semver — the most
 * common versioning convention in software — is a **client-side overlay** on top of those
 * opaque tags. This module is intentionally minimal: it only does what's needed to detect
 * semver-shaped tags and pick the highest-precedence one from a list. **It does not
 * implement range matching** (`^1.2.3`, `~1.0`, `>=2.0 <3.0`); consumers wanting that
 * should drop in [`node-semver`](https://github.com/npm/node-semver) themselves over the
 * tag list returned by `listTags`.
 *
 * Why we don't bundle range matching here:
 *  - It would force a dependency on `node-semver` (or a hand-rolled equivalent) into every
 *    SDK consumer, which is unwanted weight for clients that just want to read tags.
 *  - Different ecosystems (Cargo, npm, Go modules) disagree about range semantics; baking
 *    one interpretation into the SDK would be subtly wrong for the others. Leaving it as
 *    a "bring your own range matcher" call keeps the protocol agnostic.
 *
 * Spec subset: `[v]MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`. Build metadata is parsed but
 * ignored for ordering, per [semver.org §10](https://semver.org/#spec-item-10).
 */

/**
 * Strict semver shape: optional `v` prefix, three dot-separated numeric components, optional
 * `-prerelease` (alphanumeric / hyphen / dot identifiers), optional `+build` metadata.
 *
 * Anchored to start/end so an `examples-1.2.3` style tag does NOT count as semver — only
 * pure semver tags participate in `pickLatestSemverTag` ordering.
 */
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Returns true if the tag string matches the strict semver shape used by {@link parseSemver}. */
export function isSemverTag(tag: string): boolean {
  return SEMVER_RE.test(tag);
}

interface ParsedSemver {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, dot-split. `undefined` if there's no prerelease. */
  prerelease?: string[];
}

/**
 * Parse a semver-shaped tag into its components. Returns `null` if the tag isn't semver.
 *
 * Build metadata (`+build.123`) is intentionally dropped — semver §10 specifies that build
 * metadata MUST be ignored for precedence comparisons, so storing it would just invite
 * accidental misuse.
 */
export function parseSemver(tag: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(tag);
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  return {
    raw: tag,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split(".") : undefined,
  };
}

/**
 * Sort and return the highest-precedence semver-shaped tag from a list.
 *
 * Non-semver tags are ignored (they can still exist; they just don't participate in this
 * ordering). Returns `undefined` when no input matches.
 *
 * Precedence rules implemented (semver §11):
 *  - Compare major, minor, patch numerically in order.
 *  - A version WITH a prerelease has lower precedence than the same version WITHOUT one
 *    (e.g. `1.2.3-rc1` < `1.2.3`).
 *  - Prerelease identifiers are compared field-by-field; numeric < alphanumeric, and
 *    a shorter set of fields loses to a longer set with all-equal-prefix.
 */
export function pickLatestSemverTag(tags: readonly string[]): string | undefined {
  let best: ParsedSemver | undefined;
  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (!best || compareSemver(parsed, best) > 0) {
      best = parsed;
    }
  }
  return best?.raw;
}

/**
 * Compare two parsed semver structs. Returns >0 if `a` is higher precedence, <0 if lower,
 * 0 if equal (note: equal precedence is possible across different `raw` strings, e.g.
 * `1.0.0` and `v1.0.0`).
 */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Per semver §11: a version without prerelease > a version with prerelease.
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;

  return comparePrerelease(a.prerelease!, b.prerelease!);
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] as string;
    const bi = b[i] as string;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else if (aNum && !bNum) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      const cmp = ai < bi ? -1 : ai > bi ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  // All shared identifiers equal; the shorter set has lower precedence.
  return a.length - b.length;
}
