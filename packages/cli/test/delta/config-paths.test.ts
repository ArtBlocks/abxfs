/**
 * `config.ts` branches the delta audit found untested: each shape `validateConfig` refuses, a file that is not a JSON
 * object, a trusted path that is a directory or cannot be stat'ed, `readCapped`'s cap and its EAGAIN, and the races
 * an untrusted `./.abxfs.json` is guarded against (it changes between the `lstat` and the `open`). The races are driven
 * deterministically through a hook on `node:fs`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Errno = NodeJS.ErrnoException;
const fsHook = vi.hoisted(() => ({
  lstat: undefined as undefined | ((path: string) => void),
  /** Stat predicates to answer for the cwd file instead of the real ones (its size and ids stay real). */
  lstatResult: undefined as undefined | Record<string, () => boolean>,
  open: undefined as undefined | ((path: string) => void),
  fstat: undefined as undefined | ((st: { dev: number; ino: number; isFile: () => boolean }) => unknown),
  read: undefined as undefined | (() => number | undefined),
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const isCwdConfig = (p: unknown) => String(p).endsWith(".abxfs.json");
  const lstatSync = ((p: string, ...rest: unknown[]) => {
    if (isCwdConfig(p)) fsHook.lstat?.(String(p));
    const st = (real.lstatSync as (...a: unknown[]) => import("node:fs").Stats)(p, ...rest);
    if (isCwdConfig(p) && fsHook.lstatResult) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, fsHook.lstatResult);
    return st;
  }) as typeof real.lstatSync;
  const openSync = ((p: string, ...rest: unknown[]) => {
    if (isCwdConfig(p)) fsHook.open?.(String(p));
    return (real.openSync as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof real.openSync;
  const fstatSync = ((fd: number, ...rest: unknown[]) => {
    const st = (real.fstatSync as (...a: unknown[]) => import("node:fs").Stats)(fd, ...rest);
    return fsHook.fstat ? (fsHook.fstat(st) ?? st) : st;
  }) as typeof real.fstatSync;
  const readSync = ((...args: unknown[]) => {
    const n = fsHook.read?.();
    if (n !== undefined) return n;
    return (real.readSync as (...a: unknown[]) => number)(...args);
  }) as typeof real.readSync;
  const mocked = { lstatSync, openSync, fstatSync, readSync };
  return { ...real, ...mocked, default: { ...real, ...mocked } };
});

import { loadConfig, MAX_CONFIG_BYTES, validateConfig } from "../../src/config.js";

const errno = (code: string, message = code): Errno => Object.assign(new Error(message), { code });
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");

const cwd0 = process.cwd();
const saved = { ...process.env };
let dir: string;
let warnings: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-cfgp-"));
  process.chdir(dir);
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "abxfs-cfgp-home-"));
  delete process.env["ABXFS_CONFIG"];
  fsHook.lstat = fsHook.open = fsHook.fstat = fsHook.read = fsHook.lstatResult = undefined;
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((...x) => void warnings.push(x.map(String).join(" ")));
});
afterEach(() => {
  process.chdir(cwd0);
  process.env = { ...saved };
  fsHook.lstat = fsHook.open = fsHook.fstat = fsHook.read = fsHook.lstatResult = undefined;
  vi.restoreAllMocks();
});

const warned = () => warnings.join("\n");
const cwdConfig = (body: unknown = { chains: {} }) => writeFileSync(join(dir, ".abxfs.json"), JSON.stringify(body));

describe("validateConfig refuses every malformed shape, naming it", () => {
  it.each<[string, unknown, RegExp]>([
    ["defaultChain not a string", { defaultChain: 7 }, /defaultChain must be a string/],
    ["chains not an object", { chains: [] }, /chains must be an object of chain entries/],
    ["chains a string", { chains: "base" }, /chains must be an object of chain entries/],
    ["a chain entry that is not an object", { chains: { x: 5 } }, /Refusing to load chain "x": its entry must be an object/],
    ["chainId not a positive integer", { chains: { x: { chainId: -1 } } }, /chainId must be a positive integer/],
    ["fallbackRpcUrls not an array", { chains: { x: { fallbackRpcUrls: "https://a.example" } } }, /fallbackRpcUrls must be an array of http\(s\) URLs/],
    ["a fallback that is not http(s)", { chains: { x: { fallbackRpcUrls: ["ftp://a.example"] } } }, /fallbackRpcUrls\[0\] must be an http\(s\) URL/],
    ["org not an address", { chains: { x: { org: "0x1234" } } }, /org must be an address/],
    ["fastLz not a boolean", { chains: { x: { fastLz: "no" } } }, /fastLz must be true or false/],
    ["defaultBundleGasBudget not a whole number", { chains: { x: { defaultBundleGasBudget: "12000000" } } }, /defaultBundleGasBudget must be a positive whole number/],
    ["addresses not an object", { chains: { x: { addresses: ["0x1"] } } }, /addresses must be an object/],
    ["previousGenerations not an array", { chains: { x: { addresses: { previousGenerations: {} } } } }, /addresses\.previousGenerations must be an array of objects/],
    ["previousGenerations of non-objects", { chains: { x: { addresses: { previousGenerations: ["0x1"] } } } }, /addresses\.previousGenerations must be an array of objects/],
    ["a generation's address that is not one", { chains: { x: { addresses: { previousGenerations: [{ orgFactory: "nope" }] } } } }, /addresses\.previousGenerations\[0\]\.orgFactory must be an address/],
    ["an address that is not one", { chains: { x: { addresses: { chunkStore: "0x12" } } } }, /addresses\.chunkStore must be an address/],
  ])("%s", (_what, cfg, re) => {
    expect(() => validateConfig(cfg as never, "f.json")).toThrow(re);
  });

  it.each(["__proto__", "constructor", "prototype"])("a chain named %s", (k) => {
    const cfg = JSON.parse(`{"chains":{"${k}":{"chainId":1}}}`);
    expect(() => validateConfig(cfg, "f.json")).toThrow(/is not a valid chain name/);
  });

  it("unknown keys are reported, never fatal, at every level (a generation's included)", () => {
    validateConfig(
      { chains: { x: { addresses: { chunkStore: a(1), mystery: a(2), previousGenerations: [{ orgFactory: a(3), extra: a(4) }] } } } } as never,
      "f.json",
    );
    expect(warned()).toMatch(/unknown key "chains\.x\.addresses\.mystery" \(ignored\)/);
    expect(warned()).toMatch(/unknown key "chains\.x\.addresses\.previousGenerations\[0\]\.extra"/);
  });
});

describe("a trusted file (ABXFS_CONFIG) that is not a config is an error", () => {
  it.each([["[]"], ["null"], ["42"], ['"text"']])("%s is not a JSON object", (text) => {
    const p = join(dir, "cfg.json");
    writeFileSync(p, text);
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/Refusing to load .*cfg\.json: expected a JSON object/);
  });

  it("a directory", () => {
    const p = join(dir, "cfgdir");
    mkdirSync(p);
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/it is a directory, not a config file/);
  });

  it("a path that cannot be stat'ed for a reason other than 'no such file' (a file used as a directory)", () => {
    writeFileSync(join(dir, "plain"), "x");
    process.env["ABXFS_CONFIG"] = join(dir, "plain", "config.json");
    expect(() => loadConfig()).toThrow(/ENOTDIR/);
  });

  it("a regular file bigger than the cap is refused from its size, before it is read", () => {
    const p = join(dir, "big.json");
    writeFileSync(p, " ".repeat(MAX_CONFIG_BYTES + 1));
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/big\.json: it is larger than 256 KiB, which no config file needs/);
  });

  it("a chain entry with no chainId, for a name the CLI does not know", () => {
    const p = join(dir, "cfg.json");
    writeFileSync(p, JSON.stringify({ chains: { mine: { rpcUrl: "http://127.0.0.1:8545" } } }));
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/Refusing to load chain "mine": chainId is required/);
  });

  it("an endless stream (a link to /dev/zero) is cut off at the cap, never held whole", () => {
    const p = join(dir, "zero.json");
    symlinkSync("/dev/zero", p);
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(new RegExp(`is larger than ${MAX_CONFIG_BYTES / 1024} KiB, which no config file needs`));
  });
});

describe("an untrusted ./.abxfs.json that is not a regular file is skipped, naming what it is", () => {
  it("a directory", () => {
    mkdirSync(join(dir, ".abxfs.json"));
    loadConfig();
    expect(warned()).toMatch(/it is a directory, and only a regular file is read from the current directory/);
  });

  it("a symlink (even to a good config)", () => {
    writeFileSync(join(dir, "real.json"), JSON.stringify({ chains: {} }));
    symlinkSync(join(dir, "real.json"), join(dir, ".abxfs.json"));
    loadConfig();
    expect(warned()).toMatch(/it is a symlink, and only a regular file/);
  });

  it.skipIf(process.platform === "win32")("a FIFO (which once hung every command in the directory)", () => {
    const r = spawnSync("mkfifo", [join(dir, ".abxfs.json")]);
    if (r.status !== 0) return;
    loadConfig();
    expect(warned()).toMatch(/it is a FIFO, and only a regular file/);
  });

  it.skipIf(process.platform === "win32")("a socket", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(join(dir, ".abxfs.json"), r));
    try {
      loadConfig();
      expect(warned()).toMatch(/it is a socket, and only a regular file/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("a device (by its lstat, which only root can make for real)", () => {
    cwdConfig();
    const real = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false, isCharacterDevice: () => true, isBlockDevice: () => false };
    fsHook.lstatResult = real;
    loadConfig();
    expect(warned()).toMatch(/it is a device, and only a regular file/);
    fsHook.lstatResult = { ...real, isCharacterDevice: () => false };
    warnings.length = 0;
    loadConfig();
    expect(warned()).toMatch(/it is not a regular file, and only a regular file/);
  });
});

describe("an untrusted ./.abxfs.json that changes under the CLI is skipped, with the reason", () => {
  it("bigger than the cap", () => {
    writeFileSync(join(dir, ".abxfs.json"), " ".repeat(MAX_CONFIG_BYTES + 1));
    expect(() => loadConfig()).not.toThrow();
    expect(warned()).toMatch(/ignoring .*\.abxfs\.json \(in the current directory\): it is larger than 256 KiB/);
  });

  it("an lstat that fails for a reason other than 'no such file'", () => {
    cwdConfig();
    fsHook.lstat = () => {
      throw errno("EACCES", "EACCES: permission denied");
    };
    expect(() => loadConfig()).not.toThrow();
    expect(warned()).toMatch(/ignoring .*: EACCES: permission denied/);
  });

  it("swapped for a symlink between the lstat and the open (O_NOFOLLOW: ELOOP)", () => {
    cwdConfig();
    fsHook.open = () => {
      throw errno("ELOOP");
    };
    loadConfig();
    expect(warned()).toMatch(/it became a symlink while it was being read/);
  });

  it("an open that fails otherwise", () => {
    cwdConfig();
    fsHook.open = () => {
      throw errno("EMFILE", "EMFILE: too many open files");
    };
    loadConfig();
    expect(warned()).toMatch(/ignoring .*: EMFILE: too many open files/);
  });

  it("swapped for another file between the lstat and the open (another inode)", () => {
    cwdConfig();
    fsHook.fstat = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
    loadConfig();
    expect(warned()).toMatch(/it changed while it was being read/);
  });

  it("a read that would block (O_NONBLOCK on what became a FIFO) is no config", () => {
    cwdConfig();
    fsHook.read = () => {
      throw errno("EAGAIN");
    };
    loadConfig();
    expect(warned()).toMatch(/ignoring .*: not a regular file/);
  });

  it("a read error other than EAGAIN is skipped too, with its message", () => {
    cwdConfig();
    fsHook.read = () => {
      throw errno("EIO", "EIO: i/o error");
    };
    loadConfig();
    expect(warned()).toMatch(/ignoring .*: EIO: i\/o error/);
  });
});
