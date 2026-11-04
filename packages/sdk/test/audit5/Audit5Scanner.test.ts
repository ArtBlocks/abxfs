import { describe, expect, it } from "vitest";
import { isSecretLikePath, sniffSecretContent, sniffSecret, sniffSecretSource, isSecretLikeName, normalizeSecretName } from "../../src/secret-names.js";

const gc = (globalThis as { gc?: () => void }).gc;
const enc = (s: string) => new TextEncoder().encode(s);
const time = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const N = 64 * 1024;

describe("Audit5 ReDoS: adversarial 64KB inputs, each must finish quickly", () => {
  const inputs: Record<string, string> = {
    words: rep("abc ", N),
    wordsLabel: "mnemonic: " + rep("abcdefgh ", N),
    wordsNl: "seed phrase " + rep("abc\n", N),
    wordsNum: "mnemonic " + rep("1. abc ", N),
    hexLabelNl: "private" + rep("\n", N),
    hexLabelSpaces: "key" + rep(" ", N),
    hexLabelRepeat: rep("key ", N),
    hexLabelRepeat2: rep("private\n", N),
    hex63: "private " + rep("a", 63) + rep(" key ", N),
    hexDigits: rep("key 0123456789abcdef", N),
    begin: rep("-----BEGIN ", N),
    beginSp: "-----BEGIN" + rep(" A", N),
    beginSp2: "-----BEGIN" + rep(" \n", N),
    jwt: rep("eyJabcd.eyJabcd.", N),
    jwtLong: "eyJ" + rep("a", N),
    jwtDots: rep("eyJaaaa.eyJaaaa.aaaa", N),
    urlpw: rep("://a:", N),
    urlpw2: "://" + rep("a", N),
    urlpw3: rep("://a:b", N),
    urlpw4: rep("x:a@", N) + "://" + rep("u:", N),
    sk: rep("sk-", N),
    sk2: "sk-" + rep("a", N),
    sk3: rep("sk-a1", N),
    sk4: "sk-proj-" + rep("a-", N),
    sg: rep("SG.", N), sg2: "SG." + rep("a", N), sg3: rep("SG.aaaaaaaaaaaaaaaa.", N),
    gh: rep("ghp_", N), akia: rep("AKIA", N), aiza: rep("AIza", N), xox: rep("xoxb-", N), npm: rep("npm_", N),
    dotenv: rep("AAA=bbbbbbbbb\n", N), dotenv2: rep("A", N) + "=", dotenv3: rep(" \t", N) + "export",
    keystore: rep('"crypto" ', N),
    ws: rep(" ", N), nl: rep("\n", N), tabs: rep("\t\n", N),
    jwtLabel: rep("token eyJabcd.eyJabcd.abcd ", N),
  };
  for (const [k, v] of Object.entries(inputs)) {
    it(k, () => {
      const b = enc(v);
      const ms = time(() => sniffSecretContent(b, ".env"));
      const ms2 = time(() => sniffSecretContent(b, "x.txt"));
      console.log(`redos ${k}: ${ms.toFixed(0)}ms / ${ms2.toFixed(0)}ms`);
      expect(Math.max(ms, ms2)).toBeLessThan(2000);
    });
  }
  it("name rules on a 1MB segment", () => {
    for (const s of [rep("a.", 1e6), rep(".env", 1e6), rep("key.", 1e6), rep(" ", 1e6) + "x"]) {
      const ms = time(() => isSecretLikeName(s));
      expect(ms).toBeLessThan(1500);
    }
  });
  it("normalize trailing-space strip is linear", () => {
    expect(time(() => normalizeSecretName("a" + rep(" .", 1e6) + "a"))).toBeLessThan(1500);
  });
});

describe("Audit5 false positives on realistic outputs", () => {
  const rnd = (n: number, a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join("");
  const hexs = (n: number) => rnd(n, "0123456789abcdef");
  const fp = (name: string, text: string, n = 1) => it(`no hit: ${name}`, () => expect(sniffSecretContent(enc(text), "x.js")).toBeNull());
  fp("minified bundle with random base64url", Array.from({ length: 300 }, () => `a="${rnd(48)}-${rnd(20)}_${rnd(10)}";`).join(""));
  fp("sourcemap", JSON.stringify({ version: 3, mappings: rnd(8000, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/,;"), sources: ["a.js"] }));
  fp("three.js seed 0x hash", `const seed = "0x${hexs(64)}"; const hash="0x${hexs(64)}"; tokenData.hash = "0x${hexs(64)}";`);
  fp("tokenData hash on next line", `let tokenData = {\n hash: "0x${hexs(64)}",\n tokenId: "1"\n}`);
  fp("sha256 checksum list", Array.from({ length: 20 }, (_, i) => `${hexs(64)}  file${i}.js`).join("\n"));
  fp("integrity sha512", `integrity="sha512-${rnd(86)}=="`);
  fp("lockfile", Array.from({ length: 50 }, () => `"integrity": "sha512-${rnd(86)}=="`).join("\n"));
  fp("docs example key", "Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
  fp("docs example urls", "postgres://user:password@localhost:5432/db and https://<user>:<pass>@host/ mongodb://username:password@host");
  fp("eth address", "0x" + hexs(40));
  fp("keyboard/ monkey words", "key 0x" + hexs(40) + " monkey " + hexs(64));
  fp("tx hash after 'key' word on same para > 3 lines", "private\n\n\n\n\n" + hexs(64));
  fp("words list lorem", "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore");
  fp("css", Array.from({ length: 500 }, (_, i) => `.task-manager-dashboard-wrapper-${i}{color:#fff}`).join("\n"));
  fp("sk- kebab", "class=\"sk-circle-fade-in-delay-42 sk-" + rnd(40, "abcdef-") + "\"");
  fp("uuid", "id=" + "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx");
  fp("pub key text", "ssh-rsa AAAAB3NzaC1yc2E" + rnd(300) + " user@host");
  it("random binary (font/wasm) never hits", () => {
    for (let i = 0; i < 200; i++) { const b = new Uint8Array(70000); for (let j = 0; j < b.length; j++) b[j] = Math.random() * 256; expect(sniffSecretContent(b, "a.woff2")).toBeNull(); }
  });
  it("wasm-like file with text-ish random payload (latin1 chars)", () => {
    let hits = 0; for (let i = 0; i < 200; i++) { const b = new Uint8Array(70000); for (let j = 0; j < b.length; j++) b[j] = 32 + Math.random() * 95; if (sniffSecretContent(b, "a.js")) hits++; }
    console.log("printable random 70KB hits/200:", hits); expect(hits).toBeLessThan(3);
  });
  it("minified: many .env-like lines in a .js (not envish name) ok; in config.js flagged?", () => {
    const t = Array.from({ length: 5 }, (_, i) => `VAR_${i}=abcdefghijk`).join("\n");
    console.log("config.js dotenv:", sniffSecretContent(enc(t), "config.js"), "| x.js:", sniffSecretContent(enc(t), "x.js"));
  });
  it("settings.py / config.* docs with UPPER=value lines (FP rate)", () => {
    const t = "A_B=12345678\nC_D=abcdefgh\nE_F=zzzzzzzz\n";
    expect(sniffSecretContent(enc(t), "config.md")).toBeNull(); // documentation, nothing credential-like
    const real = "API_KEY=abcdefgh1234\nA_B=12345678\nC_D=abcdefgh\n";
    expect(sniffSecretContent(enc(real), "config.md")).toMatch(/environment/);
    expect(sniffSecretContent(enc(t), ".env")).toMatch(/environment/); // a real .env needs nothing more
    expect(sniffSecretContent(enc("A_B=12345678\nC_D=Zk3pQ9xLm2Vb7Nw4Rt8Yh\nE_F=zzzzzzzz\n"), "config.txt")).toMatch(/environment/); // high-entropy value
  });
});

describe("Audit5 bypasses", () => {
  const hit = (s: string, n = "x.txt") => sniffSecretContent(enc(s), n);
  const hex = "a1".repeat(32);
  it("a secret in the MIDDLE of a >64KB text file IS found (the whole file is windowed up to 8 MiB)", () => {
    const mid = "x\n".repeat(40000) + `-----BEGIN PRIVATE KEY-----\n` + "x\n".repeat(40000);
    expect(hit(mid)).not.toBeNull();
    const f = "x\n".repeat(20000) + "-----BEGIN PRIVATE KEY-----\n" + "x\n".repeat(15000);
    expect(hit(f)).not.toBeNull();
  });
  it("a secret in the middle of a 3 MiB file is found, and the file is not reported partial", () => {
    const f = enc("x\n".repeat(1_000_000) + "ghp_" + "a".repeat(30) + "\n" + "x\n".repeat(500_000));
    const r = sniffSecret(f, "x.txt");
    expect(r.reason).toMatch(/GitHub/);
    expect(r.partial).toBe(false);
  });
  it("a token cut by a segment seam (1 MiB) is still found", () => {
    const seg = 1024 * 1024 - 4096;
    const tok = "ghp_" + "a".repeat(30);
    const pre = "x".repeat(seg - 10) + "\n";
    expect(hit(pre + tok + "\n" + "x".repeat(5000))).toMatch(/GitHub/);
  });
  it("a file over 8 MiB is scanned head+tail and REPORTED as partial; the middle is the only blind spot", () => {
    const big = new Uint8Array(9 * 1024 * 1024).fill(120);
    big.set(enc("-----BEGIN PRIVATE KEY-----"), big.length - 100);
    const r = sniffSecret(big, "x.txt");
    expect(r.reason).toMatch(/private key/);
    expect(r.partial).toBe(true);
    const mid = new Uint8Array(9 * 1024 * 1024).fill(120);
    mid.set(enc("-----BEGIN PRIVATE KEY-----"), 4_700_000);
    const m = sniffSecret(mid, "x.txt");
    expect(m.reason).toBeNull();
    expect(m.partial).toBe(true); // the caller is told it was only partly scanned
  });
  it("a 1 GB source is scanned in bounded memory (head + tail, no whole-file read)", () => {
    const size = 1024 * 1024 * 1024;
    let maxRead = 0;
    const src = { size, read: (a: number, b: number) => { maxRead = Math.max(maxRead, b - a); const x = new Uint8Array(b - a).fill(120); return x; } };
    gc?.();
    const before = process.memoryUsage().rss;
    const r = sniffSecretSource(src, "big.txt");
    const grown = process.memoryUsage().rss - before;
    expect(r.partial).toBe(true);
    expect(maxRead).toBeLessThanOrEqual(1024 * 1024);
    expect(grown).toBeLessThan(100 * 1024 * 1024);
  });
  it("a file over 2 GiB is flagged tooLarge and only its ends are read", () => {
    const src = { size: 3 * 1024 ** 3, read: (a: number, b: number) => new Uint8Array(b - a).fill(120) };
    const r = sniffSecretSource(src, "huge.bin");
    expect(r.tooLarge).toBe(true);
    expect(r.partial).toBe(true);
  });
  it("hex key with label split by 4+ lines / label 'pk' in uppercase / 'PRIVATE_KEY=' no 0x", () => {
    expect(hit(`PRIVATE_KEY=${hex}`)).not.toBeNull();
    expect(hit(`const PK = '${hex}'`)).not.toBeNull();
    expect(hit(`export ADMIN_KEY=${hex}`)).not.toBeNull();
    expect(hit(`wallet: 0x${hex}`)).not.toBeNull();
    expect(hit(`seed = ${hex}`)).not.toBeNull();
    expect(hit(`secretKey: "${hex}"`)).not.toBeNull();
    expect(hit(`seed = "0x${hex}"`)).toBeNull(); // generative-art token seed shape stays out
  });
  it("labels the rule misses", () => {
    const miss: string[] = [];
    for (const l of ["wallet", "account", "pkey", "privkey", "p_k", "ethKey", "adminKey", "apiKey", "authToken", "password", "passwd", "credential", "sk", "operator", "relayer", "minter", "owner"]) if (!hit(`${l} = "0x${hex}"`)) miss.push(l);
    // Still unflagged on purpose (too generic to be a credential label): documented gaps.
    expect(miss.filter((l) => ["wallet", "password", "passwd", "apiKey", "seed"].includes(l))).toEqual([]);
    console.log("hex64 labels NOT flagged:", miss.join(","));
  });
  it("tokens obfuscated: AKIA split by whitespace NOT flagged (expected); base64 PEM w/o header", () => {
    expect(hit("AKIAIOSFODNN7EXAMPL3")).not.toBeNull();
    console.log("b64 pem body:", hit("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC" + "A".repeat(60)));
  });
  it("UTF-16 key", () => {
    const s = "-----BEGIN PRIVATE KEY-----"; const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) b[2 + i * 2] = s.charCodeAt(i);
    expect(sniffSecretContent(b, "a.txt")).not.toBeNull();
  });
  it("key in a file with 11% NUL bytes is treated as binary (bypass)", () => {
    const k = enc("-----BEGIN PRIVATE KEY-----\n"); const b = new Uint8Array(4096); b.set(k, 0); b.set(enc("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC"), k.length); for (let i = 3000; i < 3000 + 480; i++) b[i] = 0; // <10% so fine
    expect(sniffSecretContent(b, "x")).not.toBeNull();
    const c = new Uint8Array(4096); c.set(k, 0); c.set(enc("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC"), k.length); for (let i = 100; i < 100 + 500; i++) c[i] = 0;
    expect(sniffSecretContent(c, "x")).toMatch(/private key block/); // binary: strong signatures are still looked for
  });
  it("a binary file that merely contains the header string (no key body) is not flagged", () => {
    const b = new Uint8Array(4096); b.set(enc("-----BEGIN PRIVATE KEY-----"), 100); for (let i = 200; i < 2000; i++) b[i] = 0;
    expect(sniffSecretContent(b, "parser.wasm")).toBeNull();
  });
  it("binary-prefixed text: 5KB of NUL then a key", () => {
    const b = new Uint8Array(5000 + 200); b.set(enc("-----BEGIN PRIVATE KEY-----"), 5000);
    b.set(enc("\n" + "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".repeat(2)), 5027);
    expect(sniffSecretContent(b, "x")).not.toBeNull();
  });
  it(".asc: a public key is not flagged, an armored private block is", () => {
    expect(sniffSecretContent(enc("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQENBF\n-----END PGP PUBLIC KEY BLOCK-----"), "key.asc")).toBeNull();
    expect(sniffSecretContent(enc("-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOY"), "key.asc")).not.toBeNull();
    expect(sniffSecretContent(enc("--BEGIN PGP PRIVATE KEY BLOCK--\n\nlQOY"), "key.asc")).toMatch(/PGP/);
  });
  it("AWS's documented example key is not a finding; a lookalike is", () => {
    expect(sniffSecretContent(enc("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"), "x.md")).toBeNull();
    expect(sniffSecretContent(enc("AKIAIOSFODNN7EXAMPL3"), "x.md")).toMatch(/AWS/);
  });
  it("name normalisation", () => {
    for (const n of ["cert.p12 ", "cert.p12.", "cert．p12", "CERT.P12", ".ENV", "ｉｄ_rsa", ".env​", ".env.example.bak"]) console.log(JSON.stringify(n), isSecretLikeName(n));
    expect(isSecretLikeName("cert.p12 ")).toBe(true);
    expect(isSecretLikeName(".env​")).toBe(true);
    expect(isSecretLikeName("id_rsa‎")).toBe(true);
  });
  it("names: obvious ones NOT flagged", () => {
    const m = ["id_rsa.pub", "server.crt", "cert.pfx.zip", "key.pem.png", "private.asc", "gpg.key.asc", "secring.gpg", ".env.local.example", "app.env.js", "wallet.dat", "keys.json", "master.key.old", "config/secrets/app", "token.txt", "service-account.yaml", "gcloud.json", "id_rsa_backup", "privatekey", "kubeconfig", ".kube", ".docker", ".htpasswd", ".pypirc", "terraform.tfstate.d", "my.p8", "AuthKey_ABC.p8"].filter((n) => !isSecretLikeName(n));
    expect(m).not.toContain("my.p8");
    expect(m).not.toContain("AuthKey_ABC.p8");
    expect(m).not.toContain("kubeconfig");
    expect(m).not.toContain(".kube");
    expect(m).not.toContain(".htpasswd");
    expect(m).not.toContain(".pypirc");
    expect(isSecretLikePath("home/.kube/config")).toBe(true);
    // Still NOT flagged by name alone, on purpose (public by design, or too generic): documented.
    console.log("names NOT flagged:", m.join(" | "));
  });
});
