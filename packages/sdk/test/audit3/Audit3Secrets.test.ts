/** Round-3 secret-scanner regressions: false positives AND bypasses, both directions. */
import { describe, expect, it } from "vitest";
import { isSecretLikeName, isWeakSecretName, looksLikeMnemonic, sniffSecretContent } from "../../src/secret-names.js";

const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true) => new Uint8Array([...(bom ? [0xff, 0xfe] : []), ...[...s].flatMap((c) => [c.charCodeAt(0), 0])]);
const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("content: innocent text is NOT flagged", () => {
  it("sk- inside ordinary CSS/HTML identifiers", () => {
    expect(sniffSecretContent(enc('<div class="task-manager-dashboard-wrapper">'))).toBeNull();
    expect(sniffSecretContent(enc(".risk-assessment-framework-panel{color:red}"))).toBeNull();
    expect(sniffSecretContent(enc("#disk-usage-monitor-sidebar-widget {}"))).toBeNull();
    // standalone but kebab-case with no digit
    expect(sniffSecretContent(enc("sk-manager-dashboard-wrapper-panel"))).toBeNull();
  });
  it("generative-art 0x<64 hex> with no key-ish label", () => {
    const h = "0x" + "ab".repeat(32);
    expect(sniffSecretContent(enc(`const seed = "${h}";`))).toBeNull();
    expect(sniffSecretContent(enc(`tokenHash: "${h}"`))).toBeNull();
    expect(sniffSecretContent(enc(h))).toBeNull();
  });
  it("12 plain words with no label", () => {
    expect(sniffSecretContent(enc(MNEMONIC))).toBeNull();
  });
  it("prose that merely mentions a mnemonic", () => {
    expect(sniffSecretContent(enc("A mnemonic is a memory aid, and it is not a secret."))).toBeNull();
  });
});

describe("content: real secrets ARE flagged", () => {
  it("sk- keys (anchored, with a digit)", () => {
    expect(sniffSecretContent(enc("key=sk-proj-abc123DEF456ghi789jkl012"))).toBe("API secret key (sk-...)");
    expect(sniffSecretContent(enc('"sk-ant-api03-Zx9' + "a".repeat(30) + '"'))).toBe("API secret key (sk-...)");
  });
  it("labelled 64 hex", () => {
    const h = "0x" + "ab".repeat(32);
    expect(sniffSecretContent(enc(`PRIVATE_KEY=${h}`))).not.toBeNull();
    expect(sniffSecretContent(enc(`const secret = "${h}"`))).not.toBeNull();
    expect(sniffSecretContent(enc(`"key": "${h}"`))).not.toBeNull();
  });
  it("PEM header, any case, and PGP private key blocks", () => {
    expect(sniffSecretContent(enc("-----begin private key-----"))).toBe("private key block");
    expect(sniffSecretContent(enc("-----BEGIN PGP PRIVATE KEY BLOCK-----\nxxxx"))).toBe("private key block");
    expect(sniffSecretContent(enc("-----BEGIN ENCRYPTED PRIVATE KEY-----"))).toBe("private key block");
    // a PGP PUBLIC block is not a secret
    expect(sniffSecretContent(enc("-----BEGIN PGP PUBLIC KEY BLOCK-----"))).toBeNull();
  });
  it("a key after the first 4 KB is found through the tail window", () => {
    expect(sniffSecretContent(enc(" ".repeat(5000) + "-----BEGIN RSA PRIVATE KEY-----"))).not.toBeNull();
    expect(sniffSecretContent(enc(" ".repeat(20000) + "-----BEGIN RSA PRIVATE KEY-----\nabc\n"))).not.toBeNull();
    // ... a 20 KB file is now read in full (audit 4); the dead middle only exists beyond 64 KB
    expect(sniffSecretContent(enc(" ".repeat(10000) + "-----BEGIN RSA PRIVATE KEY-----" + " ".repeat(10000)))).not.toBeNull();
    expect(sniffSecretContent(enc(" ".repeat(100000) + "-----BEGIN RSA PRIVATE KEY-----" + " ".repeat(100000)))).not.toBeNull(); // audit 5: the middle is scanned too (whole file up to 8 MiB)
  });
  it("UTF-16 text (BOM and BOM-less) is decoded before sniffing", () => {
    const s = "-----BEGIN RSA PRIVATE KEY-----";
    expect(sniffSecretContent(utf16le(s))).toBe("private key block");
    expect(sniffSecretContent(utf16le(s, false))).toBe("private key block");
    const be = new Uint8Array([0xfe, 0xff, ...[...s].flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(sniffSecretContent(be)).toBe("private key block");
    // UTF-16 tail
    expect(sniffSecretContent(utf16le(" ".repeat(9000) + "ghp_" + "a".repeat(30)))).toBe("GitHub token");
  });
  it("binary (NUL, not UTF-16) is not sniffed", () => {
    expect(sniffSecretContent(new Uint8Array([0x89, 0x50, 0, 0x47, 0, 0, 0x4e, 0x47]))).toBeNull();
  });
  it("token families", () => {
    expect(sniffSecretContent(enc("ghp_" + "a".repeat(16)))).toBe("GitHub token");
    expect(sniffSecretContent(enc("gho_" + "a".repeat(30)))).toBe("GitHub token");
    expect(sniffSecretContent(enc("oauth_token: ghs_" + "b".repeat(30)))).toBe("GitHub token");
    expect(sniffSecretContent(enc("github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz"))).toBe("GitHub fine-grained token");
    expect(sniffSecretContent(enc("ASIA" + "A".repeat(16)))).toBe("AWS access key id");
    expect(sniffSecretContent(enc("AKIA" + "A".repeat(16)))).toBe("AWS access key id");
    expect(sniffSecretContent(enc("AIza" + "A".repeat(35)))).toBe("Google API key");
    // not tokens: prefixes inside longer identifiers
    expect(sniffSecretContent(enc("MYASIA" + "A".repeat(16)))).toBeNull();
    expect(sniffSecretContent(enc("xghp_" + "a".repeat(30)))).toBeNull();
  });
  it("a mnemonic next to a label", () => {
    expect(sniffSecretContent(enc(`mnemonic: ${MNEMONIC}`))).toBe("recovery phrase after a label");
    expect(sniffSecretContent(enc(`Seed phrase\n${MNEMONIC}`))).toBe("recovery phrase after a label");
    expect(sniffSecretContent(enc(`recovery phrase = "${MNEMONIC}"`))).toBe("recovery phrase after a label");
  });
  it("wallet.txt / seed.txt are flagged only WITH mnemonic-like content", () => {
    expect(isWeakSecretName("wallet.txt")).toBe(true);
    expect(isWeakSecretName("seed.txt")).toBe(true);
    expect(isWeakSecretName("recovery-phrase.txt")).toBe(true);
    expect(isWeakSecretName("index.html")).toBe(false);
    for (const n of ["wallet.txt", "seed.txt", "recovery-phrase.txt"]) {
      expect(sniffSecretContent(enc(MNEMONIC), n), n).toBe("recovery phrase in a wallet/seed file");
      expect(sniffSecretContent(enc("Connect your wallet to mint. Supports MetaMask."), n), n).toBeNull();
    }
    // 24 words too, but not 11 or 13
    expect(looksLikeMnemonic(Array(24).fill("abandon").join(" "))).toBe(true);
    expect(looksLikeMnemonic(Array(11).fill("abandon").join(" "))).toBe(false);
    expect(looksLikeMnemonic(Array(13).fill("abandon").join(" "))).toBe(false);
    // the same words in a file with an ordinary name are not flagged
    expect(sniffSecretContent(enc(MNEMONIC), "notes.txt")).toBeNull();
  });
});

describe("names", () => {
  it("innocent names are NOT flagged", () => {
    for (const n of ["secret.png", "credentials-ui.png", "credentials.html", "private-keys-explained.html", "secrets.md", ".env.example", ".env.sample", ".env.template", "slides.key.png", "private-key-guide.md", "environment.md"]) {
      expect(isSecretLikeName(n), n).toBe(false);
    }
  });
  it("secret-ish names ARE flagged", () => {
    for (const n of [".env", ".env.local", "server.pem", "server.pem.bak", "server.key.old", "a.pem.1", "my-id_rsa", "id_rsa", "id_ed25519", "config.secret", "my-secrets.json", "secrets.json", "credentials.json", "credentials", "client_secret_123.json", "backup.kdbx.bak", "mnemonic.txt", "private_key.json", "terraform.tfvars", "x.tfstate"]) {
      expect(isSecretLikeName(n), n).toBe(true);
    }
  });
  it("accepted: a Keynote file named *.key is flagged (indistinguishable by name)", () => {
    expect(isSecretLikeName("slides.key")).toBe(true);
  });
});

describe("performance", () => {
  it("5000 text files of 4KB + minified 64-hex-heavy file", () => {
    const body = enc(("seedx" + "a".repeat(11) + " ").repeat(300) + "0123456789abcdef".repeat(4).repeat(20));
    const t = performance.now();
    for (let i = 0; i < 5000; i++) sniffSecretContent(body);
    expect(performance.now() - t).toBeLessThan(8000);
  });
  it("regex worst case: many 'secret' + 12 non-hex chars; many 'sk-' starts", () => {
    const t = performance.now();
    for (let i = 0; i < 500; i++) {
      sniffSecretContent(enc("secret!!!!!!!!!!!!".repeat(300)));
      sniffSecretContent(enc("sk-abcdefghijklmnopqrst".repeat(100)));
      sniffSecretContent(enc("mnemonic ".repeat(400)));
    }
    expect(performance.now() - t).toBeLessThan(8000);
  });
});
