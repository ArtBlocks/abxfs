/** Audit round 2: SDK-side hardening that has no better home. */
import { describe, expect, it } from "vitest";
import { bytesToHex, type Hex } from "viem";

import {
  assertSafeRecipient,
  displayPath,
  isSecretLikeName,
  isSecretLikePath,
  readMyOrgsDetailed,
  readProject,
  setViewUrl,
  sniffSecretContent,
  mintInOrg,
} from "../src/index.js";

const enc = new TextEncoder();

describe("secret names (shared by the CLI and the web)", () => {
  it.each([
    "production.env", "app.env", ".env", ".env.local", ".envrc", "x.env.bak", "id_ecdsa", "id_dsa", "id_rsa", "id_ed25519.pub", "my_id_rsa",
    "server.p12", "cert.pfx", "release.jks", "vault.kdbx", "my.keystore", "server.pem", "tls.key", "wallet.json", "keystore.json",
    "keystore-2024.json", "UTC--2024-01-01--abc", "terraform.tfstate", "terraform.tfvars", "secrets.json", "secrets.yaml", "credentials",
    "credentials.json", ".pgpass", ".dockercfg", ".git-credentials", ".npmrc", ".netrc", ".aws", ".ssh", ".git", "mnemonic.txt", "private-key.txt",
  ])("%s is secret-like", (n) => expect(isSecretLikeName(n)).toBe(true));
  it.each(["environment.ts", "index.html", "keys.md", "env.d.ts", "secret-santa.html", "walletconnect.json", "README.md"])("%s is not", (n) =>
    expect(isSecretLikeName(n)).toBe(false),
  );
  it("any segment of a path counts, with either separator", () => {
    expect(isSecretLikePath("a/b/.ssh/known_hosts")).toBe(true);
    expect(isSecretLikePath("a\\prod.env")).toBe(true);
    expect(isSecretLikePath("a/b/c.txt")).toBe(false);
  });
});

describe("content sniff", () => {
  const hit = (s: string) => sniffSecretContent(enc.encode(s));
  it("flags private keys, AWS ids, labelled hex keys and service tokens", () => {
    expect(hit("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA")).toMatch(/private key/);
    expect(hit("-----BEGIN RSA PRIVATE KEY-----")).toMatch(/private key/);
    expect(hit("aws AKIAJ3XQ5KZ2LMN4P7RT")).toMatch(/AWS/);
    expect(hit("aws AKIAIOSFODNN7EXAMPLE")).toBeNull(); // AWS's documented example id is not a credential
    expect(hit("PRIVATE_KEY=0x" + "ab".repeat(32))).toMatch(/hex/);
    expect(hit(`"secret": "${"cd".repeat(32)}"`)).toMatch(/hex/);
    expect(hit("token xoxb-1234567890-abcdef")).toMatch(/Slack/);
    expect(hit("ghp_" + "a".repeat(30))).toMatch(/GitHub/);
    expect(hit("sk-" + "a1B2".repeat(8))).toMatch(/sk-/);
  });
  it("does not flag a bare 64-hex hash (a CID or a sha256), ordinary prose or binary data", () => {
    expect(hit("sha256: " + "ab".repeat(32))).toBeNull();
    expect(hit("0x" + "ab".repeat(32))).toBeNull();
    expect(hit("<h1>hello</h1>")).toBeNull();
    // Real binary (mostly NUL / not UTF-8) is skipped; ONE stray NUL no longer switches the scan off (audit 4).
    expect(sniffSecretContent(new Uint8Array(512))).toBeNull();
    expect(sniffSecretContent(Uint8Array.from([0, ...enc.encode("-----BEGIN PRIVATE KEY-----")]))).not.toBeNull();
  });
  it("reads a whole file up to 8 MiB, and the head and tail of a bigger one", () => {
    expect(hit("a".repeat(5000) + "-----BEGIN PRIVATE KEY-----")).not.toBeNull();
    expect(hit("a".repeat(9000) + "-----BEGIN PRIVATE KEY-----" + "a".repeat(9000))).not.toBeNull(); // audit 4: no dead middle
    expect(hit("a".repeat(100_000) + "-----BEGIN PRIVATE KEY-----" + "a".repeat(100_000))).not.toBeNull(); // the middle of a 200 KB file is scanned too (audit 5)
  });
});

describe("displayPath", () => {
  it("strips bidi, zero-width and control characters but keeps non-ASCII letters", () => {
    expect(displayPath("invoice‮fdp.exe​")).toBe("invoicefdp.exe");
    expect(displayPath("日本語/ファイル.txt")).toBe("日本語/ファイル.txt");
    expect(displayPath("a\u001b[31mred/\u{e0041}b")).toBe("ared/b");
    expect(displayPath(undefined)).toBe("");
  });
});

describe("recipients: ABX FS contracts are refused", () => {
  const A = "0x00000000000000000000000000000000000a11ce";
  it("a forbid list covers factory, minter, hook and enumeration", () => {
    const set = ["0x00000000000000000000000000000000000000f1", "0x00000000000000000000000000000000000000f2", "0x00000000000000000000000000000000000000f3", "0x00000000000000000000000000000000000000f4"];
    for (const f of set) expect(() => assertSafeRecipient(f, { forbid: set })).toThrow(/lock/);
    expect(assertSafeRecipient(A, { forbid: set }).toLowerCase()).toBe(A);
  });
  it("mintInOrg refuses a configured ABX FS address before reading anything", async () => {
    const factory = "0x00000000000000000000000000000000000000f1";
    const hook = "0x00000000000000000000000000000000000000f3";
    const addresses = { orgFactory: factory, projectHook: hook } as never;
    const client = { async readContract() { throw new Error("must not be reached"); } };
    const wallet = { account: { address: A }, async writeContract() { throw new Error("must not be reached"); } };
    await expect(
      mintInOrg({ publicClient: client as never, walletClient: wallet as never }, "0x00000000000000000000000000000000000000c1", { to: hook, addresses }),
    ).rejects.toThrow(/mint target/);
  });
});

describe("setViewUrl runs the external URL check as well as the contract's rule", () => {
  const wallet = { account: { address: "0x00000000000000000000000000000000000a11ce" }, async writeContract() { return "0x11" as Hex; } };
  const contracts = { collection: "0x00000000000000000000000000000000000000c1", hook: "0x00000000000000000000000000000000000000b2" } as never;
  it("refuses localhost, private and unusual-IP view URLs that the contract would accept", async () => {
    for (const u of ["https://localhost./", "https://127.0.0.1/", "https://x.internal/", "https://169.254.169.254/latest"]) {
      await expect(setViewUrl(wallet as never, contracts, 1n, u), u).rejects.toThrow(/refusing to set abxfs.view/);
    }
    // An IPv6 literal needs `[` `]`, which the contract itself refuses now (they end a Markdown link), so the rule
    // refuses it before the public-host check is reached.
    for (const u of ["https://[::1]/", "https://[64:ff9b::7f00:1]/"]) {
      await expect(setViewUrl(wallet as never, contracts, 1n, u), u).rejects.toThrow(/a view URL must be https/);
    }
    await expect(setViewUrl(wallet as never, contracts, 1n, "https://example.com/x")).resolves.toBe("0x11");
    await expect(setViewUrl(wallet as never, contracts, 1n, "")).resolves.toBe("0x11");
  });
});

describe("readProject decodes string params with ignoreBOM", () => {
  it("a leading BOM keeps viewUrl unusable (the chain refuses it) instead of being stripped into a usable URL", async () => {
    const withBom = bytesToHex(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode("https://example.com/x")]));
    const plain = bytesToHex(enc.encode("https://example.com/x"));
    const mk = (view: Hex) => ({
      async multicall() {
        const ok = (result: unknown) => ({ status: "success", result });
        return [ok("0x00000000000000000000000000000000000a11ce"), ok(["0x" + "0".repeat(64), false, false]), ok("0x"), ok("0x"), ok(0n), ok(0), ok("0x"), ok(view)];
      },
    });
    const contracts = { collection: "0x00000000000000000000000000000000000000c1", hook: "0x00000000000000000000000000000000000000b2" } as never;
    expect((await readProject(mk(withBom) as never, contracts, 1n)).viewUrl).toBeNull();
    expect((await readProject(mk(plain) as never, contracts, 1n)).viewUrl).toBe("https://example.com/x");
  });
});

describe("readMyOrgsDetailed isolates a failing org read", () => {
  const FACTORY = "0x00000000000000000000000000000000000000f1" as Hex;
  const ME = "0x00000000000000000000000000000000000a11ce" as Hex;
  const ORGS = Array.from({ length: 120 }, (_, i) => ("0x" + (i + 1).toString(16).padStart(40, "0")) as Hex);
  const BAD = ORGS[7]!;
  const mk = (failFor: (org: string) => "throw" | "ok") => {
    let inFlight = 0;
    let peak = 0;
    const client = {
      async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
        if (functionName === "orgsAdministeredSlice") return ORGS.slice(Number(args![1]), Number(args![1]) + Number(args![2]));
        throw new Error("unexpected " + functionName);
      },
      async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: string[] }[] }) {
        const org = contracts[0]!.args![0]!;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        if (failFor(org) === "throw") throw new Error("batch failed");
        const ok = (result: unknown) => ({ status: "success", result });
        return [ok(true), ok(ME), ok("0x0000000000000000000000000000000000000000"), ok(false), ok(BigInt(parseInt(org.slice(-4), 16))), ok("n")];
      },
      peak: () => peak,
    };
    return client;
  };

  it("one org failing drops only that org and reports it; reads run in bounded slices", async () => {
    const c = mk((org) => (org === BAD ? "throw" : "ok"));
    const r = await readMyOrgsDetailed(c as never, { factory: FACTORY, hook: FACTORY }, ME);
    expect(r.failed).toEqual([BAD]);
    expect(r.orgs).toHaveLength(119);
    expect(r.orgs.some((o) => o.org === BAD)).toBe(false);
    expect(c.peak()).toBeLessThanOrEqual(50);
  });
  it("readMyOrgs still returns the survivors, and throws only when every read failed", async () => {
    const { readMyOrgs } = await import("../src/org.js");
    const some = await readMyOrgs(mk((org) => (org === BAD ? "throw" : "ok")) as never, { factory: FACTORY, hook: FACTORY }, ME);
    expect(some).toHaveLength(119);
    await expect(readMyOrgs(mk(() => "throw") as never, { factory: FACTORY, hook: FACTORY }, ME)).rejects.toThrow(/could not read any/);
  });
});
