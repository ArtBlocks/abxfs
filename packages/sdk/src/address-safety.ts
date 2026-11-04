/**
 * Recipient checks for irreversible writes: a project transfer, an admin offer, a mint-to.
 *
 * Strict `isAddress` means a mixed-case value must carry a valid EIP-55 checksum (a typo in a
 * checksummed address is caught), then the obvious dead ends are refused: the zero address, the
 * conventional burn addresses, and any address the caller says would be self-referential (the org
 * itself, its collection, the hook, the factory).
 */
import { getAddress, isAddress, type Address } from "viem";

const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** Why `value` is not an acceptable recipient, or `null` if it is. */
export function recipientProblem(
  value: string,
  opts: { forbid?: readonly (string | undefined)[] } = {},
): string | null {
  const v = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return "not a 0x address of 40 hex characters";
  // strict: viem rejects a mixed-case string whose checksum is wrong. All-lowercase and all-uppercase pass.
  if (!isAddress(v, { strict: true })) return "the mixed-case checksum is wrong (a character is mistyped)";
  const lower = v.toLowerCase();
  if (/^0x0{40}$/.test(lower)) return "the zero address (anything sent there is lost)";
  if (lower === DEAD.toLowerCase()) return "a burn address";
  // Precompiles 0x01..0x0a accept a transfer and keep it; 0xff..ff is the all-ones sentinel nobody holds.
  if (BigInt(lower) >= 1n && BigInt(lower) <= 0x0an) return "a precompile address (anything sent there is lost)";
  if (/^0xf{40}$/.test(lower)) return "the all-ones address (nobody holds it)";
  if (/^0x0{36}dead$/.test(lower) || /^0xdead0{36}$/.test(lower)) return "a burn address";
  for (const f of opts.forbid ?? []) {
    if (f && f.toLowerCase() === lower) return "an address that would lock it (the org, its collection or an ABX FS contract)";
  }
  return null;
}

/** Throws a readable error unless `value` is an acceptable recipient. Returns the checksummed address. */
export function assertSafeRecipient(
  value: string,
  opts: { forbid?: readonly (string | undefined)[]; what?: string } = {},
): Address {
  const problem = recipientProblem(value, opts);
  if (problem) throw new Error(`invalid ${opts.what ?? "address"} "${value}": ${problem}`);
  return getAddress(value.trim());
}
