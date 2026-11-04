/**
 * Exact parsing of numeric command-line values. Every refusal names the flag (or argument) it is about.
 *
 * `BigInt("")` is 0, `BigInt("0x10")` is 16, `Number.parseInt("2abc")` is 2 and `Number("")` is 0: each of those
 * once turned a typo into a different project, version or gas budget. Only plain decimal digits are accepted.
 */
import { safe } from "./text.js";

const show = (v: unknown) => JSON.stringify(safe(String(v)));

/** A token (project) id: a non-negative decimal integer, as a bigint. Token ids start at 0. */
export function parseTokenId(what: string, value: string): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw new Error(`${what} must be a project id: a whole number, 0 or more, in decimal digits (got ${show(value)})`);
  }
  const id = BigInt(value);
  if (id >= 2n ** 256n) throw new Error(`${what} is too large to be a project id (got ${show(value)})`);
  return id;
}

/** A positive integer (1 or more, no sign, no separators, no exponent) that fits a JS number exactly. */
export function parsePositiveInt(what: string, value: string): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${what} must be a positive whole number in decimal digits, such as 12000000 (got ${show(value)})`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is too large (got ${show(value)})`);
  return n;
}
