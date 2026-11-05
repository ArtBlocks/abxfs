/**
 * Which URLs a client will follow or render as a link when the value came from chain.
 *
 * `abxfs.gateway` and `abxfs.view` are written by a project's owner, and an inherited or bought
 * project's value is written by someone else. A client that fetches or links it must not be pointed
 * at the user's own machine or network, nor at credentials embedded in the URL.
 *
 * This is deliberately a CLIENT check: a server that fetches such a URL must resolve and check it itself
 * (DNS, redirects). A syntactic check cannot defeat DNS rebinding and is not offered as if it could.
 */

/** Generous for a gateway prefix; the on-chain view URL cap is 512. */
export const MAX_EXTERNAL_URL_LENGTH = 512;

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function isNonPublicIPv4(p: number[]): boolean {
  const a = p[0]!;
  const b = p[1]!;
  const c = p[2]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1 (192.0.0.0/24, 192.0.2.0/24)
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal (no brackets) into eight 16-bit groups, or null when it is not one. */
function parseIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  // A trailing dotted quad (::ffff:1.2.3.4) is two groups.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]!);
    if (!v4) return null;
    h = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isNonPublicIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return true; // unparseable inside brackets: never public
  const g0 = g[0]!;
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 6)) return true; // ::/96 IPv4-compatible
  if (allZero(0, 5) && g[5] === 0xffff) return true; // ::ffff:0:0/96 IPv4-mapped
  if (allZero(0, 4) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:0:0/96 SIIT (RFC 2765)
  if (g0 === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64, and 64:ff9b:1::/48 local-use
  if (g0 === 0x2002) return true; // 2002::/16 6to4
  if (g0 === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo
  if (g0 === 0x2001 && g[1] === 0xdb8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x100 && allZero(1, 4)) return true; // 100::/64 discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Names that are never public hosts, matched as the whole name or as a suffix label. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

/** The reason `url` is refused, or `null` if it is acceptable. */
export function externalUrlProblem(url: string, maxLength = MAX_EXTERNAL_URL_LENGTH): string | null {
  if (typeof url !== "string" || url.length === 0) return "empty";
  if (url.length > maxLength) return `longer than ${maxLength} characters`;
  // eslint-disable-next-line no-control-regex
  if (new RegExp("[\\u0000-\\u0020\\u007f-\\u009f\\\\]").test(url)) return "contains whitespace, control characters or a backslash";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "https:") return "must be https://";
  if (u.username !== "" || u.password !== "") return "must not contain credentials";
  // Userinfo as TEXT, too: `https://opensea.io@evil.example/` shows a trusted name and goes elsewhere, and a
  // parser quirk must not be the only thing standing between that and a saved link.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) return "must not contain credentials";
  // `new URL` has already decoded percent-escapes in the host (`localhost%2e` is `localhost.`) and put
  // decimal, octal and hex IPv4 forms into dotted-quad. A trailing dot is a different spelling of the
  // same name, so it is removed before any comparison; so are repeated dots.
  let host = u.hostname.toLowerCase();
  if (host === "") return "has no host";
  if (host.startsWith("[")) {
    if (isNonPublicIPv6(host.slice(1, -1))) return "points at a private or loopback address";
    return null;
  }
  host = host.replace(/\.+$/, "");
  if (host === "" || host.includes("..")) return "has no host";
  const v4 = parseIPv4(host);
  if (v4) return isNonPublicIPv4(v4) ? "points at a private or loopback address" : null;
  // Anything still numeric-looking was not normalised by the URL parser: refuse rather than guess.
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/.test(host)) return "is an unusual IP address form";
  if (host === "localhost") return "points at localhost";
  for (const suffix of LOCAL_SUFFIXES) {
    if (host.endsWith(suffix)) return suffix === ".localhost" ? "points at localhost" : "points at a local network name";
  }
  if (!host.includes(".")) return "is not a public host name";
  return null;
}

/** `true` for an https URL, without credentials, that is not localhost or a private/loopback IP literal. */
export function isSafeExternalUrl(url: string, maxLength = MAX_EXTERNAL_URL_LENGTH): boolean {
  return externalUrlProblem(url, maxLength) === null;
}

/** The host of an https URL as the browser will connect to it (lowercase, no port), or `null`. */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a URL's host contains an internationalised label in its punycode form (`xn--`). Such a host can
 * render as a near copy of a well-known name (`xn--pple-43d.example` is "аpple.example"). The contract
 * accepts them and the frozen token renderer cannot change, so a client that offers to save one asks first.
 */
export function hasLookalikeHost(url: string): boolean {
  const host = urlHost(url);
  return host !== null && host.split(".").some((label) => label.startsWith("xn--"));
}
