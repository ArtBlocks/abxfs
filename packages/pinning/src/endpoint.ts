/**
 * A provider that sends a credential must not send it in the clear. Plain `http://` is accepted only
 * for a loopback host (a local Kubo node), where nothing crosses a network.
 */
export function assertSecureEndpoint(endpoint: string, hasCredential: boolean, provider: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error(`[abxfs-pinning] ${provider}: endpoint is not a valid URL`);
  }
  if (u.protocol === "https:") return;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (u.protocol === "http:" && (loopback || !hasCredential)) return;
  throw new Error(
    `[abxfs-pinning] ${provider}: refusing to send credentials to ${u.protocol}//${u.host}; use https:// ` +
      "(plain http is accepted only for localhost)",
  );
}
