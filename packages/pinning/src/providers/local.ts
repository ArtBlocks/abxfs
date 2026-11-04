/**
 * Kubo (local or self-hosted IPFS node) pinning provider, over Kubo's HTTP RPC API.
 *
 * `pinCar` posts the CAR to `/api/v0/dag/import` with `pin-roots=true`: Kubo stores the blocks as they are and pins the
 * root recursively, which fails (and is reported here) if any block under the root is missing from the archive.
 *
 * Every request goes through {@link httpClient}: progress-based timeouts instead of a fixed one, capped response
 * bodies, no redirects, and errors that name the host and the network error's code.
 */
import { asIpfsCid, type IpfsCid } from "@abxfs/sdk";

import { assertSecureEndpoint } from "../endpoint.js";
import { errorText, httpClient, multipartBody, type HttpTimeouts } from "../http.js";
import type { PinningProvider } from "../types.js";

export interface LocalPinningProviderOptions {
  /** Base URL of the Kubo RPC API (e.g. "http://127.0.0.1:5001"). A trailing slash is allowed. */
  endpoint: string;
  /** Optional headers (e.g. `Authorization: Basic ...` for a node behind a proxy). */
  headers?: Record<string, string>;
  /** Defaults to `globalThis.fetch`. Override for testing. */
  fetch?: typeof fetch;
  /** Connect, stall and response timeouts (see {@link HttpTimeouts}; defaults 30 s, 60 s, 300 s). */
  timeouts?: HttpTimeouts;
}

export function localPinningProvider(opts: LocalPinningProviderOptions): PinningProvider {
  const baseUrl = opts.endpoint.replace(/\/+$/, "");
  const headers = { ...(opts.headers ?? {}) };
  assertSecureEndpoint(baseUrl, Object.keys(headers).some((k) => /^(authorization|x-api-key|cookie)$/i.test(k)), "local");
  const http = httpClient({ ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) });
  const rpc = (command: string) => new URL(`${baseUrl}/api/v0/${command}`);

  return {
    name: "local",

    async preflight() {
      const res = await http.request({ provider: "kubo", what: "version", url: rpc("version"), method: "POST", headers });
      if (!res.ok) throw new Error(`[abxfs-pinning] kubo at ${new URL(baseUrl).host} is not a usable Kubo RPC API: ${res.status} ${errorText(res)}`);
      let version: unknown;
      try {
        version = (JSON.parse(res.text) as { Version?: unknown }).Version;
      } catch {
        version = undefined;
      }
      if (typeof version !== "string") {
        throw new Error(`[abxfs-pinning] kubo at ${new URL(baseUrl).host} answered /api/v0/version without a Version: is it a Kubo RPC API?`);
      }
    },

    async pinCar({ root, car }) {
      root = asIpfsCid(root);
      const url = rpc("dag/import");
      url.searchParams.set("pin-roots", "true");

      const res = await http.request({
        provider: "kubo",
        what: "dag/import",
        url,
        method: "POST",
        headers,
        body: multipartBody([{ name: "file", blob: car, filename: `${root}.car`, type: "application/vnd.ipld.car" }]),
      });
      if (!res.ok) {
        throw new Error(`[abxfs-pinning] kubo dag/import failed: ${res.status} ${errorText(res)}`);
      }
      const imported = parseImportedRoot(res.text);
      if (!imported) throw new Error(`[abxfs-pinning] kubo dag/import: no Root in the response${res.truncated ? " (it was cut off at 1 MiB)" : ""}`);
      if (imported.pinError) {
        throw new Error(`[abxfs-pinning] kubo dag/import: pinning ${imported.cid} failed: ${imported.pinError.slice(0, 500)}`);
      }
      return { pinnedCid: asIpfsCid(imported.cid) };
    },

    async unpin(cid: IpfsCid): Promise<void> {
      cid = asIpfsCid(cid);
      const url = rpc("pin/rm");
      url.searchParams.set("arg", cid);
      const res = await http.request({ provider: "kubo", what: "pin/rm", url, method: "POST", headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`[abxfs-pinning] kubo unpin failed: ${res.status} ${errorText(res)}`);
      }
    },

    async isPinned(cid: IpfsCid): Promise<boolean> {
      cid = asIpfsCid(cid);
      const url = rpc("pin/ls");
      url.searchParams.set("arg", cid);
      url.searchParams.set("type", "all");
      // Kubo answers an unpinned CID with an error status, not an empty list.
      const res = await http.request({ provider: "kubo", what: "pin/ls", url, method: "POST", headers });
      if (!res.ok) return false;
      // `{"Keys":{"<cid>":…}}`, or one `{"Cid":"<cid>",…}` line per pin when streamed: the CID appears either way.
      return res.text.includes(cid);
    },
  };
}

/**
 * `dag/import` streams one JSON object per line: `{"Root":{"Cid":{"/":"…"},"PinErrorMsg":"…"}}` for each root in the
 * CAR header, and a `{"Stats":…}` line when asked for. The archives built here name one root.
 */
function parseImportedRoot(body: string): { cid: string; pinError: string } | undefined {
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: { Root?: { Cid?: { "/"?: unknown }; PinErrorMsg?: unknown } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const cid = parsed.Root?.Cid?.["/"];
    if (typeof cid === "string") {
      const err = parsed.Root?.PinErrorMsg;
      return { cid, pinError: typeof err === "string" ? err : "" };
    }
  }
  return undefined;
}
