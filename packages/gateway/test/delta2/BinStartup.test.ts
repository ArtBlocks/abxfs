/**
 * DELTA-2: the executables' start-up refusals, through the real binaries (run from `dist`, as installed: build first,
 * `pnpm --filter @artblocks/abxfs-gateway build`).
 *
 *  - EVERY flag is checked before any chain is, so a bad flag is reported as itself whether or not a chain is deployed
 *    (it used to be hidden behind "not deployed", or thrown as a stack trace).
 *  - "Not deployed" (a chain the SDK registry has no addresses for) is ONE log line and exit 2, the same as the
 *    mirror's other start-up refusals. No stack trace, no per-chain notes before it. Every listed chain is deployed
 *    now, so that refusal is tested on synthetic registries in `chain-config.test.ts`, not through the binaries.
 *  - DELTA-3 L2: "every flag before any chain" holds for `--content-domain` too (a URL used to pass the flag checks and
 *    surface only as "not deployed", or later as a stack trace from `createGateway`), and an unknown flag, a stray
 *    argument and the mode choice are the same one-line refusal (they were a stack trace and exit 1, and two lines).
 *    A flag whose error does not name it (an unreadable list file) is named.
 *  - DELTA-4 I1: node's own refusal of a value that starts with a dash (`--port -1`, "argument is ambiguous") is three
 *    lines; it is one, like every other. I5: `--host`, `--cors` and `--base-path` are checked too, `--tag ""` is refused
 *    (it used to be dropped, so the "pinned" gateway followed latest), the mirror with no `--chain` refuses like any other
 *    start-up error (it printed the usage and exited 1), and a bad value taken from an environment variable is refused as
 *    that variable, not as the flag nobody passed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isCanonicallyDeployed } from "@artblocks/abxfs-sdk";

const BIN = resolve(__dirname, "../../dist/bin");
const built = existsSync(resolve(BIN, "gateway.js")) && existsSync(resolve(BIN, "mirror.js"));
const run = (bin: string, args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync(process.execPath, [resolve(BIN, bin), ...args], {
    encoding: "utf8",
    timeout: 30_000,
    // No RPC configured and none needed: every refusal here comes before a read. (An `undefined` is left unset.)
    env: {
      ...process.env,
      ABXFS_RPC_URL: "",
      ABXFS_CHAINS: "",
      ABXFS_PROJECT: "",
      ABXFS_CONTENT_DOMAIN: "",
      ABXFS_DENYLIST: "",
      ABXFS_ALLOWLIST: "",
      ABXFS_ALLOW_ORGS: "",
      ABXFS_ROOT_MAX_AGE: "",
      ABXFS_MAX_FILE_BYTES: "",
      ABXFS_CHAIN: undefined,
      PORT: undefined,
      HOST: undefined,
      PINATA_JWT: "",
      ...env,
    },
  });
const lines = (stderr: string) => stderr.split("\n").filter((l) => l.trim() !== "");
const STACK = /^\s+at /m;

/** The refusal is ONE line naming the problem, exit 2, no stack trace. */
function refusedWith(r: ReturnType<typeof run>, prefix: string, pattern: RegExp) {
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).not.toMatch(STACK);
  expect(lines(r.stderr)).toHaveLength(1);
  expect(lines(r.stderr)[0]!.startsWith(prefix), r.stderr).toBe(true);
  expect(r.stderr).toMatch(pattern);
}

describe.skipIf(!built)("abxfs-gateway: every flag before any chain", () => {
  it("--max-file-bytes", () => {
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--max-file-bytes", "lots"]), "[abxfs-gateway] NOT STARTED:", /--max-file-bytes expects a positive integer \(got "lots"\)/);
  });

  it("--root-max-age", () => {
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--root-max-age", "abc"]), "[abxfs-gateway] NOT STARTED:", /--root-max-age expects a whole number of seconds/);
  });

  it("--project, its --version, and --tag with --version", () => {
    refusedWith(run("gateway.js", ["--project", "base-sepolia/0x12/x"]), "[abxfs-gateway] NOT STARTED:", /--project expects <chain>\/<org>\/<id>/);
    const org = `0x${"a1".repeat(20)}`;
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--version", "abc"]), "[abxfs-gateway] NOT STARTED:", /--version expects a version number/);
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--version", "2", "--tag", "x"]), "[abxfs-gateway] NOT STARTED:", /mutually exclusive/);
  });

  it("--port and --chains", () => {
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--port", "http"]), "[abxfs-gateway] NOT STARTED:", /--port expects a port number/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--chains", "nope"]), "[abxfs-gateway] NOT STARTED:", /unknown chain "nope"/);
  });

  it("the mode choice: one line, exit 2, before any chain", () => {
    const none = run("gateway.js", []);
    refusedWith(none, "[abxfs-gateway] NOT STARTED:", /choose exactly one of --content-domain <host> \(recommended\), --project <chain>\/<org>\/<id>, or --path-mode/);
    expect(none.stderr).not.toMatch(/not deployed/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--path-mode"]), "[abxfs-gateway] NOT STARTED:", /choose exactly one/);
  });

  // DELTA-3 L2: these each used to reach "not deployed" first (so the bad value surfaced only once a chain was), or end
  // in a stack trace and exit 1.
  it("--content-domain that is a URL, not a bare host, names the flag", () => {
    refusedWith(
      run("gateway.js", ["--content-domain", "https://bad.example/"]),
      "[abxfs-gateway] NOT STARTED:",
      /--content-domain must be a bare host \(and optional port\), got "https:\/\/bad\.example\/"/,
    );
    expect(run("gateway.js", ["--content-domain", "https://bad.example/"]).stderr).not.toMatch(/not deployed/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example/path"]), "[abxfs-gateway] NOT STARTED:", /--content-domain must be a bare host/);
  });

  it("an unknown flag, a stray argument and a flag without its value", () => {
    refusedWith(run("gateway.js", ["--content-domian", "c.example"]), "[abxfs-gateway] NOT STARTED:", /Unknown option '--content-domian'/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "extra"]), "[abxfs-gateway] NOT STARTED:", /Unexpected argument 'extra'/);
    refusedWith(run("gateway.js", ["--content-domain"]), "[abxfs-gateway] NOT STARTED:", /--content-domain <value>' argument missing/);
  });

  it("--project with an unknown chain names the flag; --default-chain is gone, since every URL names its chain", () => {
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--default-chain", "base"]), "[abxfs-gateway] NOT STARTED:", /Unknown option '--default-chain'/);
    refusedWith(run("gateway.js", ["--project", `nope/0x${"a1".repeat(20)}/3`]), "[abxfs-gateway] NOT STARTED:", /NOT STARTED: --project: unknown chain "nope"$/m);
    // Named once, as the variable it came from (DELTA-8: a doubled "--project: --project:" passed an unanchored match).
    refusedWith(run("gateway.js", [], { ABXFS_PROJECT: `nope/0x${"a1".repeat(20)}/3` }), "[abxfs-gateway] NOT STARTED:", /NOT STARTED: ABXFS_PROJECT: unknown chain "nope"$/m);
  });

  it("--deny, --allow and --allow-orgs with a file that cannot be read, or an address list with a bad entry", () => {
    for (const flag of ["--deny", "--allow", "--allow-orgs"]) {
      refusedWith(
        run("gateway.js", ["--content-domain", "c.example", flag, "/nonexistent/abxfs-list.txt"]),
        "[abxfs-gateway] NOT STARTED:",
        new RegExp(`${flag}: ENOENT: no such file or directory, stat '/nonexistent/abxfs-list.txt'`),
      );
    }
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--allow-orgs", "0x12,0x34"]), "[abxfs-gateway] NOT STARTED:", /--allow-orgs: "0x12" is not an address/);
  });

  // DELTA-4 I1: node says these in three lines; the refusal is still one.
  it("a value that starts with a dash (node's 'argument is ambiguous') is one line", () => {
    for (const flag of ["--root-max-age", "--port"]) {
      refusedWith(
        run("gateway.js", ["--content-domain", "c.example", flag, "-1"]),
        "[abxfs-gateway] NOT STARTED:",
        new RegExp(`Option '${flag}' argument is ambiguous\\. Did you forget to specify the option argument for '${flag}'\\? To specify an option argument starting with a dash use '${flag}=-XYZ'\\.$`, "m"),
      );
    }
    // The spelling it suggests reaches the flag's own check.
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--root-max-age=-1"]), "[abxfs-gateway] NOT STARTED:", /--root-max-age expects a whole number of seconds \(got "-1"\)/);
  });

  // DELTA-4 I5: every flag, as the README says.
  it("--host, --cors and --base-path", () => {
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--host", "bad host"]), "[abxfs-gateway] NOT STARTED:", /--host expects an IP address or a host name to listen on.*\(got "bad host"\)/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--host", "http://0.0.0.0"]), "[abxfs-gateway] NOT STARTED:", /--host expects/);
    // An origin with a path or a trailing slash matches no browser's Origin: the setting would silently do nothing.
    for (const cors of ["https://app.example/", "app.example", "https://app.example/x", "*, https://a.example"]) {
      refusedWith(run("gateway.js", ["--content-domain", "c.example", "--cors", cors]), "[abxfs-gateway] NOT STARTED:", /--cors expects "\*" or one origin/);
    }
    for (const base of ["g", "/", "/g?x", "/a b"]) {
      refusedWith(run("gateway.js", ["--path-mode", "--base-path", base]), "[abxfs-gateway] NOT STARTED:", /--base-path expects a path such as \/g/);
    }
  });

  it("good --host, --cors and --base-path values pass their checks (and the refusal is the next one: no chain deployed, or the mode)", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "::", "::1", "localhost", "gw.internal"]) {
      expect(run("gateway.js", ["--content-domain", "c.example", "--host", host, "--chains", "nope"]).stderr).toMatch(/--chains: unknown chain "nope"/);
    }
    for (const cors of ["*", "https://app.example", "http://localhost:3000"]) {
      expect(run("gateway.js", ["--content-domain", "c.example", "--cors", cors, "--chains", "nope"]).stderr).toMatch(/--chains: unknown chain "nope"/);
    }
    expect(run("gateway.js", ["--path-mode", "--base-path", "/abxfs/g/", "--chains", "nope"]).stderr).toMatch(/--chains: unknown chain "nope"/);
  });

  it('--tag "" and a tag no project can have are refused (an empty one was dropped, and the gateway followed latest)', () => {
    const org = `0x${"a1".repeat(20)}`;
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--tag", ""]), "[abxfs-gateway] NOT STARTED:", /--tag expects a tag name such as v1\.2\.0 \(got ""\)$/m);
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--tag", "Latest"]), "[abxfs-gateway] NOT STARTED:", /--tag expects a tag name such as v1\.2\.0 \(got "Latest"\): Use only lowercase/);
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--tag", "latest"]), "[abxfs-gateway] NOT STARTED:", /"latest" is reserved/);
    refusedWith(run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--tag", "", "--version", "2"]), "[abxfs-gateway] NOT STARTED:", /mutually exclusive/);
  });

  it("a bad value from an environment variable is refused as that variable, and a flag given beats it", () => {
    refusedWith(
      run("gateway.js", [], { ABXFS_CONTENT_DOMAIN: "https://bad.example/" }),
      "[abxfs-gateway] NOT STARTED:",
      /^\[abxfs-gateway\] NOT STARTED: ABXFS_CONTENT_DOMAIN must be a bare host \(and optional port\), got "https:\/\/bad\.example\/"$/m,
    );
    refusedWith(run("gateway.js", ["--content-domain", "c.example"], { ABXFS_ROOT_MAX_AGE: "soon" }), "[abxfs-gateway] NOT STARTED:", /ABXFS_ROOT_MAX_AGE expects a whole number of seconds/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example"], { PORT: "http" }), "[abxfs-gateway] NOT STARTED:", /PORT expects a port number/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example"], { HOST: "bad host" }), "[abxfs-gateway] NOT STARTED:", /HOST expects an IP address/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example"], { ABXFS_DENYLIST: "/nonexistent/abxfs-list.txt" }), "[abxfs-gateway] NOT STARTED:", /ABXFS_DENYLIST: ENOENT/);
    refusedWith(run("gateway.js", [], { ABXFS_PROJECT: "base-sepolia/0x12/x" }), "[abxfs-gateway] NOT STARTED:", /ABXFS_PROJECT expects <chain>\/<org>\/<id>/);
    // The flag, given, is what the refusal names, whatever the environment says.
    const flagged = run("gateway.js", ["--content-domain", "c.example", "--root-max-age", "soon"], { ABXFS_ROOT_MAX_AGE: "60" });
    refusedWith(flagged, "[abxfs-gateway] NOT STARTED:", /--root-max-age expects a whole number of seconds \(got "soon"\)/);
    expect(flagged.stderr).not.toMatch(/ABXFS_ROOT_MAX_AGE/);
  });

  // DELTA-5 I-5: a pin of nothing, and a chain list that names no chain, were silently ignored.
  it("--tag or --version without --project, and a chain list that names no chain, are refused", () => {
    for (const pin of [["--tag", "stable"], ["--version", "2"]]) {
      refusedWith(run("gateway.js", ["--content-domain", "c.example", ...pin]), "[abxfs-gateway] NOT STARTED:", new RegExp(`${pin[0]} pins --project, and no project is given`));
    }
    refusedWith(run("gateway.js", ["--content-domain", "c.example", "--chains", ","]), "[abxfs-gateway] NOT STARTED:", /--chains expects chains, comma separated: .* \(got ","\)/);
    refusedWith(run("gateway.js", ["--content-domain", "c.example"], { ABXFS_CHAINS: " , " }), "[abxfs-gateway] NOT STARTED:", /ABXFS_CHAINS expects chains/);
  });

  // DELTA-6 I-2: `--project base,ethereum/…` took Base.
  it("--project names one chain", () => {
    const org = `0x${"a1".repeat(20)}`;
    refusedWith(run("gateway.js", ["--project", `base,ethereum/${org}/3`]), "[abxfs-gateway] NOT STARTED:", /--project expects one chain: .* \(got "base,ethereum"\)$/m);
    refusedWith(run("gateway.js", [], { ABXFS_PROJECT: `base,ethereum/${org}/3` }), "[abxfs-gateway] NOT STARTED:", /ABXFS_PROJECT expects one chain/);
    refusedWith(run("gateway.js", ["--project", `/${org}/3`]), "[abxfs-gateway] NOT STARTED:", /--project expects <chain>\/<org>\/<id>/);
  });
});

describe.skipIf(!built)("abxfs-mirror: every flag before the chain", () => {
  it("the limits, --provider and --chain", () => {
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--max-root-bytes", "0"]), "[mirror] NOT STARTED:", /--max-root-bytes must be a positive integer/);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--max-roots-per-run", "x"]), "[mirror] NOT STARTED:", /--max-roots-per-run must be a positive integer/);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--provider", "nope"]), "[mirror] NOT STARTED:", /unknown provider "nope"/);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--provider", "pinata"]), "[mirror] NOT STARTED:", /pinata needs the PINATA_JWT/);
    refusedWith(run("mirror.js", ["--chain", "nope"]), "[mirror] NOT STARTED:", /NOT STARTED: --chain: unknown chain "nope"$/m);
  });

  it("--poll-seconds, --deny and an unknown flag (DELTA-3 L2)", () => {
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--poll-seconds", "0"]), "[mirror] NOT STARTED:", /--poll-seconds must be a positive number of seconds/);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--poll-seconds", "soon"]), "[mirror] NOT STARTED:", /--poll-seconds must be a positive number/);
    refusedWith(
      run("mirror.js", ["--chain", "base-sepolia", "--deny", "/nonexistent/abxfs-list.txt"]),
      "[mirror] NOT STARTED:",
      /--deny: ENOENT: no such file or directory, stat '\/nonexistent\/abxfs-list.txt'/,
    );
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--bogus"]), "[mirror] NOT STARTED:", /Unknown option '--bogus'/);
  });

  it("--allow and --allow-orgs are named when their error does not name them", () => {
    refusedWith(
      run("mirror.js", ["--chain", "base-sepolia", "--allow", "/nonexistent/abxfs-list.txt"]),
      "[mirror] NOT STARTED:",
      /--allow: ENOENT: no such file or directory, stat '\/nonexistent\/abxfs-list.txt'/,
    );
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--allow-orgs", "0x12,0x34"]), "[mirror] NOT STARTED:", /--allow-orgs: "0x12" is not an address/);
    refusedWith(
      run("mirror.js", ["--chain", "base-sepolia", "--allow-orgs", "/nonexistent/abxfs-orgs.txt"]),
      "[mirror] NOT STARTED:",
      /--allow-orgs: ENOENT: no such file or directory/,
    );
  });

  // DELTA-4 I1 and I5.
  it("--poll-seconds -5 is one line; no --chain is a refusal (exit 2), not the usage; ABXFS_CHAIN is named as itself", () => {
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--poll-seconds", "-5"]), "[mirror] NOT STARTED:", /Option '--poll-seconds' argument is ambiguous\. Did you forget/);
    refusedWith(run("mirror.js", []), "[mirror] NOT STARTED:", /--chain is required \(or ABXFS_CHAIN\)/);
    refusedWith(run("mirror.js", ["--once"]), "[mirror] NOT STARTED:", /--chain is required/);
    refusedWith(run("mirror.js", [], { ABXFS_CHAIN: "nope" }), "[mirror] NOT STARTED:", /^\[mirror\] NOT STARTED: ABXFS_CHAIN: unknown chain "nope"$/m);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia"], { ABXFS_ALLOW_ORGS: "0x12,0x34" }), "[mirror] NOT STARTED:", /ABXFS_ALLOW_ORGS: "0x12" is not an address/);
  });

  // DELTA-5 I-5: " " read as no chain at all (a TypeError), and a list silently took its first chain.
  it("--chain must name exactly one chain, and --api-key's warning never precedes a refusal", () => {
    for (const c of [" ", ",", "base,base-sepolia"]) {
      refusedWith(run("mirror.js", ["--chain", c]), "[mirror] NOT STARTED:", /--chain expects one chain: .*base-sepolia.*, or a chain id \(got "/);
    }
    refusedWith(run("mirror.js", [], { ABXFS_CHAIN: " " }), "[mirror] NOT STARTED:", /^\[mirror\] NOT STARTED: ABXFS_CHAIN expects one chain/m);
    refusedWith(run("mirror.js", ["--chain", "base-sepolia", "--api-key", "k", "--max-root-bytes", "0"]), "[mirror] NOT STARTED:", /--max-root-bytes must be a positive integer/);
  });

  it("--help still prints the usage and exits 0", () => {
    const help = run("mirror.js", ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^abxfs-mirror --chain/);
  });
});

// Both chains deployed, so this gets past "not deployed": a project the gateway would not serve is refused, not started.
describe.skipIf(!built || ![84532, 421614].every((id) => isCanonicallyDeployed(id)))("--project and --chains", () => {
  it("refuses --chains that leave the project's own chain out", () => {
    const org = `0x${"a1".repeat(20)}`;
    refusedWith(
      run("gateway.js", ["--project", `base-sepolia/${org}/3`, "--chains", "arbitrum-sepolia", "--port", "0"]),
      "[abxfs-gateway] NOT STARTED:",
      /the project is on chain 84532, which is not among the chains this gateway serves/,
    );
  });
});
