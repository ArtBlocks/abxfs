#!/usr/bin/env node
/**
 * What may be committed to this repository, checked on every pull request (`pnpm check:hygiene`).
 *
 * The repository is public, so it carries what someone needs to build, test, deploy, run or audit ABX FS, and nothing
 * about one operator's accounts or work in progress: no planning notes, review checklists, raw audit transcripts or
 * submission drafts (use GitHub Issues and pull requests), no local state, no build output, no credential. Every
 * relative link in Markdown must resolve, so removing a document cannot leave a dangling reference to it.
 *
 * The secret patterns are a backstop to GitHub secret scanning, not a replacement. A file that must contain one of the
 * patterns (a well-known development key, a scanner's own test vectors) is listed in `FIXTURES` with the reason.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const errors = [];

const repositoryFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((path) => existsSync(resolve(root, path)));

const forbiddenPaths = [".claude/settings.local.json", ".vercel"];
for (const path of forbiddenPaths) {
  if (repositoryFiles.some((file) => file === path || file.startsWith(`${path}/`))) {
    errors.push(`local-state path is included: ${path}`);
  }
}

const forbiddenNames = [
  /^\.DS_Store$/,
  /^\.env(?:\..+)?$/,
  /^settings\.local\.json$/,
  /(?:^|[-_.])credentials?(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:private-?)?key\.(?:json|pem|key)$/i,
];
for (const path of repositoryFiles) {
  const name = basename(path);
  if (name.endsWith(".example")) continue;
  if (["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(name) && !path.includes("/test/fixtures/")) {
    errors.push(`alternate package-manager lockfile is included: ${path}`);
  }
  if (forbiddenNames.some((pattern) => pattern.test(name))) errors.push(`credential or local-state file is tracked: ${path}`);
  if (/\.(?:tgz|tar|zip)$/.test(name)) errors.push(`archive is tracked: ${path}`);
  if (/\.tsbuildinfo$/.test(name)) errors.push(`build cache is tracked: ${path}`);
  if (/(^|\/)(?:node_modules|dist|out|cache|broadcast|\.next)(\/|$)/.test(path)) {
    errors.push(`generated directory is tracked: ${path}`);
  }
}

const secretPatterns = [
  ["private-key block", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{30,}/],
  ["npm token", /npm_[A-Za-z0-9]{30,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["credentialed URL", /https?:\/\/[^\s/:'"`]+:[^\s@/'"`]+@/],
  ["keyed RPC URL", /https:\/\/[a-z0-9-]+\.(?:g\.alchemy\.com\/v2|infura\.io\/v3|quiknode\.pro)\/[A-Za-z0-9_-]{16,}/],
  ["assigned EVM private key", /(?:PRIVATE_KEY|DEPLOYER_PK|FUNDED_PK)\s*=\s*["']?0x[0-9a-fA-F]{64}(?:["']|\s|$)/],
];

// Files that must contain a pattern above, and why. Anything else that matches fails the check.
const SCANNER = "the upload secret scanner's test vectors: header-only key blocks and fake tokens";
const URLS = "URL parsing and redaction cases with `user:pw@` placeholder credentials";
const FIXTURES = {
  "packages/cli/test/audit2/Audit2ScanA.test.ts": SCANNER,
  "packages/cli/test/audit4/Audit4Cli.test.ts": SCANNER,
  "packages/sdk/test/audit3/Audit3Secrets.test.ts": SCANNER,
  "packages/sdk/test/audit4/Audit4Secrets.test.ts": SCANNER,
  "packages/sdk/test/audit5/Audit5Scanner.test.ts": SCANNER,
  "packages/sdk/test/round2-hardening.test.ts": SCANNER,
  "packages/sdk/src/secret-names.ts": "AWS's documented example access key id, in a comment",
  "site/content/docs/reference/cli.mdx": "AWS's documented example access key id, in an example of the scanner's output",
  "packages/cli/test/audit2/Audit2RedactA.test.ts": URLS,
  "packages/cli/test/redact.test.ts": URLS,
  "packages/contracts-projects/test/audit2/Audit2Deploy.t.sol": URLS,
  "packages/sdk/test/audit4/Audit4XViewUrl.test.ts": URLS,
  "packages/sdk/test/audit5/Audit5ViewUrl.test.ts": URLS,
  "packages/sdk/test/safety-helpers.test.ts": URLS,
};

for (const path of Object.keys(FIXTURES)) {
  if (!repositoryFiles.includes(path)) errors.push(`FIXTURES lists a file that does not exist: ${path}`);
}
for (const path of repositoryFiles) {
  const absolute = resolve(root, path);
  if (!lstatSync(absolute).isFile()) continue;
  const bytes = readFileSync(absolute);
  if (bytes.length > 2_000_000 || bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text) && !FIXTURES[path]) errors.push(`possible ${label}: ${path}`);
  }
}

for (const name of ["cli", "gateway", "pinning", "sdk"]) {
  const path = `packages/${name}/package.json`;
  const pkg = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  if (pkg.license !== "MIT") errors.push(`${path} must declare license MIT`);
  if (pkg.repository?.url !== "git+https://github.com/ArtBlocks/abxfs.git") errors.push(`${path} must name this repository`);
  if (pkg.bugs !== "https://github.com/ArtBlocks/abxfs/issues") errors.push(`${path} must direct bugs to the public issue tracker`);
  // npm trusted publishing checks the repository named here against the workflow that publishes.
  if (pkg.repository?.directory !== `packages/${name}`) errors.push(`${path} must name its directory in repository.directory`);
  if (pkg.private) errors.push(`${path} is published to npm and must not be private`);
  if (!pkg.files?.includes("LICENSE")) errors.push(`${path} must ship its LICENSE`);
  const license = resolve(root, `packages/${name}/LICENSE`);
  if (!existsSync(license) || readFileSync(license, "utf8") !== readFileSync(resolve(root, "LICENSE"), "utf8")) {
    errors.push(`packages/${name}/LICENSE must be a copy of the repository's LICENSE`);
  }
}

const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
for (const path of repositoryFiles) {
  if (![".md", ".mdx"].includes(extname(path))) continue;
  const text = readFileSync(resolve(root, path), "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const clean = decodeURIComponent(target.split("#", 1)[0]);
    if (!clean) continue;
    if (!existsSync(resolve(root, dirname(path), clean))) errors.push(`broken relative link: ${path} -> ${target}`);
  }
}

if (errors.length) {
  console.error("Repository hygiene check failed:");
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Repository hygiene check passed (${repositoryFiles.length} repository files inspected).`);
