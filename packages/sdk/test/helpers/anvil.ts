import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Chain,
  type Hex,
  type HttpTransport,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { inject } from "vitest";

import type { ContractAddresses } from "../../src/types.js";

// Anvil default mnemonic account #0.
const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/**
 * How often a test client polls anvil, for a receipt above all. viem's default with no chain block time is 4 s, and
 * anvil answers `eth_sendRawTransaction` before it has mined a large transaction, so the first receipt check misses and
 * every such write waited a full 4 s: that was most of the SDK suite's 27 minutes. A client a test builds itself against
 * anvil, for writes, takes this too.
 */
export const ANVIL_POLLING_MS = 50;

/**
 * Ask the kernel for a free TCP port on 127.0.0.1 by binding a temporary listener to port 0
 * and reading the assigned port back before closing it.
 *
 * There is a small TOCTOU window between us closing the listener and anvil binding it. In
 * practice this is fine: anvil binds within ~50ms of spawn, and the kernel's port allocator
 * does not aggressively recycle a freshly-released port. The previous design — a hardcoded
 * port shared across packages — failed deterministically under `pnpm -r test`'s default
 * parallelism whenever two suites instantiated the harness at the same time, which was a
 * far worse failure mode than the theoretical race here.
 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        rejectFn(new Error("failed to read ephemeral port from listener"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveFn(port));
    });
  });
}

const REPO_ROOT = resolve(__dirname, "../../../..");
const CONTRACTS_CORE_DIR = resolve(REPO_ROOT, "packages/contracts-core");
const CONTRACTS_COMPANION_DIR = resolve(REPO_ROOT, "packages/contracts-companion");

export interface AnvilHarness {
  rpcUrl: string;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  /** Carries its account and chain, so `writeContract` needs neither per call. */
  walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  addresses: ContractAddresses;
  stop(): Promise<void>;
}

/** One deployment as `anvil_loadState` input, and the addresses it holds. */
export interface DeployedState {
  addresses: ContractAddresses;
  state: Hex;
}

/** What the global setup (`anvil-setup.ts`) deploys once per run: the content layer, and it with the companion. */
export interface Deployments {
  core: DeployedState;
  companion: DeployedState;
}

declare module "vitest" {
  export interface ProvidedContext {
    abxfsDeployments?: Deployments;
  }
}

export async function startAnvilWithAbxfs(opts: {
  deployCompanion?: boolean;
  /**
   * Extra anvil flags. `["--gas-limit", "16777216"]` makes the block, and with it every `eth_call` and estimate,
   * 2^24: a legacy chain's per-transaction cap. `["--gas-limit", "50000000"]` gives the 50M `eth_call` cap geth and
   * reth default to.
   */
  anvilArgs?: readonly string[];
} = {}): Promise<AnvilHarness> {
  // The deploy scripts ran once, in the global setup; each anvil loads their result. Running `forge script` here, once
  // per test file, kept files from running in parallel: concurrent runs share contracts-core's `cache/` and
  // `broadcast/`.
  const deployments = inject("abxfsDeployments");
  if (!deployments) {
    throw new Error("no deployment to load: list the SDK's test/helpers/anvil-setup.ts under globalSetup in vitest.config.ts");
  }
  const deployed = opts.deployCompanion ? deployments.companion : deployments.core;
  const { anvil, rpcUrl } = await spawnAnvil(opts.anvilArgs ?? []);

  // Never leave an anvil behind when the harness cannot be built: the caller has nothing to stop.
  try {
    await rpc(rpcUrl, "anvil_loadState", [deployed.state]);
    for (const [name, address] of Object.entries(deployed.addresses)) {
      if ((await rpc(rpcUrl, "eth_getCode", [address, "latest"])) === "0x") {
        throw new Error(`the loaded deployment has no code at ${name} ${address}`);
      }
    }

    const account = privateKeyToAccount(ANVIL_PK);
    const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: ANVIL_POLLING_MS });
    const walletClient = createWalletClient({
      chain: foundry,
      transport: http(rpcUrl),
      account,
      pollingInterval: ANVIL_POLLING_MS,
    });

    return {
      rpcUrl,
      account,
      publicClient,
      walletClient,
      addresses: { ...deployed.addresses },
      async stop() {
        anvil.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 100));
        if (!anvil.killed) anvil.kill("SIGKILL");
      },
    };
  } catch (err) {
    anvil.kill("SIGKILL");
    throw err;
  }
}

/**
 * Deploy the content layer with its real deploy script (`forge script`, CREATE2 through the keyless deployer), then the
 * IPFS CID resolver over it, and keep each result as anvil state. The global setup calls this once per run.
 */
export async function deployOnce(): Promise<Deployments> {
  const { anvil, rpcUrl } = await spawnAnvil([]);
  try {
    const core = await runForgeDeploy(CONTRACTS_CORE_DIR, rpcUrl);
    for (const k of ["ChunkStore", "Sstore2Backend", "FastLzSstore2Backend", "FileStore", "DirectoryStore"]) {
      if (!core[k]) throw new Error(`the core deploy did not emit ${k}`);
    }
    const addresses: ContractAddresses = {
      chunkStore: core.ChunkStore!,
      fileStore: core.FileStore!,
      directoryStore: core.DirectoryStore!,
      sstore2Backend: core.Sstore2Backend!,
      fastLzBackend: core.FastLzSstore2Backend!,
    };
    const coreState = await dumpAccounts(rpcUrl);

    const companion = await runForgeDeploy(CONTRACTS_COMPANION_DIR, rpcUrl, {
      FILE_STORE: addresses.fileStore,
      DIRECTORY_STORE: addresses.directoryStore,
    });
    if (!companion.IpfsCidResolver) throw new Error("the companion deploy did not emit IpfsCidResolver");

    return {
      core: { addresses, state: coreState },
      companion: { addresses: { ...addresses, ipfsCidResolver: companion.IpfsCidResolver }, state: await dumpAccounts(rpcUrl) },
    };
  } finally {
    anvil.kill("SIGKILL");
  }
}

/**
 * The node's accounts as `anvil_loadState` input. The block fields are dropped: loading them would reset the block
 * environment, the gas limit included, to the dumping node's, overriding a harness's `--gas-limit`.
 */
async function dumpAccounts(rpcUrl: string): Promise<Hex> {
  const dumped = (await rpc(rpcUrl, "anvil_dumpState")) as Hex;
  const state = JSON.parse(gunzipSync(Buffer.from(dumped.slice(2), "hex")).toString("utf8")) as Record<string, unknown>;
  return toHex(
    JSON.stringify({ ...state, block: null, best_block_number: null, blocks: [], transactions: [], historical_states: null }),
  );
}

async function spawnAnvil(args: readonly string[]): Promise<{ anvil: ChildProcess; rpcUrl: string }> {
  // Ephemeral port per harness so multiple suites (sdk, cli, …) can run in parallel
  // under `pnpm -r test` without colliding. Do NOT replace this with a shared constant —
  // see `.cursor/rules/test-harnesses.mdc`.
  const port = await pickFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil = spawn(
    "anvil",
    [
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      // The contracts target Cancun EVM (mcopy, etc.). Pin anvil's hardfork so contracts run against the
      // same feature set regardless of foundry defaults. Anvil pre-deploys the keyless CREATE2 deployer
      // (0x4e59…) that every deploy script goes through.
      "--hardfork",
      "cancun",
      "--silent",
      ...args,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const errChunks: string[] = [];
  anvil.stderr?.on("data", (c) => errChunks.push(c.toString()));
  try {
    await waitForAnvil(rpcUrl, 10_000);
  } catch (err) {
    anvil.kill("SIGKILL");
    throw new Error(`${(err as Error).message}\n${errChunks.join("")}`);
  }
  return { anvil, rpcUrl };
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function waitForAnvil(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "web3_clientVersion", id: 1 }),
      });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start at ${url}`);
}

type AddressMap = Record<string, `0x${string}`>;

async function runForgeDeploy(
  cwd: string,
  rpcUrl: string,
  extraEnv: Record<string, string> = {},
  script = "script/Deploy.s.sol",
): Promise<AddressMap> {
  return new Promise((resolveFn, rejectFn) => {
    const env = {
      ...process.env,
      ...extraEnv,
    };
    const proc = spawn(
      "forge",
      [
        "script",
        script,
        "--rpc-url",
        rpcUrl,
        "--private-key",
        ANVIL_PK,
        "--broadcast",
        "--slow",
        "-vvv",
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    const out: string[] = [];
    const err: string[] = [];
    proc.stdout?.on("data", (c) => out.push(c.toString()));
    proc.stderr?.on("data", (c) => err.push(c.toString()));

    // A forge that cannot be spawned (not on PATH) emits only `error`, never `exit`: without this the deploy never settles.
    proc.on("error", rejectFn);
    proc.on("exit", (code) => {
      if (code !== 0) {
        rejectFn(
          new Error(
            `forge script failed (exit ${code})\nSTDOUT:\n${out.join("")}\nSTDERR:\n${err.join("")}`,
          ),
        );
        return;
      }
      try {
        resolveFn(parseForgeAddresses(out.join("")));
      } catch (e) {
        rejectFn(e as Error);
      }
    });
  });
}

/** Parse lines like `  ChunkStore 0x…` emitted by the Deploy scripts. */
function parseForgeAddresses(output: string): AddressMap {
  const addrs: AddressMap = {};
  const re = /^\s*(ChunkStore|Sstore2Backend|FastLzSstore2Backend|FileStore|DirectoryStore|IpfsCidResolver)\s+(0x[a-fA-F0-9]{40})/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    addrs[m[1]!] = m[2]! as `0x${string}`;
  }
  return addrs;
}

/**
 * Deploy a contract from contracts-core's forge artifacts (`out/<file>/<contract>.json`), e.g. the test mocks in
 * `test/mocks/Backends.sol`. The artifacts exist after `forge build` in `packages/contracts-core`, which CI and the root
 * `pnpm run test` run first: `forge script` (forge 1.4.3, the pinned version) compiles only the script's own sources.
 */
export async function deployCoreArtifact(
  h: AnvilHarness,
  file: string,
  contract: string,
): Promise<`0x${string}`> {
  const artifact = JSON.parse(readFileSync(resolve(CONTRACTS_CORE_DIR, "out", file, `${contract}.json`), "utf8")) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };
  const hash = await h.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  const receipt = await h.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploying ${contract} failed`);
  return receipt.contractAddress;
}

/** Whether anvil and forge are on PATH: without them the global setup deploys nothing. */
export function hasFoundry(): boolean {
  return spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
}
