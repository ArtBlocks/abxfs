/**
 * DELTA AUDIT informational: `unknown/unknown`, `application/unknown` and `*` `/` `*` are the declared types the MIME
 * Sniffing standard answers by SNIFFING the bytes, so what a browser does with them is not what was declared. They are
 * sandboxed now, like an active type; nothing else changes.
 */
import { describe, expect, it } from "vitest";
import { rootContentLabel } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { isSniffedEssence, servedType } from "../../src/mime.js";
import { __resetResolveCaches, isActiveXmlType } from "../../src/resolve.js";
import { FakeChain } from "../fake-chain.js";

describe("sniffed declared types are sandboxed", () => {
  it("each of the three, in any case and with parameters, keeps its type and gains the sandbox", () => {
    for (const declared of ["unknown/unknown", "application/unknown", "*/*", "Unknown/Unknown", "APPLICATION/UNKNOWN; x=1", " */* "]) {
      const served = servedType(declared);
      expect(served.sandbox, declared).toBe(true);
      expect(served.contentType, declared).toBe(declared.trim());
      expect(isActiveXmlType(declared), declared).toBe(true);
      expect(isSniffedEssence(served.essence), declared).toBe(true);
    }
  });

  it("their neighbours are not", () => {
    for (const declared of ["application/octet-stream", "text/plain", "unknown/x", "application/unknownx", "image/*"]) {
      expect(servedType(declared).sandbox, declared).toBe(false);
    }
  });

  it("the gateway sends `Content-Security-Policy: sandbox` for one", async () => {
    __resetResolveCaches();
    const fc = new FakeChain();
    const cid = fc.addFile([new TextEncoder().encode("<script>alert(1)</script>")], "unknown/unknown").cid;
    const gw = createGateway({ chains: [{ id: 84532, contracts: fc.contracts, client: fc.client } as never], defaultChainId: 84532, hostMode: { baseHost: "content.example" } });
    const label = rootContentLabel(cid);
    const res = await gw(new Request(`https://${label}.content.example/`, { headers: { host: `${label}.content.example` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
