import { createInterface } from "node:readline/promises";

/**
 * Ask for a typed confirmation on a TTY. A non-interactive shell cannot answer, so this throws
 * (naming the flag that opts out) rather than proceeding on a default.
 */
export async function confirmTyped(
  question: string,
  opts: { expected?: string; flag: string },
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(`refusing to continue without a TTY to confirm on — pass ${opts.flag} if intentional`);
  }
  const expected = opts.expected ?? "yes";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (type "${expected}") `);
    return answer.trim().toLowerCase() === expected;
  } finally {
    rl.close();
  }
}
