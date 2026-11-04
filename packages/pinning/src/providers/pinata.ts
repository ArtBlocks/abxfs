/**
 * Pinata pinning provider, over Pinata's v3 Files API.
 *
 * `pinCar` uploads the CAR to `POST /v3/files` with `car=true` on the public network: Pinata stores the archive's
 * blocks as they are and reports the archive's root as the file's `cid`. Unpinning deletes every public file Pinata
 * holds under that CID.
 *
 * Auth is `Authorization: Bearer <jwt>` with a v3 key allowed to write, read and delete files.
 *
 * Every request goes through {@link httpClient}: progress-based timeouts instead of a fixed one, capped response
 * bodies, no redirects (the key must never follow one to another origin), and errors that name the host and code.
 */
import { asIpfsCid, type IpfsCid } from "@abxfs/sdk";

import { assertSecureEndpoint } from "../endpoint.js";
import { errorText, httpClient, jsonOf, multipartBody, type HttpTimeouts } from "../http.js";
import type { PinningProvider } from "../types.js";

export interface PinataPinningProviderOptions {
  /** Pinata JWT issued from https://app.pinata.cloud/developers/api-keys. */
  apiKey: string;
  /** The files API. Defaults to "https://api.pinata.cloud". */
  endpoint?: string;
  /** The upload API. Defaults to `endpoint` when that is set (a proxy in front of both), else "https://uploads.pinata.cloud". */
  uploadEndpoint?: string;
  /** Defaults to `globalThis.fetch`. Override for testing. */
  fetch?: typeof fetch;
  /** Connect, stall and response timeouts (see {@link HttpTimeouts}; defaults 30 s, 60 s, 300 s). */
  timeouts?: HttpTimeouts;
}

const DEFAULT_ENDPOINT = "https://api.pinata.cloud";
const DEFAULT_UPLOAD_ENDPOINT = "https://uploads.pinata.cloud";
/** Pages of the CID filter read when unpinning; one CID is rarely uploaded more than a few times. */
export const MAX_LIST_PAGES = 10;
const PAGE_SIZE = 100;

export function pinataPinningProvider(opts: PinataPinningProviderOptions): PinningProvider {
  const baseUrl = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const uploadUrl = (opts.uploadEndpoint ?? opts.endpoint ?? DEFAULT_UPLOAD_ENDPOINT).replace(/\/+$/, "");
  assertSecureEndpoint(baseUrl, true, "pinata");
  assertSecureEndpoint(uploadUrl, true, "pinata");
  const headers = { Authorization: `Bearer ${opts.apiKey}` };
  const http = httpClient({ ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) });

  type Listing = { files: Array<{ id: string; cid: string }>; complete: boolean };

  /**
   * Public files Pinata holds under `cid`: every page up to {@link MAX_LIST_PAGES}, or until `stopAt` are found.
   * `complete` is false when pages remained unread.
   */
  async function filesWithCid(cid: IpfsCid, stopAt = Number.POSITIVE_INFINITY): Promise<Listing> {
    const out: Array<{ id: string; cid: string }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const url = new URL(`${baseUrl}/v3/files/public`);
      url.searchParams.set("cid", cid);
      url.searchParams.set("limit", String(Number.isFinite(stopAt) ? Math.min(stopAt, PAGE_SIZE) : PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await http.request({ provider: "pinata", what: "list", url, method: "GET", headers });
      if (!res.ok) throw new Error(`[abxfs-pinning] pinata list failed: ${res.status} ${errorText(res)}`);
      const body = jsonOf<{ data?: { files?: Array<{ id?: unknown; cid?: unknown }>; next_page_token?: unknown } }>(
        res,
        "[abxfs-pinning] pinata list",
      );
      for (const f of body.data?.files ?? []) {
        // The filter is Pinata's; the match is checked here too.
        if (typeof f.id === "string" && f.cid === cid) out.push({ id: f.id, cid });
      }
      const next = body.data?.next_page_token;
      if (typeof next !== "string" || next === "") return { files: out, complete: true };
      if (out.length >= stopAt) return { files: out, complete: false };
      pageToken = next;
    }
    return { files: out, complete: false };
  }

  return {
    name: "pinata",

    async preflight() {
      // The cheapest call the key's required scopes (read, write, delete files) allow: list one file.
      const url = new URL(`${baseUrl}/v3/files/public`);
      url.searchParams.set("limit", "1");
      const res = await http.request({ provider: "pinata", what: "key check", url, method: "GET", headers });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`[abxfs-pinning] pinata at ${new URL(baseUrl).host} rejected the API key (${res.status}): check PINATA_JWT and its scopes`);
      }
      if (!res.ok) throw new Error(`[abxfs-pinning] pinata key check failed: ${res.status} ${errorText(res)}`);
    },

    async pinCar({ car, name }) {
      const res = await http.request({
        provider: "pinata",
        what: "upload",
        url: `${uploadUrl}/v3/files`,
        method: "POST",
        headers,
        body: multipartBody([
          { name: "network", value: "public" },
          { name: "car", value: "true" },
          { name: "name", value: name },
          { name: "file", blob: car, filename: `${name}.car`, type: "application/vnd.ipld.car" },
        ]),
      });
      if (!res.ok) {
        throw new Error(`[abxfs-pinning] pinata upload failed: ${res.status} ${errorText(res)}`);
      }
      const body = jsonOf<{ data?: { cid?: unknown } }>(res, "[abxfs-pinning] pinata upload");
      const cid = body.data?.cid;
      if (typeof cid !== "string") throw new Error("[abxfs-pinning] pinata upload: no data.cid in the response");
      return { pinnedCid: asIpfsCid(cid) };
    },

    async unpin(cid: IpfsCid): Promise<void> {
      cid = asIpfsCid(cid);
      const { files, complete } = await filesWithCid(cid);
      for (const f of files) {
        // The id goes into a URL path: only Pinata's id alphabet may.
        if (!/^[0-9A-Za-z-]+$/.test(f.id)) throw new Error(`[abxfs-pinning] pinata returned an unexpected file id`);
        const res = await http.request({ provider: "pinata", what: "delete", url: `${baseUrl}/v3/files/public/${f.id}`, method: "DELETE", headers });
        if (!res.ok && res.status !== 404) {
          throw new Error(`[abxfs-pinning] pinata unpin failed: ${res.status} ${errorText(res)}`);
        }
      }
      if (!complete) {
        throw new Error(
          `[abxfs-pinning] pinata unpin: deleted ${files.length} file(s) under ${cid}, but more remain past ${MAX_LIST_PAGES} pages; run it again`,
        );
      }
    },

    async isPinned(cid: IpfsCid): Promise<boolean> {
      cid = asIpfsCid(cid);
      try {
        return (await filesWithCid(cid, 1)).files.length > 0;
      } catch {
        return false;
      }
    },
  };
}
