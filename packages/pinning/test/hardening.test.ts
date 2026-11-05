import { describe, expect, it } from "vitest";
import type { IpfsCid } from "@artblocks/abxfs-sdk";

import * as pinning from "../src/index.js";
import { localPinningProvider, pinataPinningProvider } from "../src/index.js";

describe("audit round 2: pinning hardening", () => {
  it("the unused fetchFromGateway (an unbounded, unguarded fetch) is gone", () => {
    expect("fetchFromGateway" in pinning).toBe(false);
  });

  it("a provider with a token refuses plain http, except to localhost", () => {
    expect(() => pinataPinningProvider({ apiKey: "jwt", endpoint: "http://api.pinata.cloud" })).toThrow(/refusing to send credentials/);
    expect(() => pinataPinningProvider({ apiKey: "jwt", uploadEndpoint: "http://uploads.pinata.cloud" })).toThrow(/https/);
    expect(() => localPinningProvider({ endpoint: "http://kubo.internal:5001", headers: { Authorization: "Basic abc" } })).toThrow(/https/);
    expect(() => pinataPinningProvider({ apiKey: "jwt", endpoint: "ftp://x" })).toThrow();
    expect(() => pinataPinningProvider({ apiKey: "jwt", endpoint: "not a url" })).toThrow(/not a valid URL/);
  });

  it("https and loopback http are accepted", () => {
    expect(() => pinataPinningProvider({ apiKey: "jwt" })).not.toThrow();
    expect(() => pinataPinningProvider({ apiKey: "jwt", endpoint: "http://localhost:8080" })).not.toThrow();
    expect(() => localPinningProvider({ endpoint: "http://127.0.0.1:5001", headers: { Authorization: "Basic abc" } })).not.toThrow();
    expect(() => localPinningProvider({ endpoint: "http://[::1]:5001" })).not.toThrow();
    // no credential, so nothing to leak: a plain-http Kubo on a LAN is the user's own business
    expect(() => localPinningProvider({ endpoint: "http://kubo.lan:5001" })).not.toThrow();
  });

  it("unpin and isPinned validate the CID before it reaches a URL", async () => {
    let called = false;
    const fetchStub = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const providers = [
      pinataPinningProvider({ apiKey: "jwt", fetch: fetchStub }),
      localPinningProvider({ endpoint: "http://localhost:5001", fetch: fetchStub }),
    ];
    for (const p of providers) {
      for (const bad of ["../../admin", "bafy/../x", "bafy?x=1", "", "Qm123", "bafkrei#frag"]) {
        await expect(p.unpin(bad as IpfsCid), `${p.name} ${bad}`).rejects.toThrow(/not a valid IPFS CID/);
        await expect(p.isPinned(bad as IpfsCid), `${p.name} ${bad}`).rejects.toThrow(/not a valid IPFS CID/);
      }
    }
    expect(called).toBe(false);
  });
});
