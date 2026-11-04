/**
 * What looks like a secret, in ONE place. Everything uploaded to ABX FS is public and permanent, so the
 * CLI (`abxfs upload`) and the web dropzone apply the same rules, and they import them from here so the
 * two cannot drift. Pure string/byte logic, no DOM and no node APIs.
 *
 * Two layers: the NAME of any path segment, and a sniff of a file's CONTENT: all of it up to
 * {@link SNIFF_FULL_BYTES}, the first and last {@link SNIFF_BYTES} of anything larger (and the result then says
 * `partial`, so callers can tell the user the file was only partly scanned). A hit on either needs an
 * explicit, informed confirmation; neither is a guarantee.
 *
 * The rules are tuned in both directions. A scanner that cries wolf on `credentials.html` or on a CSS
 * class called `task-manager-dashboard-wrapper` teaches people to type "yes" without reading; one that
 * misses `server.pem.bak` ships a key. So name rules key on the file's KIND (`credentials.json`, not a
 * `credentials-ui.png`), token rules are anchored and the generic `sk-` rule needs a digit, and a few names
 * (`wallet.txt`, `seed.txt`) are flagged only when the content really looks like a recovery phrase.
 */

/** A template that is meant to be committed and published: `.env.example`, `.env.sample`, ... */
const TEMPLATE_NAME = /\.(example|sample|template|dist|defaults?)$/i;
/** Extensions that make a `*.key.*` / `*.pem.*` name an image or web file, not a backup of a key. */
const BENIGN_TRAILING_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|html?|css|js|mjs|md|mdx|pdf)$/i;

/** Path-segment names that look like credentials, keys, state files or repository metadata. */
export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, .envrc, .env_prod (templates are exempted in isSecretLikeName)
  /\.env(?![a-z0-9])/i, // production.env, app.env.bak (but not "environment")
  /\.(pem|key|p12|pfx|jks|kdbx|keystore|p8)$/i,
  /\.(pem|key|p12|pfx|jks|kdbx|keystore|p8)\.[^./\\]{1,12}$/i, // server.pem.bak, backup.kdbx.old, key.pem.1
  /(^|[-_.])id_(rsa|ed25519|ecdsa|dsa)/i, // id_rsa, my-id_rsa, deploy_id_ed25519
  /^wallet\.json$/i,
  /^keystore.*\.json$/i,
  /^UTC--/i,
  /\.tfstate(\.backup)?$/i,
  /^terraform\.tfvars/i,
  /^secrets?\.(json|ya?ml|toml|ini|cfg|conf|env|txt|properties)$/i, // not secret.png / secrets.md
  /(^|[-_.])secrets?\.(json|ya?ml|toml|ini|cfg|conf|env|txt|properties)$/i, // my-secrets.json
  /\.secrets?$/i, // config.secret
  /^credentials?(\.(json|ya?ml|toml|ini|cfg|conf|csv|txt|xml|env|properties))?$/i, // not credentials-ui.png / credentials.html
  /^client[-_]?secrets?.*\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /^(mnemonic|private[-_ ]?keys?)(\.(txt|json|key|pem|asc|bin|hex|dat|env))?$/i, // not private-keys-explained.html
  /^\.(npmrc|netrc|pgpass|dockercfg|git-credentials|htpasswd|pypirc)$/i,
  /^\.(aws|ssh|git|kube)$/i, // .kube/config is covered by the directory
  /^kubeconfig(\.(ya?ml|json|conf|cfg|txt|bak|old))?$/i,
];

/**
 * Names that are secret ONLY if the content agrees (a recovery phrase). A bare `wallet.txt` is as likely
 * to be a page about wallets, so the name alone is not a hit; see {@link sniffSecretContent}'s `name` arg.
 */
export const WEAK_SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^(wallet|seed|recovery|mnemonic|backup[-_ ]?phrase|seed[-_ ]?phrase|recovery[-_ ]?phrase|secret[-_ ]?phrase)[-_ a-z0-9]*\.(txt|md|json|text|rtf)$/i,
  // An armored PGP file is usually a PUBLIC key meant to be shared: a hit only with a private block inside.
  /\.asc$/i,
];

/**
 * What a filesystem (or a user) may treat as the same name: `cert.p12 `, `cert.p12.`, `cert．p12` (fullwidth
 * dot) and `CERT.P12` all open as the one key file on Windows / macOS / most tools, so all must hit the same
 * rules. NFKC folds the fullwidth and ideographic forms; trailing dots, blanks and NBSP are dropped.
 */
export function normalizeSecretName(segment: string): string {
  let s = segment;
  try {
    s = s.normalize("NFKC");
  } catch {
    /* a lone surrogate: keep the raw string */
  }
  // Trim from the END, one character at a time: linear. (A trailing-class regex retried from every start
  // and was quadratic on a long run of blanks and dots in the middle of a name.)
  let end = s.length;
  while (end > 0 && isTrailingFiller(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end).toLowerCase();
}

/** Whitespace, dots, NBSP, ideographic space, zero-width characters and the BOM. */
function isTrailingFiller(c: number): boolean {
  return (
    c === 0x2e || c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200d) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Backup, editor and archive decorations that leave a key a key: `server.key~`, `x.pem.orig.bak`, `a.p12.old.1`, `k.pem.bak.gz`. */
const BACKUP_SUFFIX = /(?:~|\.(?:bak|backup|old|orig|save|swp|swo|tmp|temp|gz|gzip|bz2|xz|zip|z|\d+))$/i;

/** The name with every trailing backup/archive decoration removed (a run of them, in any order). Linear. */
export function stripBackupSuffixes(name: string): string {
  let s = name;
  for (let i = 0; i < 16; i++) {
    const m = BACKUP_SUFFIX.exec(s);
    if (!m || m.index === 0) break;
    s = s.slice(0, m.index);
  }
  return s;
}

function nameHits(segment: string): boolean {
  if (/^\.env/i.test(segment) || /\.env(?![a-z0-9])/i.test(segment)) {
    if (TEMPLATE_NAME.test(segment)) return false;
  }
  if (/\.(pem|key|p12|pfx|jks|kdbx|keystore|p8)\.[^./\\]{1,12}$/i.test(segment) && BENIGN_TRAILING_EXT.test(segment)) return false;
  return SECRET_NAME_PATTERNS.some((re) => re.test(segment));
}

/** Whether one path segment (a file or directory name) looks like it holds a secret. */
export function isSecretLikeName(rawSegment: string): boolean {
  const segment = normalizeSecretName(rawSegment);
  if (nameHits(segment)) return true;
  const stripped = stripBackupSuffixes(segment);
  return stripped !== segment && nameHits(stripped);
}

/** Whether a name is only suspicious together with matching content (`wallet.txt`, `seed.txt`). */
export function isWeakSecretName(segment: string): boolean {
  const n = normalizeSecretName(segment);
  const stripped = stripBackupSuffixes(n);
  return WEAK_SECRET_NAME_PATTERNS.some((re) => re.test(n) || re.test(stripped));
}

/** Whether any segment of a `/` or `\` separated path looks like it holds a secret. */
export function isSecretLikePath(path: string): boolean {
  return path.split(/[\\/]/).some(isSecretLikeName);
}

/** A file up to this size is scanned in full. Beyond it only the two ends are (and the result says `partial`). */
export const SNIFF_FULL_BYTES = 8 * 1024 * 1024;
/** The size of each end that is inspected when a file is larger than {@link SNIFF_FULL_BYTES}. */
export const SNIFF_BYTES = 4 * 1024 * 1024;
/** Above this a file is not read at all beyond its two ends, and the caller is told so (the CLI refuses to load it). */
export const SNIFF_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** The web only reads files up to this size for sniffing (the CLI sniffs every file). */
export const WEB_SNIFF_MAX_FILE_BYTES = 1024 * 1024;
/** Bytes decoded at a time: a 1 GB file never becomes more than ~2 MB of string. */
const SEGMENT_BYTES = 1024 * 1024;
/** Segments overlap by this much (even, so UTF-16 stays aligned): a token cut by a seam is whole in the next. */
const SEGMENT_OVERLAP = 4096;

/** One scan window and how far consecutive windows overlap: a token cut by a seam is whole in the next. */
const WINDOW_BYTES = 16 * 1024;
const WINDOW_OVERLAP = 2 * 1024;
/** How much of the start decides whether a file is binary. */
const BINARY_PROBE_BYTES = 4096;

const WORD = "[a-z]{3,8}";
/** Between phrase words: blanks, commas or newlines, optionally a list number (`3.`, `4)`). */
const SEP = "(?:[ \\t,\\r\\n]+(?:\\d{1,2}[.):]?[ \\t]+)?)";
/** 12 to 24 lowercase 3-8 letter words, separated by blanks, commas or newlines: the shape of a BIP-39 phrase. */
const PHRASE = `(?:${WORD}${SEP}){11,23}${WORD}`;
const MNEMONIC_NEAR_LABEL = new RegExp(
  `(?:mnemonic|seed[ _-]?phrase|seed[ _-]?words|recovery[ _-]?(?:phrase|words)|secret[ _-]?(?:recovery[ _-]?)?(?:phrase|words)|backup[ _-]?phrase)(?:[ \\t]*\\(\\d{1,2}[ -]?words?\\))?[^a-z0-9]{0,8}(?:\\d{1,2}[.):]?[ \\t]+)?(${PHRASE})(?![a-z])`,
  "i",
);
const WHOLE_PHRASE = new RegExp(`^\\s*(?:${WORD}[ \\t,\\r\\n]+){11,23}${WORD}\\s*$`);

/** Whether the whole text is (only) a 12 to 24 word recovery-phrase-shaped list. */
export function looksLikeMnemonic(text: string): boolean {
  const t = text.trim();
  if (t.length > 400) return false;
  if (!WHOLE_PHRASE.test(t)) return false;
  const n = t.split(/[ \t,\r\n]+/).length;
  return n === 12 || n === 15 || n === 18 || n === 21 || n === 24;
}

interface Rule {
  reason: string;
  re: RegExp;
  /** Extra check on the match, for rules a regex cannot express. `before` is the text just ahead of it. */
  check?: (match: string, before: string) => boolean;
}

/** A password that is obviously a placeholder in documentation: `user:password@host`, `user:<pass>@host`. */
const PLACEHOLDER_PASSWORD = /^(pass(word|wd)?|secret|xxx+|x{3,}|\*+|\.{3}|…|changeme|hunter2?|your[-_]?pass(word)?|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%s|\[[^\]]*\])$/i;
const PLACEHOLDER_USER = /^(user(name)?|your[-_]?user(name)?|foo|bar|name|me|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i;

const JWT_LABEL = /(token|jwt|bearer|authorization|auth|secret|api[-_ ]?key|session|cookie)[^\n]{0,24}$/i;

const CONTENT_RULES: readonly Rule[] = [
  // Case-insensitive: `-----begin private key-----` is still a key. Covers PGP / ENCRYPTED / OPENSSH too, and
  // tolerates the header being wrapped over two lines.
  { reason: "private key block", re: /-----BEGIN[\sA-Z]*PRIVATE\s+KEY(?: BLOCK)?-----/i },
  {
    // AWS's documented example id is in every tutorial; it is not a credential.
    reason: "AWS access key id",
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/,
    check: (m) => m !== "AKIAIOSFODNN7EXAMPLE",
  },
  {
    // `seed` has its own rule below: a generative-art token seed is routinely a bare 0x + 64 hex. A label that
    // says private/secret/mnemonic/key on the line, or up to three lines above the value, is what turns the
    // number into a credential. `privateKeyToAccount("0x...")`, `privKeyHex:\n"..."`, `deployer: "0x..."`.
    reason: "64 hex characters after a key-like label",
    re: /(?:priv\w{0,12}key\w{0,12}|private|secret\w{0,12}|mnemonic|wallet|pass(?:word|wd)|api[-_ ]?key|signing[-_ ]?key|deployer|signer|(?<![A-Za-z])key(?![A-Za-z])|(?<![A-Za-z])pk(?![A-Za-z]))(?:[^\n0-9a-fA-F]{0,24}\n){0,3}[^\n0-9a-fA-F]{0,24}(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/i,
  },
  {
    // `seed` is a label for a key AND for a generative-art token seed, which is routinely `0x` + 64 hex. So only
    // a BARE 64-hex value after `seed` is a hit; the `0x` form stays out (it is the art-token shape).
    reason: "64 hex characters after a key-like label",
    re: /(?<![A-Za-z])seed(?![a-z])(?:[^\n0-9a-fA-F]{0,24}\n){0,3}[^\n0-9a-fA-F]{0,24}(?!0x)[0-9a-fA-F]{64}(?![0-9a-fA-F])/i,
  },
  { reason: "private key literal in code", re: /privateKeyToAccount\(\s*['"`]0x[0-9a-fA-F]{64}/ },
  { reason: "Slack token", re: /(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{8,}/ },
  { reason: "GitHub token", re: /(?<![A-Za-z0-9_])(?:gh[pousr])_[0-9A-Za-z]{16,}/ },
  { reason: "GitHub fine-grained token", re: /(?<![A-Za-z0-9_])github_pat_[0-9A-Za-z_]{22,}/ },
  { reason: "Google API key", re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { reason: "Stripe live key", re: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[0-9A-Za-z]{16,}/ },
  { reason: "SendGrid API key", re: /(?<![A-Za-z0-9_])SG\.[\w-]{16,}\.[\w-]{16,}/ },
  { reason: "npm token", re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  {
    // Three or more, or one that is labelled: a lone `eyJ...` in a docs page is usually an example.
    reason: "JWT",
    re: /eyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]{4,}/g,
    check: (_m, before) => JWT_LABEL.test(before),
  },
  {
    reason: "URL with an embedded password",
    re: /:\/\/([^\s:/@'"<>]{1,64}):([^\s@/'"<>]{1,128})@[A-Za-z0-9._[-]/,
    check: (m) => {
      const [, user = "", pass = ""] = /:\/\/([^:]+):([^@]+)@/.exec(m) ?? [];
      return !PLACEHOLDER_PASSWORD.test(pass) && !(PLACEHOLDER_USER.test(user) && PLACEHOLDER_PASSWORD.test(pass));
    },
  },
  {
    // Anchored so `task-manager-...` and `.risk-assessment-...` do not match, and it must contain a digit:
    // real keys (`sk-proj-...`, `sk-ant-api03-...`) always do, kebab-case identifiers do not. Either a NAMED
    // family (`sk-proj-`, `sk-ant-`, ...) or a bare `sk-` followed by one unbroken run of 32+ letters and digits
    // that ENDS there: now that whole files are read, a looser rule matched the start of random base64url
    // strings (which carry `-` and `_`) in minified bundles and source maps.
    reason: "API secret key (sk-...)",
    re: /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin|ant|or|live|test)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,}(?![A-Za-z0-9_-]))/,
    check: (m) => /[0-9]/.test(m) && /[A-Za-z]/.test(m),
  },
];

/** A web3 keystore (V3) in any file: the shape is unmistakable and the ciphertext is crackable offline. */
function keystoreHit(text: string): boolean {
  return /"crypto"\s*:\s*\{/i.test(text) && /"ciphertext"\s*:/i.test(text) && /"kdf"\s*:/i.test(text);
}

/** Names whose content is configuration: a `.env`, an `env.txt`, a `config`, a `prod.environment`. */
const ENVISH_NAME = /^(?:\.|env|config|settings|secrets?)|\.(?:env|environment|ini|cfg|conf|properties|local|prod|production|staging|dev)$/i;

/** A name that is, by its very shape, an environment file: there the three-assignments rule alone decides. */
const STRICT_ENV_NAME = /^\.env|^env(?:[-_.]|$)|\.env(?![a-z0-9])|^secrets?\b/i;
/** Variable names that carry a credential. */
const SECRETISH_VAR = /(?:KEY|SECRET|TOKEN|PASS(?:WORD|WD)?|PRIVATE|CRED(?:ENTIAL)?S?|AUTH|MNEMONIC|SEED|SIGNER|DEPLOYER|DSN)/;

/** Whether a value has the look of generated material: long, mixed letters and digits, high character entropy. */
function highEntropyValue(v: string): boolean {
  if (v.length < 16) return false;
  const counts = new Map<string, number>();
  for (const c of v) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / v.length) * Math.log2(n / v.length);
  return h >= 3.5 && /[A-Za-z]/.test(v) && /[0-9]/.test(v);
}

/**
 * Three or more `NAME=value` lines with an 8+ character value: a dotenv, whatever the file is called.
 *
 * In a file whose name only suggests configuration (`config.md`, `settings.txt`) three assignments are as
 * likely to be documentation, so there at least one of them must also LOOK like a secret: a credential-ish
 * variable name (`API_KEY`, `DB_PASSWORD`, ...) or a high-entropy value. A real `.env` needs neither.
 */
function dotenvHit(text: string, strict: boolean): boolean {
  let n = 0;
  let secretish = false;
  for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*["']?([^\s"']{8,})/gm)) {
    n++;
    if (SECRETISH_VAR.test(m[1]!) || highEntropyValue(m[2]!)) secretish = true;
    if (n >= 3 && (strict || secretish)) return true;
  }
  return n >= 3 && (strict || secretish);
}

/** Whether the bytes are UTF-16 text (BOM, or the alternating-NUL shape of ASCII): `true` = little endian. */
function detectUtf16(bytes: Uint8Array, end: number): boolean | null {
  if (end < 4) return null;
  const [b0, b1, b2, b3] = [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
  if (b0 === 0xff && b1 === 0xfe) return true;
  if (b0 === 0xfe && b1 === 0xff) return false;
  if (b1 === 0 && b3 === 0 && b0 !== 0 && b2 !== 0) return true;
  if (b0 === 0 && b2 === 0 && b1 !== 0 && b3 !== 0) return false;
  return null;
}

function decodeUtf16(bytes: Uint8Array, start: number, end: number, le: boolean): string {
  const even = start + (((end - start) >> 1) << 1);
  return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes.subarray(start, even));
}

/** Latin-1 view of a byte range; NUL becomes a blank so ONE stray NUL cannot switch sniffing off. */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 8192) {
    const part = bytes.subarray(i, Math.min(end, i + 8192));
    let s = "";
    for (let j = 0; j < part.length; j++) {
      const b = part[j]!;
      s += String.fromCharCode(b === 0 ? 32 : b);
    }
    text += s;
  }
  return text;
}

/**
 * Binary = more than 10% NUL bytes, or more than 10% of the first 4 KB not valid UTF-8, in text that is not
 * UTF-16. A ratio, not a single byte: one NUL or one stray high byte must not exempt a file from the scan.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_PROBE_BYTES);
  if (n === 0) return false;
  let nul = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  if (nul / n > 0.1) return true;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, n));
  let bad = 0;
  for (let i = 0; i < decoded.length; i++) if (decoded.charCodeAt(i) === 0xfffd) bad++;
  return bad / n > 0.1;
}

function ruleHit(text: string): string | null {
  for (const r of CONTENT_RULES) {
    if (!r.check) {
      if (r.re.test(text)) return r.reason;
      continue;
    }
    const g = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
    let jwtCount = 0;
    for (const m of text.matchAll(g)) {
      if (r.reason === "JWT" && ++jwtCount >= 3) return r.reason;
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      if (r.check(m[0], before)) return r.reason;
    }
  }
  if (MNEMONIC_NEAR_LABEL.test(text)) return "recovery phrase after a label";
  if (keystoreHit(text)) return "encrypted keystore (web3 V3)";
  return null;
}

/**
 * What is looked for in a BINARY file: only a private-key block that is followed by key-looking text. A wasm
 * or font that merely contains the header string (a crypto library parsing PEM) has no base64 body after it.
 */
const BINARY_STRONG = /-----BEGIN[\sA-Z]*PRIVATE\s+KEY(?: BLOCK)?-----[\r\n]{1,2}(?:[A-Za-z-]+: [^\r\n]*[\r\n]+){0,3}[\r\n]*[A-Za-z0-9+/=]{40,}/i;

/** Slice a decoded text into overlapping windows, so a rule never straddles a seam it cannot see across. */
function* windows(text: string): Generator<string> {
  if (text.length <= WINDOW_BYTES) {
    yield text;
    return;
  }
  const stride = WINDOW_BYTES - WINDOW_OVERLAP;
  for (let i = 0; i < text.length; i += stride) {
    yield text.slice(i, i + WINDOW_BYTES);
    if (i + WINDOW_BYTES >= text.length) return;
  }
}

/** Where a file's bytes come from: a buffer, or a file read a range at a time. `read` may return fewer bytes only at EOF. */
export interface SniffSource {
  size: number;
  read(start: number, end: number): Uint8Array;
}

export interface SniffOutcome {
  /** Why the content looks secret, or null. */
  reason: string | null;
  /** True when only part of the file was examined (it is larger than {@link SNIFF_FULL_BYTES}). Say so to the user. */
  partial: boolean;
  /** True when the file is binary: only a private-key block (with its body) is looked for. */
  binary: boolean;
  /** True when the file is larger than {@link SNIFF_MAX_FILE_BYTES}. */
  tooLarge: boolean;
}

/**
 * Inspect a file's content and say why it looks secret, and how much of it was looked at. Reads at most
 * {@link SEGMENT_BYTES} at a time and keeps no more than one decoded segment alive, so memory does not grow
 * with the file. See {@link sniffSecretContent} for the rules.
 */
export function sniffSecretSource(src: SniffSource, name?: string): SniffOutcome {
  const size = src.size;
  const tooLarge = size > SNIFF_MAX_FILE_BYTES;
  const partial = size > SNIFF_FULL_BYTES;
  const head = src.read(0, Math.min(size, BINARY_PROBE_BYTES));
  const le = detectUtf16(head, head.length);
  const binary = le === null && looksBinary(head);

  const base = name !== undefined ? (name.split(/[\\/]/).pop() ?? name) : undefined;
  const normalized = base !== undefined ? normalizeSecretName(base) : undefined;
  const envish = normalized !== undefined && ENVISH_NAME.test(normalized);
  const strictEnv = normalized !== undefined && STRICT_ENV_NAME.test(normalized);
  const outcome = (reason: string | null): SniffOutcome => ({ reason, partial, binary, tooLarge });

  const ranges: Array<[number, number]> = partial
    ? [[0, SNIFF_BYTES], [Math.floor((size - SNIFF_BYTES) / 2) * 2, size]]
    : [[0, size]];

  let firstText: string | null = null;
  for (const [from, to] of ranges) {
    for (let start = from; start < to; start += SEGMENT_BYTES - SEGMENT_OVERLAP) {
      const end = Math.min(to, start + SEGMENT_BYTES);
      const bytes = src.read(start, end);
      const text = le !== null ? decodeUtf16(bytes, 0, bytes.length, le) : latin1(bytes, 0, bytes.length);
      if (firstText === null) firstText = text.slice(0, 2048);
      if (binary) {
        if (BINARY_STRONG.test(text)) return outcome("private key block (in a binary file)");
      } else {
        for (const w of windows(text)) {
          const hit = ruleHit(w);
          if (hit) return outcome(hit);
          if (envish && dotenvHit(w, strictEnv)) return outcome("environment-variable assignments (.env style)");
        }
      }
      if (end >= to) break;
    }
  }
  if (!binary && normalized !== undefined && normalized.endsWith(".asc") && firstText !== null) {
    // An .asc is usually a public key. Only an armored PRIVATE block makes it a secret (the generic rule
    // above needs five dashes; a mangled header is still one).
    let all = firstText;
    if (size <= SNIFF_FULL_BYTES) all = latin1(src.read(0, size), 0, size);
    if (/BEGIN PGP (?:PRIVATE|SECRET)/i.test(all)) return outcome("PGP private key block in an .asc file");
  }
  if (!binary && normalized !== undefined && firstText !== null && isWeakSecretName(normalized)) {
    if (looksLikeMnemonic(size <= SNIFF_FULL_BYTES ? latin1(src.read(0, size), 0, size) : firstText)) {
      return outcome("recovery phrase in a wallet/seed file");
    }
  }
  return outcome(null);
}

/** {@link sniffSecretSource} over a buffer already in memory. */
export function sniffSecret(bytes: Uint8Array, name?: string): SniffOutcome {
  return sniffSecretSource({ size: bytes.length, read: (a, b) => bytes.subarray(a, Math.min(b, bytes.length)) }, name);
}

/**
 * Inspect a file's text and return why it looks secret, or null.
 *
 * A file up to {@link SNIFF_FULL_BYTES} is read in full, in overlapping windows (a key pasted in the middle
 * of a 100 KB file is found); a larger one has its first and last {@link SNIFF_BYTES} read, which
 * {@link sniffSecret} reports as `partial`. Binary data (see {@link looksBinary}) is not text: it is only
 * checked for a private-key block with its body. UTF-16 text is decoded first.
 * `name` (the file name) enables two rules a content-only scan cannot make safely: the weak-name rule (a
 * `wallet.txt` or `seed.txt` whose whole content is a 12 to 24 word recovery phrase) and the dotenv rule
 * (three or more `NAME=value` lines in a file named like configuration).
 */
export function sniffSecretContent(bytes: Uint8Array, name?: string): string | null {
  return sniffSecret(bytes, name).reason;
}
