/**
 * The one helper for printing a string that came from chain (or from a local file name).
 *
 * File, project, org and tag names are attacker-controlled bytes; printed raw, an OSC/CSI sequence
 * can clear the screen, rewrite earlier output or set the clipboard. Every `console.log` of such a
 * value goes through `safe()`.
 */
import { stripTerminalControl } from "@artblocks/abxfs-sdk";

export function safe(value: unknown): string {
  return stripTerminalControl(value);
}

/** Every character a shell takes literally outside quotes, in an argument the CLI prints: such an argument is bare. */
const BARE_ARG = /^[A-Za-z0-9_./:=@-]+$/;

/**
 * One argument of a command the CLI prints for the user to paste into a POSIX shell (bash, zsh, ksh): bare when it is
 * only {@link BARE_ARG}, else single-quoted with its EXACT characters, so that the pasted command names the same path,
 * glob or name. A character {@link safe} would change or drop (C0 and C1 control, DEL, bidi and other invisible format
 * characters, the Unicode spaces it turns into a plain one) cannot be printed as itself: printed raw it could drive or
 * reorder the terminal, and through `safe()` the pasted argument named a different path (`my\u202Fsite` became
 * `my site`). Each run of such characters is then ANSI-C quoted (`$'…'`), written as the `\xHH` escapes of its UTF-8
 * bytes, between ordinary single-quoted runs of the rest: `'my'$'\xe2\x80\xaf''site'`. An escape is never followed by
 * a literal character inside the same quotes, because ksh93 reads `\x` greedily (`\xafab` is one character there) and
 * POSIX.1-2024 `sh` leaves more than two digits unspecified. bash, zsh, ksh93 and POSIX.1-2024 `sh` decode it to the
 * same bytes; dash and fish have no `$'…'`. Either way the result holds no character `safe()` would alter, so it is
 * printed through `safe()` unchanged.
 */
export function shellArg(arg: string): string {
  if (BARE_ARG.test(arg)) return arg;
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const chars = Array.from(arg);
  const unprintable = (ch: string) => stripTerminalControl(ch) !== ch;
  if (!chars.some(unprintable)) return quote(arg);
  const hex = (ch: string) => Array.from(new TextEncoder().encode(ch), (b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
  let out = "";
  let run = "";
  let esc = "";
  for (const ch of chars) {
    if (unprintable(ch)) {
      if (run) out += quote(run);
      run = "";
      esc += hex(ch);
    } else {
      if (esc) out += `$'${esc}'`;
      esc = "";
      run += ch;
    }
  }
  return out + (run ? quote(run) : "") + (esc ? `$'${esc}'` : "");
}

/**
 * A transaction hash as the RPC returned it, or a placeholder when it is not one. The hash of a sent
 * transaction is whatever the node answers `eth_sendRawTransaction` with, so it is node-controlled text: it is
 * printed only when it is exactly 32 bytes of hex.
 */
export function txHash(value: unknown): string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : "(malformed transaction hash from the RPC)";
}

/** {@link txHash}, shortened for a progress line (`0x12345678…`). */
export function shortTxHash(value: unknown): string {
  const h = txHash(value);
  return h.startsWith("0x") ? `${h.slice(0, 10)}…` : h;
}

/**
 * An IPFS CID as the chain (the on-chain resolver, decoded from an `eth_call`) or a pinning service returned it, or a
 * placeholder when it is not a CIDv1 in base32. Like a tx hash it is text someone else chose.
 */
export function ipfsCidText(value: unknown): string {
  return typeof value === "string" && /^b[a-z2-7]{8,200}$/.test(value) ? value : "(malformed IPFS CID)";
}

/** Runs of hex longer than this are collapsed in printed errors. A CID or tx hash (66 characters) is kept whole. */
const LONG_HEX = 80;

/**
 * Collapse long runs of hex (calldata, a raw signed transaction) in a message to their two ends and a byte count.
 * A viem error embeds the whole request, so an ordinary "insufficient funds" on one 48 KB bundle printed about
 * 100,000 characters of hex; the useful part is the first line.
 */
export function collapseHex(text: string): string {
  return text.replace(new RegExp(`0x[0-9a-fA-F]{${LONG_HEX},}`, "g"), (m) => {
    const bytes = Math.floor((m.length - 2) / 2);
    return `${m.slice(0, 18)}…(${bytes.toLocaleString("en-US")} bytes)…${m.slice(-8)}`;
  });
}
