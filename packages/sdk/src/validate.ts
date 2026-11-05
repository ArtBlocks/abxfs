/**
 * Client-side validation for the two user-supplied strings a project carries, surfaced in the UI
 * BEFORE a signature so a cryptic revert never arrives mid-flight.
 *
 * The two rules are no longer symmetric, and that asymmetry is the point:
 *
 * **Tag names are a strict mirror of on-chain law.** `ProjectHook._validateTag` enforces
 * `^[a-z0-9][a-z0-9._-]{0,63}$` and rejects the reserved `latest`; a client-side check that
 * disagreed would either block a valid tag or let a doomed transaction through. Keep
 * {@link validateTagName} in lockstep with `ProjectHook` (`_validateTag`, `_isReservedTag`,
 * `_MAX_TAG_BYTES`) — the contract is the source of truth.
 *
 * **Project names have no on-chain grammar at all.** `abxfs.name` is a `String` PostParam; the hook
 * bounds its SIZE (128 bytes) and nothing else. A project is named by chain, org and token id, and the
 * name is pure display metadata — so "My Cool Art" is a perfectly good project name and forcing
 * "my-cool-art" would be inventing a restriction the protocol does not have.
 * {@link validateProjectName} therefore checks only what actually fails: byte length, and control
 * characters that would corrupt a rendered document. Use {@link suggestProjectName} when a slug is
 * wanted for a URL.
 */

/**
 * Byte cap matching `ProjectHook.MAX_NAME_BYTES`.
 *
 * A UTF-8 name can exceed this while looking short — one emoji is four bytes — so this is measured
 * in BYTES, unlike the old ASCII-only grammar where bytes and characters agreed.
 */
export const MAX_PROJECT_NAME_BYTES = 128;
/** Byte cap matching `ProjectHook._MAX_TAG_BYTES`. */
export const MAX_TAG_BYTES = 64;

/** The single tag string the hook reserves for "project head". */
export const RESERVED_TAGS: readonly string[] = ["latest"];

const TAG_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
// C0 and C1 control ranges, plus the line/paragraph separators. These are what would break an SVG
// card or an HTML listing; everything else printable is the user's business.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface ValidationResult {
  /** True iff the input would be accepted by the on-chain validator. */
  ok: boolean;
  /**
   * Human-readable error message suitable for inline display in a form. Only
   * present when `ok === false`. Phrased imperatively ("Use only…") rather
   * than as a description ("Name must…") so it reads naturally next to an
   * input field.
   */
  error?: string;
}

/**
 * Validate a project name: 1..{@link MAX_PROJECT_NAME_BYTES} UTF-8 bytes, no control characters.
 *
 * Free-form on purpose — mixed case, spaces, punctuation and emoji are all fine, because
 * `abxfs.name` is display metadata with no on-chain grammar behind it. The two rejections both
 * correspond to something that genuinely breaks: the hook reverts `BlobTooLarge` past the byte cap,
 * and control characters corrupt the documents the name is rendered into.
 */
export function validateProjectName(name: string): ValidationResult {
  if (name.length === 0) {
    return { ok: false, error: "Required" };
  }
  const bytes = utf8Length(name);
  if (bytes > MAX_PROJECT_NAME_BYTES) {
    // Report bytes, not characters: a name of 40 emoji is 160 bytes, and "40 characters is too
    // long" next to a 128-character limit reads as a bug.
    return {
      ok: false,
      error: `Must be ${MAX_PROJECT_NAME_BYTES} bytes or fewer (this is ${bytes})`,
    };
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return { ok: false, error: "Remove control characters" };
  }
  if (name.trim().length === 0) {
    return { ok: false, error: "Required" };
  }
  return { ok: true };
}

/**
 * Validate a tag name against the hook's grammar `^[a-z0-9][a-z0-9._-]*$`, length 1..64 bytes, plus
 * the `latest` reservation. A strict mirror of `ProjectHook._validateTag`.
 *
 * `.` is allowed so semver-shaped tags (`v1.2.3`, `v1.2.3-rc.1`) work. Uppercase is rejected on
 * chain so case-folding cannot produce two tags that look identical to a human but address
 * differently.
 */
export function validateTagName(tag: string): ValidationResult {
  if (tag.length === 0) {
    return { ok: false, error: "Required" };
  }
  if (tag.length > MAX_TAG_BYTES) {
    return {
      ok: false,
      error: `Must be ${MAX_TAG_BYTES} characters or fewer`,
    };
  }
  if (RESERVED_TAGS.includes(tag)) {
    return { ok: false, error: `"${tag}" is reserved by the protocol` };
  }
  if (/[A-Z]/.test(tag) || /\s/.test(tag)) {
    return {
      ok: false,
      error: "Use only lowercase letters, numbers, dots (.), hyphens (-) and underscores (_)",
    };
  }
  if (!TAG_NAME_RE.test(tag)) {
    if (!/^[a-z0-9]/.test(tag)) {
      return { ok: false, error: "Must start with a lowercase letter or number" };
    }
    return {
      ok: false,
      error: "Use only lowercase letters, numbers, dots (.), hyphens (-) and underscores (_)",
    };
  }
  return { ok: true };
}

/**
 * Best-effort sanitizer that turns a free-form input (e.g. a folder name or
 * project title the user typed in mixed case with spaces) into a string that
 * passes {@link validateProjectName}. Truncates to the byte cap. Returns "" if
 * nothing salvageable remains, leaving the caller to surface "Required".
 *
 * This is for *defaulting* form fields, not for silently coercing user input —
 * always show the sanitized result back to the user so they can confirm or
 * edit.
 */
export function suggestProjectName(input: string): string {
  const lower = input.toLowerCase();
  // Replace runs of disallowed characters with a single hyphen to preserve
  // word boundaries (e.g. "My Cool Project" → "my-cool-project" instead of
  // "mycoolproject").
  const collapsed = lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  // Strip a leading non-alnum (the regex above keeps `-_` so we could end up
  // with a leading hyphen if the input was e.g. "_foo"); we already guarantee
  // alnum starts here by trimming hyphens, but underscores can still leak.
  const trimmed = collapsed.replace(/^[^a-z0-9]+/, "");
  return trimmed.slice(0, MAX_PROJECT_NAME_BYTES);
}

/**
 * Throw, BEFORE anything is sent, when a tag or project name the caller supplied would be refused
 * (the hook reverts a bad tag after the version was already paid for; a bad name is only discovered by
 * the last transaction of a publish). Every publishing entry point calls this first, ahead of any content
 * upload and ahead of `mintProject`, so a typo costs nothing and leaves nothing behind.
 */
export function assertValidPublishInputs(inputs: { tag?: string | undefined; name?: string | undefined }): void {
  if (inputs.tag !== undefined && inputs.tag !== "") {
    const v = validateTagName(inputs.tag);
    if (!v.ok) throw new Error(`invalid tag "${inputs.tag}": ${v.error}. Nothing was sent.`);
  }
  if (inputs.name !== undefined && inputs.name !== "") {
    const v = validateProjectName(inputs.name);
    if (!v.ok) throw new Error(`invalid project name: ${v.error}. Nothing was sent.`);
  }
}
