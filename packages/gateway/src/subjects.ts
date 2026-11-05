/**
 * Subjects — the things a filter can deny.
 *
 * Three forms, all derivable from a URL without touching the chain. That constraint is what lets
 * enforcement live in middleware, ahead of the CDN cache, rather than inside the gateway route.
 * (A project's ROOT is the exception: it is only known after resolving, so project-host responses are
 * never `immutable` at the edge and the handler checks the root a second time. See `handler.ts`.)
 *
 *   project:<chainId>:<org>:<tokenId>   an ABX token in an org, and everything it ever publishes
 *   org:<chainId>:<org>                  an org's namespace: every project URL under it
 *   root:<0x…32 bytes>                   one specific root CID, whoever points at it
 *
 * Token ids repeat across orgs, so a project is only named by all three of chain, org and id.
 * Addresses are lowercased wherever a subject is built, because an uppercase or checksummed address
 * in a URL would otherwise be a different string for the same org — a silent bypass.
 *
 * Subjects are always built from a STRICT parse (`addressing.ts`, or `parseContentHost` in the SDK),
 * never from a second, looser one. A URL either parses canonically or it names nothing and is refused.
 *
 * An org subject blocks the namespace and nothing else. It does NOT cascade to roots: the set of
 * roots an org's projects ever published is unbounded, a root is shared content that another
 * project may also publish, and a root URL carries no org at all. Blocking the content is
 * done per project or per root. Names are never subjects — the address is the identity, and a name
 * is self-declared and copyable.
 */
import {
  parseChainId,
  parsePathSegments,
  parseOrg,
  parseTokenId,
  type Addressing,
} from "./addressing.js";
import { GatewayError } from "./errors.js";

export * from "./addressing.js";
export { GatewayError } from "./errors.js";

/** `project:8453:0xabc…:2` */
export function projectSubject(
  chainId: number | bigint,
  org: string,
  tokenId: number | bigint,
): string {
  return `project:${chainId}:${org.toLowerCase()}:${tokenId}`;
}

/** `org:8453:0xabc…` */
export function orgSubject(chainId: number | bigint, org: string): string {
  return `org:${chainId}:${org.toLowerCase()}`;
}

/** `root:0xabc…` — always lowercase, so string equality is enough to compare. */
export function rootSubject(rootCid: string): string {
  return `root:${rootCid.toLowerCase()}`;
}

const ROOT_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS = "0x[0-9a-f]{40}";
const PROJECT_RE = new RegExp(`^([1-9][0-9]{0,9}):(${ADDRESS}):(0|[1-9][0-9]{0,77})$`);
const ORG_RE = new RegExp(`^([1-9][0-9]{0,9}):(${ADDRESS})$`);

/** Validate a subject string arriving from an untrusted source. */
export function isValidSubject(subject: string): boolean {
  if (subject.startsWith("root:")) return ROOT_RE.test(subject.slice(5).toLowerCase());
  if (subject.startsWith("project:")) return PROJECT_RE.test(subject.slice(8).toLowerCase());
  if (subject.startsWith("org:")) return ORG_RE.test(subject.slice(4).toLowerCase());
  return false;
}

/** Normalize an untrusted subject, or null if it is not one. Rejects rather than coerces. */
export function parseSubject(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return isValidSubject(trimmed) ? trimmed : null;
}

/** A project subject's parts, for building links back into the app. */
export function projectSubjectParts(
  subject: string,
): { chainId: number; org: `0x${string}`; tokenId: number } | null {
  if (!subject.startsWith("project:")) return null;
  const m = PROJECT_RE.exec(subject.slice(8).toLowerCase());
  if (!m) return null;
  const tokenId = Number(m[3]);
  if (!Number.isSafeInteger(tokenId)) return null;
  return { chainId: Number(m[1]), org: m[2] as `0x${string}`, tokenId };
}

/** An org subject's parts. */
export function orgSubjectParts(subject: string): { chainId: number; org: `0x${string}` } | null {
  if (!subject.startsWith("org:")) return null;
  const m = ORG_RE.exec(subject.slice(4).toLowerCase());
  return m ? { chainId: Number(m[1]), org: m[2] as `0x${string}` } : null;
}

/** The subjects a parsed addressing implicates: a project and its org, or a root. */
export function subjectsForAddressing(chainId: number, addressing: Addressing): string[] {
  if (addressing.kind === "cid") return [rootSubject(addressing.rootCid)];
  return [projectSubject(chainId, addressing.org, addressing.tokenId), orgSubject(chainId, addressing.org)];
}

export type PathClassification =
  /** Not a tree this module governs. */
  | { kind: "none" }
  /** A governed tree, but the path is not in its one canonical spelling. Refuse it. */
  | { kind: "invalid" }
  | { kind: "subjects"; subjects: string[] };

/**
 * Every subject a SITE path implicates, or a verdict that it is not canonical.
 *
 * For a site that mounts the gateway's path layout at `/g/…` and its own project and org pages at
 * `/projects/<chain>/<org>/<id>/…` and `/orgs/<chain>/<org>/…`. One URL can touch two subjects: a project request is
 * a request for the project and for its namespace, refused if EITHER is, the project first.
 *
 * Strict by construction: `/projects/084532/…`, `/g/p/+84532/…` and `/orgs/8453/<short address>` do not
 * parse, so they are `invalid` and the site should answer 404 rather than serve a page that some other
 * parser would read differently. Matching is by prefix on purpose: `/projects/8453/<org>/2/files/a.html`
 * is still that project.
 */
export function classifyPath(pathname: string): PathClassification {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const seg = collapsed.split("/").filter(Boolean);
  const head = seg[0];
  if (head !== "g" && head !== "projects" && head !== "orgs") return { kind: "none" };
  // `//` inside a governed tree is a second spelling of the same path.
  if (collapsed !== pathname) return { kind: "invalid" };

  try {
    if (head === "g") {
      const route = parsePathSegments(seg.slice(1));
      if (route.kind === "cid") return { kind: "subjects", subjects: [rootSubject(route.rootCid)] };
      return {
        kind: "subjects",
        subjects: [projectSubject(route.chainId, route.org, route.tokenId), orgSubject(route.chainId, route.org)],
      };
    }

    if (head === "projects") {
      if (seg[1] === undefined || seg[1] === "new") return { kind: "none" };
      const chainId = parseChainId(seg[1]);
      if (seg[2] === undefined) return { kind: "none" };
      const org = parseOrg(seg[2]);
      if (seg[3] === undefined) return { kind: "subjects", subjects: [orgSubject(chainId, org)] };
      const tokenId = parseTokenId(seg[3], true);
      return { kind: "subjects", subjects: [projectSubject(chainId, org, tokenId), orgSubject(chainId, org)] };
    }

    // orgs
    if (seg[1] === undefined) return { kind: "none" };
    const chainId = parseChainId(seg[1]);
    if (seg[2] === undefined) return { kind: "none" };
    return { kind: "subjects", subjects: [orgSubject(chainId, parseOrg(seg[2]))] };
  } catch (err) {
    if (err instanceof GatewayError) return { kind: "invalid" };
    throw err;
  }
}

/** The subjects of an app path; empty when it names none OR is not canonical. Enforcement uses `classifyPath`. */
export function subjectsForPath(pathname: string): string[] {
  const c = classifyPath(pathname);
  return c.kind === "subjects" ? c.subjects : [];
}
