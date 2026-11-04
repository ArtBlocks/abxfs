/**
 * Making on-chain strings safe to show.
 *
 * Names (org, project, file) are written by other people and are frozen or unvetted. They can carry
 * bidirectional overrides (display text reversed), zero-width and other format characters (two names
 * that look identical), and terminal control sequences (rewriting a user's screen). Every place that
 * shows one goes through here, so there is one rule rather than several drifting copies.
 */

/** Zero-width, bidi, variation-selector and other invisible format characters, line/paragraph separators. */
const INVISIBLE = new RegExp(
  "[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb]",
  "g",
);
/** Astral invisibles: tag characters, variation selectors supplement (U+E0100-E01EF), musical format controls. */
const INVISIBLE_ASTRAL = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u{1d173}-\u{1d17a}]/gu;
/** Every Unicode space separator (Zs) except the plain space: NBSP, Ogham space, en/em/thin spaces, narrow NBSP, ideographic space... */
const UNICODE_SPACES = new RegExp("[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]", "g");
/** Arabic number signs (U+0600-0605) and Braille blank: render as nothing or as spoofable spacing. */
const SPOOF_BMP = new RegExp("[\\u0600-\\u0605\\u2800]", "g");
const NON_PRINTABLE_ASCII = new RegExp("[^\\u0020-\\u007e]", "g");
const OSC_LIKE = new RegExp(
  "(?:\\u001b[\\]PX^_]|[\\u0090\\u009d\\u009e\\u009f\\u0098])[^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u001b\\\\|\\u009c)?",
  "g",
);
const CSI = new RegExp("(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]", "g");
const ESC_REST = new RegExp("\\u001b[ -/]*[0-~]?", "g");
const WHITESPACE_CTRL = new RegExp("[\\t\\r\\n\\v\\f]", "g");
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/**
 * Printable ASCII only, with control, format and bidi characters removed and whitespace collapsed.
 * Anything non-ASCII is dropped (so a homoglyph name collapses to what is actually ASCII in it),
 * and the result is bounded. Never throws.
 */
export function sanitizeDisplayName(value: unknown, maxLength = 64): string {
  if (typeof value !== "string") return "";
  return value
    .replace(INVISIBLE, "")
    .replace(UNICODE_SPACES, " ")
    .replace(NON_PRINTABLE_ASCII, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * For TERMINAL output: strip C0 and C1 control characters and ANSI/OSC escape sequences, plus the
 * invisible/bidi set. Non-ASCII text is kept (a legitimate file name can be Japanese); only what can
 * drive the terminal or visually reorder the line is removed. Newlines and tabs become a space.
 */
export function stripTerminalControl(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(OSC_LIKE, "")
    .replace(CSI, "")
    .replace(ESC_REST, "")
    .replace(WHITESPACE_CTRL, " ")
    .replace(UNICODE_SPACES, " ") // visible, but two names differing only in their space characters look identical
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(INVISIBLE_ASTRAL, "")
    .replace(SPOOF_BMP, "");
}

/**
 * A file or directory path for DISPLAY (tree, breadcrumbs, alt text, editors). Strips bidi, format,
 * zero-width, variation and control characters but keeps non-ASCII letters, so a Japanese file name is
 * still readable while `invoice\u202Efdp.exe` can no longer pose as `invoiceexe.pdf`. Never throws.
 */
export function displayPath(value: unknown): string {
  return stripTerminalControl(typeof value === "string" ? value.replace(/[\t\r\n\v\f]/g, "\u2423") : value);
}
