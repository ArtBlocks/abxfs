import { describe, expect, it } from "vitest";


describe("strictBatchFetch", () => {
  it("passes a batch answer whose ids match, untouched", async () => {
    const { strictBatchFetch } = await import("../src/upstream.js");
    const inner = async () => new Response(JSON.stringify([{ jsonrpc: "2.0", id: 2, result: "0x1" }, { jsonrpc: "2.0", id: 1, result: "0x0" }]));
    const res = await strictBatchFetch(inner as never)("http://x", { body: JSON.stringify([{ id: 1 }, { id: 2 }]) });
    expect(res.status).toBe(200);
  });
  it("turns a batch answer with the wrong, missing or duplicated ids into a 502", async () => {
    const { strictBatchFetch } = await import("../src/upstream.js");
    for (const answer of [
      [{ jsonrpc: "2.0", id: 999, error: { code: 3, message: "execution reverted" } }],
      [],
      [{ id: 1, result: "0x" }, { id: 1, result: "0x" }],
    ]) {
      const res = await strictBatchFetch((async () => new Response(JSON.stringify(answer))) as never)("http://x", { body: JSON.stringify([{ id: 1 }, { id: 2 }]) });
      expect(res.status).toBe(502);
    }
  });
  it("leaves a non-batch request and a non-array answer alone", async () => {
    const { strictBatchFetch } = await import("../src/upstream.js");
    const single = await strictBatchFetch((async () => new Response("{}")) as never)("http://x", { body: JSON.stringify({ id: 1 }) });
    expect(single.status).toBe(200);
    const html = await strictBatchFetch((async () => new Response("<html>")) as never)("http://x", { body: JSON.stringify([{ id: 1 }]) });
    expect(html.status).toBe(200);
  });
});
