import { redact } from "./redact.js";
export type Report = (state: Record<string, unknown>) => void;
/** One stdout result for agents; ordinary progress remains available on stderr. */
export async function jsonAction(enabled: boolean | undefined, action: (report: Report) => Promise<void>): Promise<void> {
  if (!enabled) return action(() => {});
  const log = console.log;
  const state: Record<string, unknown> = { ok: true, outcome: "completed", published: false, phases: [] };
  console.log = (...args: unknown[]) => console.error(...args);
  try { await action(patch => Object.assign(state, patch)); }
  catch (error) {
    const e = error as { published?: boolean; publishTxHash?: string; versionNumber?: bigint; receiptVersion?: bigint; tagTxHash?: string; nameTxHash?: string; txHashes?: readonly string[]; message?: string; recoveryCommand?: string; phase?: string; root?: string; org?: string; tokenId?: bigint; chainId?: number };
    if (e.published) Object.assign(state, { published: true, root: e.root, org: e.org, tokenId: e.tokenId,
      publishTxHash: e.publishTxHash, versionNumber: e.versionNumber, receiptVersion: e.receiptVersion,
      tagTxHash: e.tagTxHash, nameTxHash: e.nameTxHash, txHashes: e.txHashes, phase: e.phase });
    const phase = e.phase ?? state.phase;
    const outcome = !state.published ? "failed" : phase === "readback-version" ? "published_readback_pending"
      : phase === "setting-tag" ? "published_tag_pending"
        : phase === "setting-name" || phase === "set-name" ? "published_name_pending"
        : ["set-target", "set-method", "inspect-result"].includes(String(phase)) ? "published_presentation_pending" : "published_followup_pending";
    Object.assign(state, { ok: false, outcome, error: redact(e.message ?? String(error)),
      ...(state.published ? { retryPublish: false } : {}),
      ...(e.recoveryCommand ? { recovery: [e.recoveryCommand] } : {}) });
    process.exitCode = 1;
  } finally { console.log = log; }
  log(JSON.stringify(state, (key, value: unknown) => typeof value === "bigint" ? value.toString()
    : typeof value === "string" && ["reason", "message", "targetError"].includes(key) ? redact(value) : value));
}
