/**
 * Scrubbing secrets out of text the CLI prints.
 *
 * viem error messages embed the full RPC URL (`URL: https://host/v2/<API KEY>`), and a request body.
 * Anything the CLI prints about a failure goes through {@link redact} first: URLs are cut back to
 * scheme and host, and any known secret value (the private key, a pinning token, an `--api-key`) is
 * removed wherever it appears.
 *
 * 32-byte hex values are deliberately NOT blanket-redacted: ABX FS CIDs are exactly that shape and
 * appear in legitimate errors. The configured key is removed by value instead.
 */
import { collapseHex, safe } from "./text.js";

const secrets = new Set<string>();

/** Register a value that must never be printed (an `--api-key` argument, say). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

function knownSecrets(): string[] {
  const out = [...secrets];
  for (const [k, v] of Object.entries(process.env)) {
    // The named ones, plus anything that is named like a credential (ALCHEMY_API_KEY, ...).
    if (!v || v.length < 6) continue;
    if (["ABXFS_PRIVATE_KEY", "PINATA_JWT"].includes(k) || /(?:API_?KEY|_KEY|TOKEN|JWT|SECRET|PASSWORD)$/i.test(k)) out.push(v);
  }
  return out;
}

/** Reduce one URL to `scheme://host[:port]`, dropping userinfo, path, query and fragment. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = u.pathname !== "/" || u.search || u.hash ? "/<redacted>" : "";
    return `${u.protocol}//${u.host}${rest}`;
  } catch {
    return "<url redacted>";
  }
}

export function redact(text: string): string {
  // Any scheme://..., then a schemeless `host.tld/path` (an RPC key is usually the path).
  //
  // A match may only START where the character before it could not have continued a scheme. With `\b` instead,
  // every letter of a run like `a.a.a.a…` (no `://` anywhere) was a new start that scanned to the end of the run:
  // quadratic, 100 KB of such text took seconds and 5 MB would never finish. The run before `://` may begin with
  // anything a scheme may hold, not only a letter: `-https://…` and `...https://…` must be redacted too (a match that
  // had to start with a letter, after a non-scheme character, found no start in them and printed the key). The
  // characters before the first letter are kept as they were, and the URL from that letter on is redacted.
  let out = text.replace(/(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/[^\s'"<>)\]]+/gi, (m) => {
    const lead = /^[0-9+.-]*/.exec(m)![0];
    return lead + redactUrl(m.slice(lead.length));
  });
  out = out.replace(
    /(?<![\w@/.:-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s'"<>)\]]+/gi,
    (m) => m.replace(/\/.*$/, "/<redacted>"),
  );
  for (const secret of knownSecrets()) {
    if (/^(0x)?[0-9a-f]+$/i.test(secret)) {
      // a key prints in either case, with or without 0x
      out = out.replace(new RegExp(`(?:0x)?${secret.replace(/^0x/i, "")}`, "gi"), "<redacted>");
    } else {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}

/**
 * A refusal the CLI itself decided (a fee above the ceiling, a transaction signed for another chain, an RPC on
 * the wrong chain). Thrown from inside the transport, it reaches the command wrapped in viem's own errors, whose
 * text buries it; {@link formatCliError} prints the refusal's own message instead.
 */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliRefusal";
  }
}

/** `https://<explorer host>[/path]/tx/0x<64 hex>`: the only URL shape printed unredacted. */
const EXPLORER_TX_URL = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/tx\/0x[0-9a-fA-F]{64}$/;

/** `url` when it is a block-explorer transaction link of the strict shape above, else undefined. */
export function safeExplorerUrl(url: unknown): string | undefined {
  return typeof url === "string" && EXPLORER_TX_URL.test(url) ? url : undefined;
}

function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 16 && cur !== undefined && cur !== null && !out.includes(cur); i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * What the CLI prints for an error that ends a command: the message, scrubbed ({@link redact}), with terminal
 * control stripped and long hex collapsed; then, on lines of their own, a timed-out transaction's block-explorer
 * link. That link comes from viem's built-in chain list (never from the RPC or a config file) and is checked
 * against a strict shape, so it is printed whole: run through `redact` it would lose the very path that makes it
 * useful.
 *
 * Last, the command a pending mint's recovery says to run (`recoveryCommand`, `recover.ts`), on a line of its own
 * through `safe()` only. The CLI built it from what the user typed (a path, globs, a name), not from an RPC, and
 * `redact` would cut a path or a glob shaped like `host.tld/…` (`mysite.com/build`) to `<redacted>`.
 */
export function formatCliError(err: unknown): string[] {
  const chain = causes(err);
  const refusal = chain.find((e): e is CliRefusal => e instanceof CliRefusal || (e as Error | null)?.name === "CliRefusal");
  const message = refusal ? refusal.message : err instanceof Error ? err.message : String(err);
  const lines = [safe(collapseHex(redact(message)))];
  for (const e of chain) {
    const t = e as { name?: unknown; explorerUrl?: unknown; hash?: unknown };
    if (t?.name !== "TransactionTimeoutError") continue;
    if (typeof t.explorerUrl === "string" && EXPLORER_TX_URL.test(t.explorerUrl)) lines.push(`  explorer: ${t.explorerUrl}`);
    break;
  }
  const command = (chain.find((e) => typeof (e as { recoveryCommand?: unknown } | null)?.recoveryCommand === "string") as
    | { recoveryCommand: string }
    | undefined)?.recoveryCommand;
  if (command) lines.push(`  ${safe(command)}`);
  return lines;
}
