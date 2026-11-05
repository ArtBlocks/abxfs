/**
 * What a request addresses, parsed ONCE and strictly.
 *
 * This file is pure string logic with no Node or chain dependency, so it can run in Edge middleware
 * (it is re-exported from `@abxfs/gateway/subjects`). Everything that needs to know "which project,
 * org or root is this request?" derives it from the parsers here or from `parseContentHost`
 * (`@abxfs/sdk`), and from nowhere else: the audit's filter bypass was two parsers that
 * disagreed (`/^\d+$/` deciding the subjects, `Number()` deciding what was served), so `+84532`,
 * `0x14a34` and `8.4532e4` were served and filtered as nothing.
 *
 * Canonical forms only. A number is `[1-9][0-9]*` (token ids may be `0`), an address is `0x` and 40 hex
 * digits (case is folded, because checksummed addresses are what people paste), a root is `0x` and 64
 * hex digits. Anything else is rejected, never coerced.
 */
import type { AbxfsCid } from "@abxfs/sdk";
import { decodeEntryName } from "@abxfs/sdk/names";

import { GatewayError } from "./errors.js";

/** How a request addressed its content. Determines cacheability and filter subjects. */
export type Addressing =
  | { kind: "cid"; rootCid: AbxfsCid }
  | { kind: "version"; org: `0x${string}`; tokenId: bigint; version: number }
  | { kind: "tag"; org: `0x${string}`; tokenId: bigint; tag: string }
  | { kind: "latest"; org: `0x${string}`; tokenId: bigint };

export const CHAIN_ID_RE = /^[1-9][0-9]{0,9}$/;
export const ORG_RE = /^0x[0-9a-fA-F]{40}$/;
/** Token ids up to 10 digits: the most a content host label can carry. */
export const TOKEN_ID_RE = /^(0|[1-9][0-9]{0,9})$/;
/** Token ids as the app's own pages take them (any uint256 in decimal). */
export const TOKEN_ID_WIDE_RE = /^(0|[1-9][0-9]{0,77})$/;
export const VERSION_RE = /^[1-9][0-9]{0,8}$/;
export const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

/** A tag is a short name; no control characters, no path separators. */
const MAX_TAG_BYTES = 128;

export function parseChainId(raw: string | undefined): number {
  if (raw === undefined || !CHAIN_ID_RE.test(raw)) throw new GatewayError(`invalid chain id`, 400);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new GatewayError(`invalid chain id`, 400);
  return n;
}

export function parseOrg(raw: string | undefined): `0x${string}` {
  if (raw === undefined || !ORG_RE.test(raw)) throw new GatewayError(`invalid org address`, 400);
  return raw.toLowerCase() as `0x${string}`;
}

export function parseTokenId(raw: string | undefined, wide = false): bigint {
  if (raw === undefined || !(wide ? TOKEN_ID_WIDE_RE : TOKEN_ID_RE).test(raw)) {
    // A canonical id that is merely LONG is a real token this addressing cannot carry, not a typo: say so.
    if (!wide && raw !== undefined && TOKEN_ID_WIDE_RE.test(raw)) {
      throw new GatewayError(
        `token id ${raw} has more than 10 digits: a content host label carries at most 10, so this project cannot be ` +
          "addressed by URL here (its content is still reachable by root CID)",
        400,
      );
    }
    throw new GatewayError(`invalid token id`, 400);
  }
  return BigInt(raw);
}

export function parseRoot(raw: string | undefined): AbxfsCid {
  if (raw === undefined || !ROOT_RE.test(raw)) throw new GatewayError(`invalid root CID`, 400);
  return raw.toLowerCase() as AbxfsCid;
}

export function parseVersion(raw: string | undefined): number {
  if (raw === undefined || !VERSION_RE.test(raw)) throw new GatewayError(`invalid version`, 400);
  return Number(raw);
}

/** Decode one percent-encoded segment. A malformed escape is the visitor's mistake: 400, not 502. */
export function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new GatewayError("malformed percent-escape in path", 400);
  }
}

/** True for a decoded segment that must never reach a store or an upstream URL. */
export function isUnsafeSegment(decoded: string): boolean {
  if (decoded === "" || decoded === "." || decoded === "..") return true;
  // `/` would make one segment into two after the checks; `\` is a separator to some servers;
  // NUL and the other control characters have no business in a file name.
  // eslint-disable-next-line no-control-regex
  return /[\/\\\u0000-\u001f\u007f]/.test(decoded);
}

/**
 * Split a URL pathname into its raw (still percent-encoded) segments.
 *
 * A trailing slash is reported rather than producing an empty segment. An empty segment anywhere else
 * (`a//b`) is refused: `//` is how an open redirect or a second spelling of the same path starts.
 */
export function splitPathname(pathname: string): { segments: string[]; trailingSlash: boolean } {
  if (!pathname.startsWith("/")) throw new GatewayError("bad request path", 400);
  const parts = pathname.slice(1).split("/");
  const trailingSlash = parts.length > 0 && parts[parts.length - 1] === "";
  if (trailingSlash) parts.pop();
  if (parts.some((p) => p === "")) throw new GatewayError("empty path segment", 400);
  return { segments: parts, trailingSlash };
}

/**
 * One percent-encoded path segment as the BYTES it names. A name on chain is bytes, not necessarily UTF-8, so `%FF`
 * is a byte like any other; a malformed escape is the visitor's mistake: 400, not 502.
 */
export function segmentBytes(raw: string): Uint8Array {
  const out: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === "%") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new GatewayError("malformed percent-escape in path", 400);
      out.push(parseInt(hex, 16));
      i += 3;
    } else {
      const next = raw.indexOf("%", i);
      const end = next < 0 ? raw.length : next;
      for (const b of utf8.encode(raw.slice(i, end))) out.push(b);
      i = end;
    }
  }
  return Uint8Array.from(out);
}

/** True for name bytes that must never reach a store: empty, `.`, `..`, `/`, `\`, NUL or another control byte. */
export function isUnsafeNameBytes(b: Uint8Array): boolean {
  if (b.length === 0) return true;
  if (b.length <= 2 && b.every((x) => x === 0x2e)) return true;
  return b.some((x) => x === 0x2f || x === 0x5c || x < 0x20 || x === 0x7f);
}

/** A name's bytes as one path segment: what `encodeURIComponent` gives for UTF-8, and `%XX` for every other byte. */
export function encodePathSegment(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && /[A-Za-z0-9\-_.!~*'()]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The sub-path inside a root, decoded and checked. Each segment is percent-decoded to bytes and carried in the SDK's
 * lossless text form of a name (`decodeEntryName`: UTF-8 as text, any other byte as `\xHH`), so a name that is not
 * UTF-8 resolves too. Throws 400 on `.`, `..`, empty, backslash, control characters, an encoded `/`, or a malformed
 * escape.
 */
export function parseSubpath(rawSegments: readonly string[]): string {
  return rawSegments
    .map((s) => {
      const bytes = segmentBytes(s);
      if (isUnsafeNameBytes(bytes)) throw new GatewayError("invalid path segment", 400);
      return decodeEntryName(bytes);
    })
    .join("/");
}

export function parseTag(raw: string | undefined): string {
  if (!raw) throw new GatewayError("missing tag name", 400);
  const tag = decodeSegment(raw);
  if (isUnsafeSegment(tag) || new TextEncoder().encode(tag).length > MAX_TAG_BYTES) {
    throw new GatewayError("invalid tag name", 400);
  }
  return tag;
}

/** The path form's `/cid/…` and `/p/…` shapes, parsed but with the sub-path left raw. */
export type PathRoute =
  | { kind: "cid"; chainId: number; rootCid: AbxfsCid; rest: string[] }
  | {
      kind: "project";
      chainId: number;
      org: `0x${string}`;
      tokenId: bigint;
      selector: { kind: "latest" } | { kind: "version"; version: number } | { kind: "tag"; tag: string };
      rest: string[];
    };

/**
 * Parse the segments after the mount point of the path form:
 *
 *     cid/<chainId>/<root>/<subpath…>
 *     p/<chainId>/<org>/<tokenId>[/latest|/v/<n>|/tag/<tag>]/<subpath…>
 *
 * This form puts every project on one origin, so it is a redirect on the site and an explicit opt-in
 * (`--path-mode`) on a standalone gateway. `rest` is returned raw and still encoded.
 */
export function parsePathSegments(segments: readonly string[]): PathRoute {
  const [head, ...tail] = segments;
  if (head === "cid") {
    const [rawChain, rawCid, ...rest] = tail;
    return { kind: "cid", chainId: parseChainId(rawChain), rootCid: parseRoot(rawCid), rest };
  }
  if (head === "p") {
    const [rawChain, rawOrg, rawToken, selector, ...more] = tail;
    const chainId = parseChainId(rawChain);
    const org = parseOrg(rawOrg);
    const tokenId = parseTokenId(rawToken);
    if (selector === undefined || selector === "latest") {
      return { kind: "project", chainId, org, tokenId, selector: { kind: "latest" }, rest: more };
    }
    if (selector === "v") {
      const [rawVersion, ...rest] = more;
      return { kind: "project", chainId, org, tokenId, selector: { kind: "version", version: parseVersion(rawVersion) }, rest };
    }
    if (selector === "tag") {
      const [rawTag, ...rest] = more;
      return { kind: "project", chainId, org, tokenId, selector: { kind: "tag", tag: parseTag(rawTag) }, rest };
    }
    throw new GatewayError(`unknown selector — expected latest, v, or tag`, 400);
  }
  throw new GatewayError(`unknown gateway route — expected /cid or /p`, 400);
}

/** Parse gateway segments (after the mount point) into a chain, an addressing mode and a sub-path. */
export function parseGatewayPath(segments: string[]): { chainId: number; addressing: Addressing; subpath: string } {
  const route = parsePathSegments(segments);
  const subpath = parseSubpath(route.rest);
  if (route.kind === "cid") {
    return { chainId: route.chainId, addressing: { kind: "cid", rootCid: route.rootCid }, subpath };
  }
  const { chainId, org, tokenId, selector } = route;
  const addressing: Addressing =
    selector.kind === "latest"
      ? { kind: "latest", org, tokenId }
      : selector.kind === "version"
        ? { kind: "version", org, tokenId, version: selector.version }
        : { kind: "tag", org, tokenId, tag: selector.tag };
  return { chainId, addressing, subpath };
}
