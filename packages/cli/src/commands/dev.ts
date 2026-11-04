/**
 * `abxfs dev` — spin up a local Anvil + deploy the content layer (and optionally the org layer and the IPFS CID
 * resolver).
 *
 * Enforces the NO-PUBLIC-DEPLOY rule: Anvil is always a local dev chain. The deploy key is anvil's well-known
 * account #0, so before forge is given it the CLI makes sure the node it would talk to is the anvil it just started:
 * the port was free before the spawn, the child is still running when the RPC answers, the node says it is anvil
 * (`web3_clientVersion`), and its chain id is the one asked for. Anything else stops the command, and anvil is
 * killed on every way out, a SIGINT or a SIGTERM included (a forge script in flight is stopped too): a signal's
 * default would end the CLI at once and leave anvil running on its port, holding a key everyone knows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";

import { Command } from "commander";
import kleur from "kleur";

import { safe } from "../text.js";

/**
 * `forge script` runs the Solidity project in the working directory, and a Foundry project can execute
 * arbitrary commands (`ffi`, `foundry.toml` hooks), so `abxfs dev` is a way to run a stranger's code if it is
 * pointed at the wrong directory. A `package.json` name is trivially spoofable and so is a directory marker,
 * so neither is trusted on its own: the operator must say, with `--i-trust-this-dir`, that THIS directory is
 * an ABX FS checkout they trust, and it must also carry the marker (packages/contracts-core).
 */
export function assertAbxfsCheckout(trusted: boolean, cwd: string = process.cwd()): void {
  if (!trusted) {
    throw new Error(
      "refusing to run: `abxfs dev` builds and runs Solidity (forge scripts can run arbitrary commands) from the " +
        "current directory. cd into an ABX FS checkout YOU trust and pass --i-trust-this-dir.",
    );
  }
  if (!existsSync(resolve(cwd, "packages/contracts-core"))) {
    throw new Error(
      "refusing to run: this directory has no packages/contracts-core, so it is not an ABX FS checkout. cd into the abxfs repo.",
    );
  }
}

/** Only what anvil/forge need. Never ABXFS_PRIVATE_KEY, PINATA_JWT or any other secret. */
function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SHELL", "LANG", "TERM", "SYSTEMROOT", "USERPROFILE", "FOUNDRY_DIR"]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...extra, FOUNDRY_FFI: "false" };
}

/** `--port`: a whole number from 1 to 65535. */
export function parsePort(raw: string): number {
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) throw new Error(`--port must be a whole number from 1 to 65535 (got "${safe(raw)}")`);
  return Number(raw);
}

/** `--chain-id`: a positive whole number. */
export function parseChainId(raw: string): number {
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--chain-id must be a positive whole number (got "${safe(raw)}")`);
  }
  return Number(raw);
}

/**
 * Refuse a port something already listens on. Otherwise anvil fails to bind and exits, and the "ready" check would
 * find the OTHER process answering, which then receives a deploy signed with a known key.
 */
export async function assertPortFree(port: number, host = "127.0.0.1"): Promise<void> {
  await new Promise<void>((res, rej) => {
    const srv = createServer();
    srv.once("error", (e: NodeJS.ErrnoException) =>
      rej(
        new Error(
          e.code === "EADDRINUSE"
            ? `refusing to start: something already listens on ${host}:${port}. Stop it, or pick another --port.`
            : `cannot use ${host}:${port}: ${e.message}`,
        ),
      ),
    );
    srv.listen(port, host, () => srv.close(() => res()));
  });
}

async function rpc(url: string, method: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "error"}`);
  return body.result;
}

/**
 * Wait (at most `timeoutMs`, each attempt bounded too) until the node at `url` answers, then check it is the anvil
 * that was just started: the child has not exited, `web3_clientVersion` says anvil, and the chain id is `chainId`.
 */
export async function waitForAnvil(url: string, child: Pick<ChildProcess, "exitCode" | "signalCode">, chainId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no answer";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`anvil exited (${child.exitCode ?? child.signalCode}) before it was ready`);
    }
    try {
      const version = await rpc(url, "web3_clientVersion", 2_000);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`anvil exited (${child.exitCode ?? child.signalCode}), yet something answers at ${url}: refusing to deploy to it`);
      }
      if (typeof version !== "string" || !/^anvil\//i.test(version)) {
        throw new Error(`the node at ${url} is not anvil (web3_clientVersion: ${safe(String(version)).slice(0, 80)}): refusing to deploy to it`);
      }
      const id = Number(BigInt(String(await rpc(url, "eth_chainId", 2_000))));
      if (id !== chainId) throw new Error(`the anvil at ${url} has chain id ${id}, not ${chainId}: refusing to deploy to it`);
      return;
    } catch (e) {
      if (/refusing|exited/.test((e as Error).message)) throw e;
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for anvil at ${url} (${safe(lastErr)})`);
}

export function devCommand(): Command {
  return new Command("dev")
    .description("Run a local Anvil chain and deploy ABX FS contracts (local only: it takes no --chain)")
    .option("--port <port>", "Anvil port", "8545")
    .option("--chain-id <id>", "Anvil chain id", "31337")
    .option("--i-trust-this-dir", "required: confirm the current directory is an ABX FS checkout you trust (forge scripts run code from it)")
    .option("--companion", "also deploy the on-chain IPFS CID resolver")
    .option("--out <file>", "write deployed addresses to this JSON file", ".abxfs/dev-chain.json")
    .action(async (opts: { port: string; chainId: string; companion?: boolean; out: string; iTrustThisDir?: boolean }) => {
      assertAbxfsCheckout(opts.iTrustThisDir === true);
      const port = parsePort(opts.port);
      const chainId = parseChainId(opts.chainId);
      const coreDir = resolve(process.cwd(), "packages/contracts-core");
      const companionDir = resolve(process.cwd(), "packages/contracts-companion");
      const projectsDir = resolve(process.cwd(), "packages/contracts-projects");

      await assertPortFree(port);

      console.log(kleur.cyan("→"), `starting Anvil on :${port} (chainId=${chainId})`);
      const anvil = spawn(
        "anvil",
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--chain-id",
          String(chainId),
          // ABX FS contracts compile against the Cancun EVM (mcopy, etc.). Pin the hardfork
          // so dev works identically to unit tests regardless of anvil's default.
          "--hardfork",
          "cancun",
          "--silent",
        ],
        { stdio: ["ignore", "inherit", "inherit"], env: minimalEnv() },
      );
      const spawnError = new Promise<never>((_, rej) => anvil.once("error", (e) => rej(new Error(`could not start anvil: ${e.message}`))));
      spawnError.catch(() => undefined);
      anvil.on("exit", (code) => {
        if (code !== null && code !== 0) console.log(kleur.red(`anvil exited with ${code}`));
      });

      const stop = () => {
        if (anvil.exitCode === null && anvil.signalCode === null) anvil.kill("SIGINT");
      };
      // Ctrl-C reaches anvil and forge too (they share the terminal's process group); SIGTERM, from a supervisor or a
      // `kill`, reaches only this process, and its default would end it here and orphan anvil. Either one stops every
      // child and then lets the command finish through `finally`.
      const forges = new Set<ChildProcess>();
      let signalled: NodeJS.Signals | undefined;
      let wake: (() => void) | undefined;
      const onSignal = (sig: NodeJS.Signals) => {
        signalled = sig;
        for (const f of forges) if (f.exitCode === null && f.signalCode === null) f.kill("SIGTERM");
        stop();
        wake?.();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        const rpcUrl = `http://127.0.0.1:${port}`;
        await Promise.race([waitForAnvil(rpcUrl, anvil, chainId, 30_000), spawnError]);
        console.log(kleur.green("✓"), "Anvil ready");

        const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil #0

        // The content layer goes through the keyless CREATE2 deployer anvil ships with, so a dev chain gets the same
        // addresses as every real one, and with them the same chunk ids and CIDs.
        const core = await forgeDeploy(coreDir, "script/Deploy.s.sol:Deploy", rpcUrl, pk, {}, forges);
        const req = (key: string): string => {
          const v = core[key];
          if (!v) throw new Error(`forge deploy did not emit address for ${key}`);
          return v;
        };
        const addresses: Record<string, string> = {
          chunkStore: req("ChunkStore"),
          sstore2Backend: req("Sstore2Backend"),
          fastLzBackend: req("FastLzSstore2Backend"),
          fileStore: req("FileStore"),
          directoryStore: req("DirectoryStore"),
        };

        // The org layer runs on ABX, which a fresh anvil does not have: deploy it only when the ABX addresses are given,
        // and say so otherwise instead of failing the whole command. (Not exercised in CI: no local chain has ABX.)
        if (!process.env.ABX_SERIES_CODE_FACTORY) {
          console.log(kleur.yellow("!"), "No ABX_SERIES_CODE_FACTORY in the environment: content stores only, no org layer.");
        } else if (existsSync(projectsDir)) {
          const projects = await forgeDeploy(
            projectsDir,
            "script/Deploy.s.sol:DeployProjects",
            rpcUrl,
            pk,
            {
              ABXFS_DIRECTORY_STORE: addresses["directoryStore"]!,
              ABXFS_FILE_STORE: addresses["fileStore"]!,
              // The ABX addresses come from the caller's environment (a fork has them); a local chain is not in the
              // script's allow-table and its gateway is local, so both escape hatches are explicit here.
              ABX_SERIES_CODE_FACTORY: process.env.ABX_SERIES_CODE_FACTORY,
              ABX_METADATA_RENDERER: process.env.ABX_METADATA_RENDERER ?? "",
              ABX_SEED_SOURCE: process.env.ABX_SEED_SOURCE ?? "",
              ABXFS_GATEWAY_BASE: process.env.ABXFS_GATEWAY_BASE ?? "https://localhost",
              ABXFS_ALLOW_UNLISTED_CHAIN: "1",
              ABXFS_ALLOW_UNLISTED_GATEWAY: "1",
            },
            forges,
          );
          // The script logs the factory, the lens, and what the factory deployed (`hook`, `enumeration`, `minter`, ...).
          const names: Record<string, string> = {
            OrgFactory: "orgFactory",
            OrgMeta: "orgMeta",
            Lens: "lens",
            hook: "projectHook",
            enumeration: "projectEnumeration",
            minter: "orgMinter",
          };
          for (const [logged, key] of Object.entries(names)) if (projects[logged]) addresses[key] = projects[logged]!;
          if (!addresses["orgFactory"]) throw new Error("forge deploy did not emit the org factory address");
        }

        if (opts.companion && existsSync(companionDir)) {
          const comp = await forgeDeploy(
            companionDir,
            "script/Deploy.s.sol:Deploy",
            rpcUrl,
            pk,
            { FILE_STORE: addresses["fileStore"]!, DIRECTORY_STORE: addresses["directoryStore"]! },
            forges,
          );
          if (comp["IpfsCidResolver"]) addresses["ipfsCidResolver"] = comp["IpfsCidResolver"];
        }

        const outFile = resolve(opts.out);
        mkdirSync(dirname(outFile), { recursive: true });
        const manifest = {
          chains: {
            local: {
              chainId,
              rpcUrl,
              addresses,
            },
          },
          defaultChain: "local",
        };
        writeFileSync(outFile, JSON.stringify(manifest, null, 2));
        console.log(kleur.green("✓"), "addresses written to", safe(outFile));
        console.log(kleur.gray("press Ctrl-C to stop anvil"));

        await new Promise<void>((res) => {
          if (signalled || anvil.exitCode !== null || anvil.signalCode !== null) return res();
          wake = res;
          anvil.once("exit", () => res());
        });
        if (signalled) console.log(kleur.gray(`${signalled}: anvil stopped`));
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        stop();
      }
    });
}

async function forgeDeploy(
  cwd: string,
  target: string,
  rpc: string,
  pk: string,
  env: Record<string, string>,
  /** Holds the forge process while it runs, so a signal can stop it. */
  running: Set<ChildProcess>,
): Promise<Record<string, string>> {
  return new Promise((res, rej) => {
    const proc = spawn(
      "forge",
      [
        "script",
        target,
        "--rpc-url",
        rpc,
        "--private-key",
        pk,
        "--broadcast",
      ],
      { cwd, env: minimalEnv(env), stdio: ["ignore", "pipe", "inherit"] },
    );
    running.add(proc);
    let out = "";
    proc.once("error", (e) => (running.delete(proc), rej(new Error(`could not run forge: ${e.message}`))));
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("exit", (_code, signal) => {
      if (!signal) return;
      // Stopped: whatever it spawned may still hold its stdout open, which would keep this process alive. Its output
      // is no longer wanted.
      running.delete(proc);
      proc.stdout.destroy();
      rej(new Error(`forge script was stopped (${signal}); anvil was stopped`));
    });
    // `close`, not `exit`: only once its stdout has closed is every line it printed here to be parsed.
    proc.on("close", (code, signal) => {
      running.delete(proc);
      if (signal) return;
      if (code !== 0) return rej(new Error(`forge script failed (exit ${code}); anvil was stopped`));
      // The deploy scripts print `console2.log(name, addr)`, which forge shows under "== Logs ==" as `  Name 0x…`.
      // (`--json` cannot be combined with the quiet flag in current forge, and its log lines are the same text.)
      const addresses: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]?\s+(0x[0-9a-fA-F]{40})\s*$/);
        if (m) addresses[m[1]!] = m[2]!;
      }
      res(addresses);
    });
  });
}
