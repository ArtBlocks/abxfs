/**
 * The declared type of a file, read the way a browser will read it, and whether it must be sandboxed.
 *
 * A file's MIME type is whatever its uploader wrote into `FileStore`: attacker text. The gateway puts it in
 * `Content-Type`, and the browser then runs Fetch's "extract a MIME type" on that header value: it SPLITS the value on
 * commas (outside quoted strings) and the LAST valid type wins. A decision made on the text before the first `;`
 * therefore disagrees with the browser: `image/svg+xml,` and `text/html, image/svg+xml` are SVG to the browser and
 * nothing recognisable to a naive check, so they were served without the sandbox and their script ran on the content
 * origin (reproduced in a real Chrome).
 *
 * So the gateway serves a declared type only when it is exactly ONE valid MIME type (RFC 9110 `media-type`: a token,
 * `/`, a token, then `;`-separated `name=value` parameters whose value is a token or a quoted string; printable ASCII
 * only). Then the browser's parse and this one agree by construction. Anything else (a list, an empty value, a stray
 * character, non-ASCII) is served as `application/octet-stream` WITH the sandbox: what such a header would make a
 * browser do is exactly the question this refuses to answer.
 */

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
/** `"` … `"` with qdtext (HTAB, SP, 0x21, 0x23-0x5B, 0x5D-0x7E) or a quoted-pair. No obs-text: ASCII only. */
const QUOTED = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*"';
const PARAMETER = `${TOKEN}=(?:${TOKEN}|${QUOTED})`;
const MEDIA_TYPE = new RegExp(`^(${TOKEN})/(${TOKEN})(?:[ \\t]*;[ \\t]*(?:${PARAMETER})?)*$`);
/** HTTP whitespace, trimmed from both ends before parsing (as the browser does). */
const HTTP_WS = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** What to send for a declared type. */
export interface ServedType {
  /** The `Content-Type` value: the declared type when it is one valid MIME type, else `application/octet-stream`. */
  contentType: string;
  /** `type/subtype`, lowercase. */
  essence: string;
  /** Send `Content-Security-Policy: sandbox`: an active document type, or a declared type that did not parse. */
  sandbox: boolean;
}

/** The essence (`type/subtype`, lowercase) of a declared type that is exactly one valid MIME type, else null. */
export function singleMimeEssence(declared: string): string | null {
  const m = MEDIA_TYPE.exec(declared.replace(HTTP_WS, ""));
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
}

/**
 * Types a browser renders as an XML document, where script (and XSLT) runs on direct navigation: `text/xml`,
 * `application/xml`, every `+xml` (SVG, XHTML, RSS, MathML, XSLT, ...), and `text/xsl` (an XML type to Chromium,
 * which renders it and runs an XHTML `<script>` inside it).
 */
export function isActiveEssence(essence: string): boolean {
  const slash = essence.indexOf("/");
  const subtype = essence.slice(slash + 1);
  return subtype === "xml" || subtype.endsWith("+xml") || essence === "text/xsl";
}

/**
 * The essences that tell a browser "I do not know": the MIME Sniffing standard runs its unknown-type rules on exactly
 * these (`unknown/unknown`, `application/unknown`, and star-slash-star), so what the browser does with the bytes is a sniff, not
 * the declared type. `nosniff` keeps it from sniffing a scriptable type in today's browsers; the sandbox makes that
 * not matter.
 */
const SNIFF_ESSENCES = new Set(["unknown/unknown", "application/unknown", "*/*"]);

/** A declared essence a browser sniffs rather than obeys. Sandboxed like an active type. */
export function isSniffedEssence(essence: string): boolean {
  return SNIFF_ESSENCES.has(essence);
}

/** What the gateway sends for a file whose uploader declared `declared`. */
export function servedType(declared: string): ServedType {
  const essence = singleMimeEssence(declared);
  if (essence === null) return { contentType: "application/octet-stream", essence: "application/octet-stream", sandbox: true };
  return { contentType: declared.replace(HTTP_WS, ""), essence, sandbox: isActiveEssence(essence) || isSniffedEssence(essence) };
}
