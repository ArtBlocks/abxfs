import { describe, expect, it } from "vitest";
import { assertCanPublish, readEmptyOwnedProjects } from "../src/project.js";
import { isSecretLikeName } from "../src/secret-names.js";

const A = "0x00000000000000000000000000000000000000aa" as const;
const U = "0x00000000000000000000000000000000000000bb" as const;
const contracts = { collection: A } as never;
const failing = (err: Error) => ({ multicall: async () => { throw err; }, readContract: async () => { throw err; } }) as never;

describe("assertCanPublish: only a real revert reads as 'does not exist'", () => {
  for (const [label, err] of [
    ["-32603 internal error", Object.assign(new Error("RPC Request failed. Internal error"), { name: "InternalRpcError", code: -32603 })],
    ["header not found", Object.assign(new Error("header not found"), { name: "RpcRequestError", code: -32000 })],
    ["missing trie node", Object.assign(new Error("missing trie node"), { name: "RpcRequestError", code: -32000 })],
    ["502", Object.assign(new Error("HTTP request failed. Status: 502"), { name: "HttpRequestError", status: 502 })],
  ] as const) {
    it(`${label} is an outage`, async () => {
      let msg = "";
      try { await assertCanPublish(failing(err), contracts, 1n, U, { expectedHead: null, settleMs: 50 }); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toBe("");
      expect(msg).not.toMatch(/does not exist/);
    });
  }
  it("a sub-call -32603 inside a multicall is an outage", async () => {
    const client = { multicall: async () => [{ status: "failure", error: Object.assign(new Error("Internal error"), { code: -32603 }) }, { status: "success", result: "0x" }] } as never;
    await expect(assertCanPublish(client, contracts, 1n, U, { expectedHead: null, settleMs: 50 })).rejects.toThrow(/could not read project/);
  });
  it("a real revert still reads as missing", async () => {
    const revert = Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
    await expect(assertCanPublish(failing(revert), contracts, 1n, U, { expectedHead: null, settleMs: 50 })).rejects.toThrow(/does not exist/);
  });
});

describe("readEmptyOwnedProjects", () => {
  const ENUM = "0x00000000000000000000000000000000000000ee" as const;
  const mk = (multicall: () => Promise<unknown>) => {
    let calls = 0;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => (functionName === "balanceOfTracked" ? 3n : [1n, 2n, 3n]),
      multicall: async (a: { contracts: unknown[] }) => { calls++; void a; return multicall(); },
    } as never;
    return { client, calls: () => calls };
  };
  const ok = (r: unknown) => ({ status: "success", result: r });
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  it("one multicall for all ids; empty ones are returned newest first", async () => {
    const { client, calls } = mk(async () => [ok(U), ok(ZERO), ok(0n), ok(U), ok(ZERO), ok(0n), ok(U), ok(ZERO), ok(1n)]);
    const out = await readEmptyOwnedProjects(client, { collection: A, hook: A, enumeration: ENUM } as never, U);
    expect(out).toEqual([3n, 2n]);
    expect(calls()).toBe(1);
  });
  it("any failed read is undefined, never 'no empties'", async () => {
    const { client } = mk(async () => [ok(U), ok(ZERO), ok(0n), { status: "failure", error: new Error("x") }, ok(ZERO), ok(0n), ok(U), ok(ZERO), ok(0n)]);
    expect(await readEmptyOwnedProjects(client, { collection: A, hook: A, enumeration: ENUM } as never, U)).toBeUndefined();
    const t = mk(async () => { throw new Error("boom"); });
    expect(await readEmptyOwnedProjects(t.client, { collection: A, hook: A, enumeration: ENUM } as never, U)).toBeUndefined();
  });
});

describe("secret names survive backup decorations", () => {
  for (const n of ["server.key~", "server.pem.orig.bak", "cert.p12.old.1", "x.pem.bak.gz", ".npmrc~", "secrets.json.bak", "credentials.json~", "wallet.json.bak", "keystore.json.old"]) {
    it(n, () => expect(isSecretLikeName(n)).toBe(true));
  }
  for (const n of ["my.key.png", ".env.example", "notes.txt.bak", "index.html~", "data.1"]) {
    it(`${n} is not flagged`, () => expect(isSecretLikeName(n)).toBe(false));
  }
});
