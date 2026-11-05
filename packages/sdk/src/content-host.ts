/**
 * Where a project's content is served: one HOST per project.
 *
 * A website hosted on ABX FS uses root-absolute links (`/style.css`), and project code is attacker
 * controlled. Both are solved by giving every project its own origin, so a project is served at
 *
 *     https://<chain>-<org>-<id>.<content domain>/            the project's latest version
 *     https://<chain>-<org>-<id>-v<n>.<content domain>/       a pinned version (permalink)
 *     https://<chain>-<base32 root>.<content domain>/         raw content by root, no project
 *
 * and the app's own origin serves none of it. The label is the project's whole identity (token ids
 * repeat across orgs and orgs across chains), it is a single DNS label so ONE wildcard certificate
 * covers every project, and it is at most 63 characters:
 *
 *     chain (1-10 digits) + '-' + org (40 hex, lowercase, no 0x) + '-' + id (1-10 digits) + '-v' + n
 *     chain (1-10 digits) + '-' + root (52 base32 characters)
 *
 * A root names the chain it is read from, like a project does. The same bytes have the same root on every chain, so
 * the chain does not identify the content; it says where to read it, so a gateway asks one chain, not every one.
 *
 * Parsing is deliberately strict and canonical: a single spelling per project. A second spelling
 * (`+84532`, `0x14a34`, leading zeros, a `0x` prefix on the address) is how a deny list gets walked around,
 * so none is accepted here, and everything that needs "which project is this?" derives it from THIS parse and
 * nowhere else. (Hostnames are case-insensitive on the wire, so the host is lowercased first: an uppercase spelling
 * is the same project, with the same filter subjects, not a second spelling.)
 *
 * Tags are not addressable by host (a tag may contain characters a hostname cannot); a tag's content is
 * reachable at the version it points to.
 */
import type { Address } from "viem";

import { asAbxfsCid, type AbxfsCid } from "./types.js";

export interface ContentProject {
  chainId: number;
  org: Address | string;
  tokenId: bigint | number;
  /** Pin a version (1-based). Omit to follow the head. */
  version?: number;
}

export type ParsedContentLabel =
  | { kind: "project"; chainId: number; org: Address; tokenId: bigint; version?: number }
  | { kind: "root"; chainId: number; rootCid: AbxfsCid };

const MAX_CHAIN_DIGITS = 10;
const MAX_ID_DIGITS = 10;

/** DNS: a label is at most 63 octets. */
const MAX_LABEL = 63;

const PROJECT_LABEL = new RegExp(
  `^([1-9][0-9]{0,${MAX_CHAIN_DIGITS - 1}})-([0-9a-f]{40})-(0|[1-9][0-9]{0,${MAX_ID_DIGITS - 1}})(?:-v([1-9][0-9]{0,8}))?$`,
);
const ROOT_LABEL = new RegExp(`^([1-9][0-9]{0,${MAX_CHAIN_DIGITS - 1}})-([a-z2-7]{52})$`);

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. 32 bytes is 52 characters, which fits one DNS label. */
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  // The leftover bits must be zero, or two different strings would decode to the same bytes.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** The single DNS label for a project (and optionally a pinned version). Throws on malformed input. */
export function contentLabel(p: ContentProject): string {
  const org = String(p.org).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(org)) throw new Error(`not an org address: ${String(p.org)}`);
  checkChainId(p.chainId);
  const id = BigInt(p.tokenId);
  if (id < 0n || id.toString().length > MAX_ID_DIGITS) throw new Error(`token id out of range: ${p.tokenId}`);
  let label = `${p.chainId}-${org.slice(2)}-${id}`;
  if (p.version !== undefined) {
    if (!Number.isSafeInteger(p.version) || p.version < 1 || String(p.version).length > 9) {
      throw new Error(`version out of range: ${p.version}`);
    }
    label += `-v${p.version}`;
  }
  if (label.length > MAX_LABEL) throw new Error(`label would be ${label.length} characters; the DNS limit is ${MAX_LABEL}`);
  return label;
}

function checkChainId(chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || String(chainId).length > MAX_CHAIN_DIGITS) {
    throw new Error(`chain id out of range: ${chainId}`);
  }
}

/** The label for raw content by root CID, read on `chainId`: no project, no org. */
export function rootContentLabel(chainId: number, rootCid: AbxfsCid): string {
  checkChainId(chainId);
  const hex = asAbxfsCid(rootCid).slice(2);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return `${chainId}-${base32Encode(bytes)}`;
}

/** Parse one DNS label. `null` for anything that is not the canonical spelling of a project or root. */
export function parseContentLabel(label: string): ParsedContentLabel | null {
  if (label.length > MAX_LABEL) return null;
  const m = PROJECT_LABEL.exec(label);
  if (m) {
    const chainId = Number(m[1]);
    if (!Number.isSafeInteger(chainId)) return null;
    return {
      kind: "project",
      chainId,
      org: `0x${m[2]}` as Address,
      tokenId: BigInt(m[3]!),
      ...(m[4] !== undefined ? { version: Number(m[4]) } : {}),
    };
  }
  const r = ROOT_LABEL.exec(label);
  if (r) {
    const chainId = Number(r[1]);
    if (!Number.isSafeInteger(chainId)) return null;
    const bytes = base32Decode(r[2]!);
    if (!bytes || bytes.length !== 32) return null;
    const hex = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    try {
      return { kind: "root", chainId, rootCid: asAbxfsCid(hex as `0x${string}`) };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a request `Host` into a project or root, given the content domain it is served under.
 *
 * `baseHost` is the content domain with its port when it has one (`abxfs-content.example`,
 * `localhost:3001`). The host must be EXACTLY one label under it: `a.b.<base>`, `<base>` itself or another
 * domain return `null`. Hostnames are case-insensitive on the wire, so the host is lowercased first: an
 * uppercase spelling parses as the same project, and only the canonical label (in lowercase) is ever built.
 */
export function parseContentHost(host: string | null | undefined, baseHost: string): ParsedContentLabel | null {
  if (!host) return null;
  const h = host.toLowerCase();
  const base = baseHost.toLowerCase();
  const suffix = `.${base}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, h.length - suffix.length);
  if (label.length === 0 || label.includes(".")) return null;
  return parseContentLabel(label);
}

/** A DNS name (labels of letters, digits, hyphens; no trailing dot) with an optional port. Nothing else may follow `<label>.`. */
export function isValidBaseHost(baseHost: string): boolean {
  if (typeof baseHost !== "string" || baseHost.length === 0 || baseHost.length > 253 + 6) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/i.test(baseHost);
}

/** `https://<label>.<base>` (no trailing slash). `scheme` defaults to https; `http` is for local dev only. */
export function contentOrigin(
  target: ContentProject | { chainId: number; rootCid: AbxfsCid },
  baseHost: string,
  scheme: "https" | "http" = "https",
): string {
  if (scheme !== "https" && scheme !== "http") throw new Error(`content scheme must be https or http, got ${String(scheme)}`);
  if (!isValidBaseHost(baseHost)) throw new Error(`not a valid content host: ${JSON.stringify(baseHost)}`);
  const label = "rootCid" in target ? rootContentLabel(target.chainId, target.rootCid) : contentLabel(target);
  return `${scheme}://${label}.${baseHost}`;
}
