import type { Address, PublicClient } from "viem";
import {
  PAGE_MAX,
  ProjectKind,
  LimitExceededError,
  codecName,
  contentStores,
  entryCount,
  getChunkIdsPage,
  getEntriesPage,
  getFileInfo,
  hasFileCodec,
  locateByte,
  locateContent,
  entryNameBytes,
  readChunkSlices,
  readFile,
  readProject,
  readTag,
  readVersionHistory,
  resolvePath,
  PathNotResolvedError,
  type AbxfsCid,
  type ContractAddresses,
  type FileInfo,
  type OrgGeneration as OrgGen,
} from "@abxfs/sdk";

import { encodePathSegment, type Addressing } from "./addressing.js";
import { GatewayError } from "./errors.js";
import { servedType } from "./mime.js";
import type { GatewayChain } from "./types.js";
import { isRevert, lookupGeneration, readOrRevert, singleFlight, upstreamUnavailable } from "./upstream.js";

export { GatewayError } from "./errors.js";
export { parseGatewayPath, type Addressing } from "./addressing.js";
export { isActiveEssence, servedType, singleMimeEssence, type ServedType } from "./mime.js";

export interface ResolvedRequest {
  chain: GatewayChain;
  addressing: Addressing;
  rootCid: AbxfsCid;
  /** POSIX sub-path inside the root. Empty string means "the root itself". */
  subpath: string;
  /** The project's `abxfs.gateway`, when the request came through a project and one is set. */
  preferredGateway: string | null;
  /** Whether the root is a directory or a single file. */
  kind: ProjectKind;
}

/*
 * Per-instance caches in front of the two reads a request for a nonexistent project costs. Both are keyed
 * under the chain's own client object, so two chains (or two test fixtures) never share an entry.
 *
 *  - the factory's answer for an org: a registered org is registered FOREVER (the registry only
 *    appends), so a positive answer is held for a day; "not an org" is held for 5s, because the same
 *    address can be a factory-created org a moment later and a lagging RPC replica can say "no" about
 *    one that was created seconds ago.
 *  - a project that does not exist or has published nothing: 5s each (a mint or a publish followed by a
 *    visit must not wait on it, and a replica that has not seen the mint yet must not pin a 404).
 *
 * ONLY DEFINITIVE answers are cached. A read that was answered (`isOrg` returned false for every
 * generation; a call that REVERTED) is. A read that could not be completed (429, timeout, 5xx, abort) is
 * a retryable 503 and caches nothing: see `upstream.ts`.
 */
const POSITIVE_ORG_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_ORG_TTL_MS = 5_000;
const MISSING_PROJECT_TTL_MS = 5_000;
const UNPUBLISHED_TTL_MS = 5_000;
/** Seconds a shared cache may hold the 404 for a missing org or token (shorter than the gateway's default). */
const EDGE_MISSING_TTL_S = 5;
const CACHE_LIMIT = 5_000;

type OrgGeneration = OrgGen;
interface Timed<T> {
  value: T;
  until: number;
}
const orgCache = new WeakMap<object, Map<string, Timed<OrgGeneration | null>>>();
const projectMissCache = new WeakMap<object, Map<string, Timed<GatewayError>>>();
/** A root no store holds (a definitive `false` from both stores), held briefly: bots walk made-up roots. */
const rootMissCache = new WeakMap<object, Map<string, Timed<GatewayError>>>();
/** Files known to be over the size limit. A file's CID is immutable, so this stays true for as long as the limit does. */
const oversizeCache = new WeakMap<object, Map<string, Timed<GatewayError>>>();
/**
 * Files this gateway can never serve whatever the limit: stored with a codec it has no decoder for, or whose decoded
 * content does not hash to the `outputHash` its CID commits to. Both are facts about immutable bytes (the chain accepts
 * any non-zero codec label and hash for one SSTORE, so they are also cheap to manufacture): remembered, so a repeat
 * costs no RPC read at all.
 */
const undecodableCache = new WeakMap<object, Map<string, Timed<KnownRefusal>>>();
const UNDECODABLE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Briefly, a read whose chunks could not be read within the SDK's call budget (`LimitExceededError`, limit `calls`).
 * The SDK spends that budget only on calls the node ANSWERED (a revert, an out-of-gas result, a reply without one
 * result per chunk) and rethrows a failure of the connection at once, so a spent budget is a property of the file's
 * backend or of the node's gas cap and repeats on every request: each one would spend the whole budget again. Held for
 * {@link CALL_BUDGET_TTL_MS} only, because a node's cap can change.
 *
 * A map of its own, capped like every other: it is keyed per range as well as per CID, so a client can fill it with
 * ranges of one file, and in the map above that would evict the day-long codec and `outputHash` refusals.
 */
const callBudgetCache = new WeakMap<object, Map<string, Timed<KnownRefusal>>>();
const CALL_BUDGET_TTL_MS = 60_000;
/** Seconds a shared cache may hold a spent-call-budget refusal, whatever the URL. */
const CALL_BUDGET_EDGE_TTL_S = 60;
interface KnownRefusal {
  message: string;
  status: number;
  /** The most seconds a shared cache may hold it, below what the URL would allow. */
  edgeTtlCap?: number;
}
/**
 * What a root is (file or directory). Positive answers only, and held a long time: a root's CID commits to its bytes
 * and to the store it was created in (the CID domain prefixes are disjoint), so it never changes.
 */
const kindCache = new WeakMap<object, Map<string, Timed<ProjectKind>>>();
const KIND_TTL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_ROOT_TTL_MS = 5_000;
const OVERSIZE_TTL_MS = 24 * 60 * 60 * 1000;

/*
 * In-flight reads, shared. A cold cache under N concurrent visitors for one address costs one set of RPC reads
 * (not 50 `isOrg` calls for 50 visitors): the others wait on it. Entries
 * exist only while the work does, and are keyed under the chain's client like the caches above.
 */
const generationFlights = new WeakMap<object, Map<string, Promise<OrgGeneration | null>>>();
const projectFlights = new WeakMap<object, Map<string, Promise<ProjectResolution>>>();
const kindFlights = new WeakMap<object, Map<string, Promise<ProjectKind>>>();

function cacheFor<T>(store: WeakMap<object, Map<string, T>>, client: object): Map<string, T> {
  let m = store.get(client);
  if (!m) {
    m = new Map();
    store.set(client, m);
  }
  return m;
}

function remember<T>(m: Map<string, Timed<T>>, key: string, value: T, ttlMs: number): void {
  if (m.size >= CACHE_LIMIT) {
    // Bounded: a flood of distinct hosts must not grow this without end. Drop the oldest quarter.
    let drop = Math.ceil(CACHE_LIMIT / 4);
    for (const k of m.keys()) {
      m.delete(k);
      if (--drop <= 0) break;
    }
  }
  m.set(key, { value, until: Date.now() + ttlMs });
}

function recall<T>(m: Map<string, Timed<T>>, key: string): Timed<T> | undefined {
  const hit = m.get(key);
  if (!hit) return undefined;
  if (hit.until <= Date.now()) {
    m.delete(key);
    return undefined;
  }
  return hit;
}

/** Bumped by tests to make every earlier entry unreachable (a WeakMap cannot be cleared). */
let resetEpoch = 0;

/** Testing seam: forget every cached org and project answer. */
export function __resetResolveCaches(): void {
  resetEpoch++;
}

async function cachedGeneration(chain: GatewayChain, org: Address): Promise<OrgGeneration | null> {
  const m = cacheFor(orgCache, chain.client);
  const key = `${resetEpoch}:${chain.id}:${org.toLowerCase()}`;
  const hit = recall(m, key);
  if (hit) return hit.value;
  return singleFlight(cacheFor(generationFlights, chain.client), key, async () => {
    const looked = await lookupGeneration(chain.client, chain.contracts, org);
    // Some factory could not be asked and none of the others said yes: that is "unknown", not "no".
    if (!looked.found && looked.unknown) throw upstreamUnavailable();
    const generation = looked.found ?? null;
    remember(m, key, generation, generation ? POSITIVE_ORG_TTL_MS : NEGATIVE_ORG_TTL_MS);
    return generation;
  });
}

/** What a project URL resolved to, before the request's own sub-path is attached. */
interface ProjectResolution {
  rootCid: AbxfsCid;
  preferredGateway: string | null;
  kind: ProjectKind;
}

/** Resolve an addressing mode to a concrete root CID plus the project context around it. */
export async function resolveRoot(
  chain: GatewayChain,
  addressing: Addressing,
  subpath: string,
): Promise<ResolvedRequest> {
  if (addressing.kind === "cid") {
    return {
      chain,
      addressing,
      rootCid: addressing.rootCid,
      subpath,
      preferredGateway: null,
      kind: await probeKind(chain, addressing.rootCid),
    };
  }
  // The same project asked for by many visitors at once is read once.
  const key = `${resetEpoch}:${chain.id}:${addressing.org.toLowerCase()}:${addressing.tokenId}:${
    addressing.kind === "tag" ? `tag:${addressing.tag}` : addressing.kind === "version" ? `v:${addressing.version}` : "latest"
  }`;
  const resolved = await singleFlight(cacheFor(projectFlights, chain.client), key, () => resolveProject(chain, addressing));
  return { chain, addressing, subpath, ...resolved };
}

async function resolveProject(
  chain: GatewayChain,
  addressing: Exclude<Addressing, { kind: "cid" }>,
): Promise<ProjectResolution> {
  const client = chain.client;

  // The org must be one the factory created. Without this, anyone could deploy a contract that
  // answers `tokenParam` with any root and have a gateway serve it under a project URL, outside
  // every filter subject we can derive from the path. An address the factory does not know is a
  // 404, the same as a project that does not exist.
  //
  // "Created by the factory" means ANY generation of it: a superseded factory's orgs are frozen
  // against that factory's hook, so they are read through that hook and keep resolving.
  const missKey = `${resetEpoch}:${chain.id}:${addressing.org.toLowerCase()}:${addressing.tokenId}`;
  const misses = cacheFor(projectMissCache, client);
  const missed = recall(misses, missKey);
  if (missed) throw missed.value;

  const generation = await cachedGeneration(chain, addressing.org);
  if (!generation) {
    throw new GatewayError(`${addressing.org} is not an org on chain ${chain.id}`, 404, true, EDGE_MISSING_TTL_S);
  }
  const project = { collection: addressing.org, hook: generation.projectHook };

  // Every lookup below reverts on-chain for something that simply does not exist — an unminted
  // token, an unknown tag, a version past the end. Those are 404s, and getting it wrong is not
  // cosmetic: a 502 tells clients OUR upstream is broken, so they back off and retry, caches refuse
  // to store the response, and monitoring reads ordinary probing of nonexistent projects as an
  // outage. Translate at the boundary rather than letting the route's catch-all guess.
  //
  // Only a REVERT means "does not exist". A transport failure (429, timeout, 5xx) says nothing about the
  // token, and is a retryable 503 that nothing remembers.
  const info = await readOrRevert(
    () => readProject(client, project, addressing.tokenId),
    () => {
      const err = new GatewayError(
        `project ${addressing.tokenId} does not exist on chain ${chain.id}`,
        404,
        true,
        EDGE_MISSING_TTL_S,
      );
      remember(misses, missKey, err, MISSING_PROJECT_TTL_MS);
      throw err;
    },
  );

  let rootCid: AbxfsCid | null;
  if (addressing.kind === "latest") {
    rootCid = info.cid;
  } else if (addressing.kind === "tag") {
    // `latest` is a virtual tag on-chain, so this handles it without a special case here.
    rootCid = await readOrRevert(
      async () => (await readTag(client, project, addressing.tokenId, addressing.tag)).cid,
      () => {
        throw new GatewayError(`project ${addressing.tokenId} has no tag "${addressing.tag}"`, 404);
      },
    );
  } else {
    if (addressing.version > info.versionCount) {
      throw new GatewayError(
        `project ${addressing.tokenId} has ${info.versionCount} version(s); no v${addressing.version}`,
        404,
      );
    }
    const history = await readOrRevert(
      () =>
        readVersionHistory(client, project, addressing.tokenId, {
          start: addressing.version - 1,
          end: addressing.version,
        }),
      () => {
        throw new GatewayError(`project ${addressing.tokenId} has no version ${addressing.version}`, 404);
      },
    );
    rootCid = history[0]?.cid ?? null;
    if (!rootCid) {
      throw new GatewayError(
        `project ${addressing.tokenId} has no version ${addressing.version}`,
        404,
      );
    }
  }

  if (!rootCid) {
    const err = new GatewayError(`project ${addressing.tokenId} has not published anything yet`, 404);
    // Only the `latest` view is a property of the project; a tag or version can be missing while the
    // project has published, and that is not what this entry says.
    if (addressing.kind === "latest") remember(misses, missKey, err, UNPUBLISHED_TTL_MS);
    throw err;
  }

  return {
    rootCid,
    preferredGateway: info.preferredGateway,
    // The hook locks kind at first publish, so the project's own answer is authoritative and needs
    // no store probe. Fall back to probing only if the hook has no opinion.
    kind: info.kind !== ProjectKind.Unset ? info.kind : await probeKind(chain, rootCid),
  };
}

async function probeKind(chain: GatewayChain, rootCid: AbxfsCid): Promise<ProjectKind> {
  const misses = cacheFor(rootMissCache, chain.client);
  const key = `${resetEpoch}:${chain.id}:${rootCid.toLowerCase()}`;
  const missed = recall(misses, key);
  if (missed) throw missed.value;
  const known = recall(cacheFor(kindCache, chain.client), key);
  if (known) return known.value;
  return singleFlight(cacheFor(kindFlights, chain.client), key, async () => {
    // `directoryExists` / `fileExists` do not revert for an unknown root: they answer false. A failure is
    // therefore always "could not ask", never "not there".
    const kind = await readOrRevert(
      async () => (await locateContent(chain.client, chain.contracts, rootCid)).kind,
      () => ProjectKind.Unset,
    );
    if (kind === ProjectKind.Unset) {
      const err = new GatewayError(`root ${rootCid} is not stored on chain ${chain.id}`, 404);
      // Both stores ANSWERED "no". Held for seconds, not longer: a root published a moment ago must resolve.
      remember(misses, key, err, UNKNOWN_ROOT_TTL_MS);
      throw err;
    }
    remember(cacheFor(kindCache, chain.client), key, kind, KIND_TTL_MS);
    return kind;
  });
}

export interface ServedBody {
  bytes: Uint8Array;
  mimeType: string;
  /** Extra response headers this body needs (a listing page's CSP). */
  headers?: Record<string, string>;
  /**
   * Set only when the request carried a `Range` this server answered without reading the whole file. `bytes` is then
   * just that slice. Absent: `bytes` is the whole body and the handler slices it itself.
   */
  range?:
    | { kind: "partial"; start: number; end: number; /** The file's length. */ total: number }
    | { kind: "unsatisfiable"; total: number };
}

/** A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range, already checked against `If-Range`. */
export type RangeSpec =
  | {
      start: number;
      /** Inclusive; absent means "to the end". */
      end?: number;
    }
  | { /** The last `suffix` bytes. */ suffix: number };

/** What a request's path inside a root points at. */
export type Located =
  | {
      type: "file";
      cid: AbxfsCid;
      path: string;
      /** The URL named a directory and `index.html` answered. */
      directory?: boolean;
      /**
       * The directory whose `index.html` answered, when the URL named a directory (the root's own courtesy included).
       * It is SERVED too, as that directory's page, so the filter must see it: without it a bare deny of a directory
       * with an `index.html` was served through any wrapper directory at `/<name>/`.
       */
      dirCid?: AbxfsCid;
    }
  | {
      type: "listing";
      dirCid: AbxfsCid;
      /** The URL named a directory (not the root itself, which always ends in `/`). */
      directory: boolean;
    };

/**
 * Find what `subpath` names inside the root. Reads the directory store only; no file bytes.
 *
 * A directory root with no sub-path is a website root: `index.html` when present. That is what makes a
 * project's URL — and the NFT's `animation_url` — render as a site rather than a file list.
 */
export async function locate(resolved: ResolvedRequest): Promise<Located> {
  const { chain, rootCid, subpath, kind } = resolved;
  const client = chain.client;
  const addresses = chain.contracts;

  if (kind === ProjectKind.File) {
    // A file root IS the content. A sub-path under it addresses nothing, matching IPFS gateway
    // semantics for UnixFS files.
    if (subpath) throw new GatewayError(`root ${rootCid} is a file; sub-path not addressable`, 404);
    return { type: "file", cid: rootCid, path: "" };
  }

  const path = subpath || "index.html";
  const target = await resolvePathOrNull(client, addresses, rootCid, path);

  if (!target && !subpath) return { type: "listing", dirCid: rootCid, directory: true };
  if (!target) throw new GatewayError(`"${path}" not found under ${rootCid}`, 404);
  // The root's own `index.html` is served as the root's page: the root is the directory it stands for.
  if (!subpath && !target.isDirectory) return { type: "file", cid: target.cid, path, dirCid: rootCid };
  if (target.isDirectory) {
    // Directory sub-paths get the same index.html courtesy, then a listing. The directory travels with the file, so
    // the handler can refuse a blocked directory however its page is reached.
    const nestedPath = `${path}/index.html`;
    const nested = await resolvePathOrNull(client, addresses, rootCid, nestedPath);
    if (nested && !nested.isDirectory) return { type: "file", cid: nested.cid, path: nestedPath, directory: true, dirCid: target.cid };
    return { type: "listing", dirCid: target.cid, directory: true };
  }
  return { type: "file", cid: target.cid, path };
}

/**
 * The project's preferred IPFS gateway (`abxfs.gateway`) is an availability hint the owner publishes. This gateway does
 * not fetch through it: bytes from an IPFS gateway can only be trusted once checked against the IPFS CID of the
 * on-chain content, and deriving that CID reads the whole file from chain, which is the work fetching through it would
 * exist to avoid. The chain serves every file.
 */

/**
 * Serve what a request addresses, from chain. The gateway trusts its RPC, as every reader does: `ChunkStore.read`
 * checks each chunk against its record on chain, and a file codec's output is checked against `outputHash`.
 */
export async function serveContent(
  resolved: ResolvedRequest,
  options: {
    maxFileBytes?: number;
    located?: Located;
    /** A `bytes=a-b` / `bytes=a-` range to answer without reading the whole file, when the file allows it. */
    range?: RangeSpec | null;
    /** First entry of a directory listing page (directories are listed {@link PAGE_MAX} at a time). */
    listingStart?: number;
    /** Where a listing is served, `//<host>/<directory path>/`: its links lead back there (see {@link renderListing}). */
    listingBase?: string;
  } = {},
): Promise<ServedBody> {
  const located = options.located ?? (await locate(resolved));
  const { chain } = resolved;

  if (located.type === "listing") {
    return renderListing(chain, located.dirCid, options.listingStart ?? 0, options.listingBase ?? "");
  }

  // An explicit cap on both what is read from the chain and what a compressed file may inflate to: the
  // SDK's own defaults (1 GiB stored, 256 MiB inflated) are sized for a client, not for a request handler.
  const max = options.maxFileBytes ?? 64 * 1024 * 1024;
  // A file's CID is a hash: "this file is over the limit" is as immutable as the file. Remember it (so a
  // repeat costs no RPC read at all, where the first one read up to `max` bytes of chunks before refusing),
  // and tell shared caches they may keep the refusal too. A root URL names one set of bytes forever, so its
  // 413 may be held for an hour; a project URL can be republished with a smaller file, so it gets the short
  // project TTL.
  const edgeTtl = resolved.addressing.kind === "cid" ? OVERSIZE_EDGE_TTL_S : PROJECT_OVERSIZE_EDGE_TTL_S;
  const oversize = cacheFor(oversizeCache, chain.client);
  const oversizeKey = `${resetEpoch}:${chain.id}:${String(located.cid).toLowerCase()}:${max}`;
  const refuse = (message: string): GatewayError => {
    const refusal = tooLarge(message, edgeTtl);
    remember(oversize, oversizeKey, refusal, OVERSIZE_TTL_MS);
    return refusal;
  };
  // The cached refusal is about reading the WHOLE file. A ranged request that can be answered by reading a prefix is not
  // that, so it checks after its own branch below; every other request checks now, before any read.
  const checkKnownRefusal = () => {
    const known = recall(oversize, oversizeKey);
    if (known) throw tooLarge(known.value.message, edgeTtl);
  };
  if (!options.range) checkKnownRefusal();

  // A file no reader here can decode is refused before anything is read, ranged or not, and for as long as the bytes
  // exist: nothing about it can change. A spent call budget is remembered too, briefly, and per READ: a range that reads
  // a few chunks may succeed where the whole file does not. So it is keyed by what was actually read: the range when the
  // ranged branch below ran, `whole` otherwise (a ranged request on a file with a codec reads the whole file).
  const undecodable = cacheFor(undecodableCache, chain.client);
  const callBudget = cacheFor(callBudgetCache, chain.client);
  const undecodableKey = `${resetEpoch}:${chain.id}:${String(located.cid).toLowerCase()}`;
  const wholeCallsKey = `${undecodableKey}:calls:whole`;
  let callsKey = options.range ? `${undecodableKey}:calls:${JSON.stringify(options.range)}` : wholeCallsKey;
  const knownRefusal = (k: Timed<KnownRefusal> | undefined) =>
    k ? cannotDecode(k.value.message, k.value.status, Math.min(edgeTtl, k.value.edgeTtlCap ?? edgeTtl)) : null;
  const known = knownRefusal(recall(undecodable, undecodableKey) ?? recall(callBudget, callsKey));
  if (known) throw known;
  const refuseUndecodable = (message: string, status: number): GatewayError => {
    remember(undecodable, undecodableKey, { message, status }, UNDECODABLE_TTL_MS);
    return cannotDecode(message, status, edgeTtl);
  };

  try {
    const info = await readOrRevert(
      () => getFileInfo(chain.client, chain.contracts, located.cid),
      () => {
        throw new GatewayError(`file ${located.cid} is not stored on chain ${chain.id}`, 404);
      },
    );
    // A codec this reader has no decoder for: known from the file's record alone, so it is refused for the price of
    // that one call. (It used to read the whole file first and then fail with a generic 502 on every request.)
    const codec = typeof info.codec === "string" ? info.codec.toLowerCase() : `0x${"0".repeat(64)}`;
    if (!/^0x0{64}$/.test(codec) && !hasFileCodec(info.codec)) {
      throw refuseUndecodable(
        `this file is stored with the ${describeCodec(info.codec)} file codec, which this gateway cannot decode. ` +
          "The bytes are on chain and readable by any reader that can decode it.",
        501,
      );
    }
    // A ranged read of a file without a file codec reads only the chunks the range needs (see `readRange`). That
    // includes FastLZ chunks: their recorded sizes are of the inflated data, so offsets index the content.
    if (options.range && /^0x0{64}$/i.test(info.codec)) {
      const ranged = await readRange(chain, located.cid, info, options.range, {
        maxSliceBytes: max,
        maxChunks: Math.min(chunkBudget(max), RANGE_MAX_CHUNKS),
      });
      return { ...ranged, mimeType: mimeOf(info.mimeType) };
    }
    // The whole file: its data size and chunk count are known before any chunk is read, so an oversize file is
    // refused for the price of one call.
    if (info.size > max || info.chunkCount > chunkBudget(max)) throw new LimitExceededError("bytes", max, `file ${located.cid}`);
    if (options.range) {
      // A ranged request that reads the whole file: what is known about the whole file applies, and what this read
      // learns is about the whole file.
      checkKnownRefusal();
      callsKey = wholeCallsKey;
      const wholeKnown = knownRefusal(recall(callBudget, wholeCallsKey));
      if (wholeKnown) throw wholeKnown;
    }
    const file = await readFile(chain.client, chain.contracts, located.cid, {
      maxInflateBytes: max,
      maxStoredBytes: max,
      // A hostile file can be made of one-byte chunks: bound the chunk COUNT so the id pages and byte reads it costs are
      // bounded too, before any of them is paid for.
      maxChunks: chunkBudget(max),
    });
    return { bytes: file.bytes, mimeType: mimeOf(file.mimeType) };
  } catch (err) {
    // A spent call budget: the node answered every call, and the file's backend or the node's gas cap refused them.
    // That repeats on every request (the SDK rethrows a failure of the connection, never counts it), so it is a
    // remembered 502 with a short shared-cache lifetime: never the oversize 413 (the file may be small), and never a
    // 503 that sends every visitor back to spend the whole budget again.
    if (err instanceof LimitExceededError && err.limit === "calls") {
      const message =
        "this file's chunks could not be read within the gateway's call budget: the chain answered, but the file's " +
        "storage backend or this gateway's node refused the reads. The bytes are on chain; another reader, or a retry later, may read them.";
      remember(callBudget, callsKey, { message, status: 502, edgeTtlCap: CALL_BUDGET_EDGE_TTL_S }, CALL_BUDGET_TTL_MS);
      throw cannotDecode(message, 502, Math.min(edgeTtl, CALL_BUDGET_EDGE_TTL_S));
    }
    if (err instanceof LimitExceededError || isInflateLimit(err)) {
      throw refuse(
        `file exceeds this gateway's limit of ${max} bytes. Fetch it from IPFS or another ABX FS gateway ` +
          "(the bytes are on chain and readable by any reader).",
      );
    }
    // The SDK's own check: the decoded content is not what the file's CID commits to. The gateway trusts its RPC, so
    // this is a property of the stored bytes (or of a decoder that disagrees with the writer's), not of the moment.
    if ((err as { name?: unknown } | null)?.name === "OutputHashMismatchError") {
      throw refuseUndecodable(
        "this file's stored data does not decode to the content its CID commits to (outputHash mismatch), " +
          "so this gateway will not serve it.",
        502,
      );
    }
    throw err;
  }
}

/** A codec label as text for a message: its token (validated lowercase ASCII), never raw attacker bytes. */
function describeCodec(label: string): string {
  try {
    const name = codecName(label);
    return name === null ? "no" : `"${name}"`;
  } catch {
    return "an unrecognised";
  }
}

function cannotDecode(message: string, status: number, edgeTtl: number): GatewayError {
  return new GatewayError(message, status, false, undefined, edgeTtl);
}

/** A ranged read reads at most this many chunks (about 16 round trips), however small they are. */
const RANGE_MAX_CHUNKS = 1024;
/** Chunks fetched and verified per round trip, at most (the SDK's own bundle size). */
const CHUNK_BUNDLE = 64;

/**
 * The most chunks one served file may have: a file of `max` bytes at the chunker's minimum chunk size, with
 * headroom, never below 256. A file with more is either over the byte cap anyway or built to be expensive to read.
 */
export function chunkBudget(max: number): number {
  return Math.max(256, Math.ceil(max / 4096));
}

/**
 * Read a byte range of a file without a file codec.
 *
 * The store records every chunk's size and every branch's cumulative bytes (verified on chain when written), so one
 * `locateByte` call finds the chunk holding the first byte wanted, wherever it is in the file; the read then
 * continues from that chunk only as far as the range ends. The cost is the slice, never its position: a seek to the
 * last second of a 2 GB video costs what a read of its first second does. Suffix ranges (`bytes=-n`) work because the length is known up front.
 *
 * The slice served is at most `maxSliceBytes` bytes and `maxChunks` chunks: an open-ended (or very large) range is
 * answered with as much as that, which the `Content-Range` states, and the client asks again from where it stopped.
 */
async function readRange(
  chain: GatewayChain,
  cid: AbxfsCid,
  info: FileInfo,
  spec: RangeSpec,
  limits: { maxSliceBytes: number; maxChunks: number },
): Promise<Pick<ServedBody, "bytes" | "range">> {
  const total = info.size;
  let start: number;
  let last: number;
  if ("suffix" in spec) {
    if (spec.suffix === 0) return { bytes: new Uint8Array(0), range: { kind: "unsatisfiable", total } };
    start = Math.max(0, total - spec.suffix);
    last = total - 1;
  } else {
    start = spec.start;
    last = spec.end === undefined ? total - 1 : Math.min(spec.end, total - 1);
  }
  if (start >= total) return { bytes: new Uint8Array(0), range: { kind: "unsatisfiable", total } };
  const wantEnd = Math.min(last, start + limits.maxSliceBytes - 1);

  const stores = contentStores(chain.contracts);
  const at = await locateByte(chain.client, chain.contracts, cid, start);
  const parts: Uint8Array[] = [];
  let index = at.index; // next chunk
  let offset = at.chunkStart; // file offset of that chunk's first byte
  let read = 0; // chunks read
  let bytesRead = 0;
  let page: AbxfsCid[] = []; // chunk ids from `pageAt`, fetched PAGE_MAX at a time and reused
  let pageAt = 0;
  while (offset <= wantEnd && index < info.chunkCount && read < limits.maxChunks) {
    // Enough chunks to cover what is left of the range at the average chunk size seen so far (the located chunk's
    // size to begin with): a file of tiny chunks is read a full bundle per round trip, not one chunk.
    const average = read === 0 ? at.chunkSize : Math.max(1, Math.floor(bytesRead / read));
    const want = Math.min(
      CHUNK_BUNDLE,
      limits.maxChunks - read,
      Math.max(1, Math.ceil((wantEnd + 1 - offset) / average)),
      info.chunkCount - index,
    );
    if (index < pageAt || index >= pageAt + page.length) {
      page = await getChunkIdsPage(chain.client, stores, cid, index, PAGE_MAX, info.chunkCount);
      pageAt = index;
      if (page.length === 0) throw new Error(`file ${cid}: no chunk ids at index ${index}`);
    }
    const hashes = page.slice(index - pageAt, index - pageAt + want);
    if (read === 0 && hashes[0]!.toLowerCase() !== at.chunkId.toLowerCase()) {
      throw new Error(`file ${cid}: locateByte and getChunkIds disagree at chunk ${index}`);
    }
    // One round trip reads at most this many bytes: the slice still wanted plus one chunk of slack.
    const chunks = await readChunks(chain, cid, hashes, limits.maxSliceBytes + MAX_CHUNK_SLACK);
    for (const data of chunks) {
      if (read === 0 && data.length !== at.chunkSize) {
        throw new Error(`file ${cid}: chunk ${index} is ${data.length} bytes, recorded as ${at.chunkSize}`);
      }
      const from = Math.max(start, offset);
      const to = Math.min(wantEnd, offset + data.length - 1);
      if (to >= from) parts.push(data.subarray(from - offset, to - offset + 1));
      offset += data.length;
      bytesRead += data.length;
      read++;
    }
    index += hashes.length;
  }
  const bytes = concat(parts);
  return { bytes, range: { kind: "partial", start, end: start + bytes.length - 1, total } };
}

function readChunks(chain: GatewayChain, cid: AbxfsCid, ids: AbxfsCid[], budget: number): Promise<Uint8Array[]> {
  // The SDK's chunk reader: `ChunkStore.read` checks each chunk against its record.
  return readChunkSlices(chain.client, chain.contracts, cid, ids, budget);
}

/** Bytes a ranged read may read beyond its slice: the chunks either side of the range (FastLZ data can be ~2 MB). */
const MAX_CHUNK_SLACK = 8 * 1024 * 1024;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const OVERSIZE_EDGE_TTL_S = 3600;
const PROJECT_OVERSIZE_EDGE_TTL_S = 60;

function tooLarge(message: string, edgeTtl: number): GatewayError {
  return new GatewayError(message, 413, false, undefined, edgeTtl);
}

/** The codecs signal the inflate cap in their own words (fastlz throws a plain Error; zlib a RangeError). */
function isInflateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return /exceeds .*(refusing to inflate|maxOutput)|output exceeds|Cannot create a Buffer larger|ERR_BUFFER_TOO_LARGE/i.test(message) ||
    (err as { code?: string } | null)?.code === "ERR_BUFFER_TOO_LARGE";
}

/** `FileStore` carries the MIME type the uploader declared; fall back only when it is absent. */
function mimeOf(mimeType: string): string {
  return mimeType || "application/octet-stream";
}

async function resolvePathOrNull(
  client: PublicClient,
  addresses: ContractAddresses,
  rootCid: AbxfsCid,
  path: string,
): Promise<{ cid: AbxfsCid; isDirectory: boolean } | null> {
  try {
    // A binary search on chain (`DirectoryStore.resolvePath`), the same cost in a 6,000-entry directory as in a 6-entry
    // one. The contract takes 32 segments per call; the SDK chains calls for deeper paths, up to
    // `DEFAULT_MAX_PATH_SEGMENTS` (256, so at most 8 calls) per resolution.
    return await resolvePath(client, addresses, rootCid, path);
  } catch (err) {
    // `DirectoryStore.resolvePath` reverts on a missing entry; that is a 404, not an error. So is what the SDK
    // decides between chained calls (a file mid-path) and a path past the 256-segment cap: both are a 404, as a
    // path past 32 segments was when the contract's `PathTooDeep` revert answered it. A failure that was not a
    // revert is the RPC, not the path, and must not read as "not found".
    if (isRevert(err) || err instanceof PathNotResolvedError) return null;
    throw upstreamUnavailable();
  }
}

/**
 * A minimal directory listing.
 *
 * Rendering the entries costs one extra read and makes every project without an index.html browsable.
 * Links carry the host and directory that served the page (`base`, scheme-relative: `//<host>/<dir>/<name>`), not
 * just the name: a marketplace may show a COPY of the page from its own storage (OpenSea shows `animation_url` that
 * way), where a bare-relative link names a file on the marketplace's host. Names are attacker-controlled, so they are
 * escaped, and the page carries a CSP that allows nothing but its own inline style.
 *
 * A directory has no size limit, so it is listed {@link PAGE_MAX} entries per page (`?start=N`): one `eth_call`
 * however large it is.
 */
async function renderListing(chain: GatewayChain, dirCid: AbxfsCid, start: number, base: string): Promise<ServedBody> {
  const stores = contentStores(chain.contracts);
  const total = await entryCount(chain.client, stores, dirCid);
  const first = Math.min(Math.max(0, start), Math.max(0, total - 1));
  const entries = await getEntriesPage(chain.client, stores, dirCid, first, PAGE_MAX, total);
  const here = escapeHtml(base);
  const links: string[] = [];
  if (first > 0) links.push(`<a href="${here}?start=${Math.max(0, first - PAGE_MAX)}">previous</a>`);
  if (first + entries.length < total) links.push(`<a href="${here}?start=${first + entries.length}">next</a>`);
  const nav = `<p>${total === 0 ? "" : `${first + 1}-${first + entries.length} of ${total}`}${links.length ? ` &middot; ${links.join(" &middot; ")}` : ""}</p>`;
  const rows = entries
    .map((e) => {
      const name = escapeHtml(e.name) + (e.isDirectory ? "/" : "");
      const href = here + encodePathSegment(entryNameBytes(e)) + (e.isDirectory ? "/" : "");
      return `<li><a href="${href}">${name}</a></li>`;
    })
    .join("");

  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(dirCid)}</title>
<style>body{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d12;color:#e8edf7;margin:0;padding:2rem}
h1{font-size:13px;font-weight:400;color:#8b97ad;word-break:break-all;margin:0 0 1.5rem}p{color:#8b97ad;margin:0 0 1rem}
ul{list-style:none;padding:0;margin:0}li{padding:.35rem 0;border-bottom:1px solid #1b2029}
a{color:#8fb8ff;text-decoration:none}a:hover{text-decoration:underline}</style>
<h1>${escapeHtml(dirCid)}</h1>${nav}<ul>${rows || "<li>(empty)</li>"}</ul>`;

  return {
    bytes: new TextEncoder().encode(html),
    mimeType: "text/html; charset=utf-8",
    headers: { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A year: what an immutable root response may be cached for. */
export const IMMUTABLE_MAX_AGE_S = 31_536_000;
/** Seconds a root host's response for anything but the root itself may be cached (the same as a pinned version). */
const ROOT_SUBRESOURCE_MAX_AGE_S = 60;

/**
 * Cache-Control for a resolution.
 *
 * - A ROOT host serving the ROOT ITSELF (a file root, or a directory root's own listing) is a hash: its URL addresses
 *   one set of bytes forever, so it is **immutable** (or `rootMaxAge`, when the operator set one). The filter
 *   subject for that root is derived from the URL alone and checked ahead of any CDN, which is what makes caching it
 *   forever safe.
 * - A ROOT host serving ANY OTHER CID (`index.html` of a directory root, a file or listing under a sub-path) is not.
 *   The CID actually served is a filter subject of its own, only known after resolving, behind the cache: an
 *   `immutable` response for it could never be revoked when that CID is blocked later. It gets the short `s-maxage` a
 *   pinned version gets.
 * - A PROJECT (latest, a pinned version, a tag) is never immutable at the edge, even when pinned. Its
 *   filter subjects include the ROOT it resolves to, which is only known after resolving — behind
 *   the cache. A short `s-maxage` bounds how long a block on that root can be missed through a project
 *   URL that was already cached.
 */
export function cacheControlFor(
  addressing: Addressing,
  options: {
    /** The response is the root itself (default true): only then may a root host's response be immutable. */
    servesRoot?: boolean;
    /** Seconds a root host's own root may be cached. Default (or anything from a year up) is a year, `immutable`. */
    rootMaxAge?: number;
  } = {},
): string {
  if (addressing.kind === "cid") {
    const rootMaxAge = options.rootMaxAge ?? IMMUTABLE_MAX_AGE_S;
    if (options.servesRoot === false) {
      const ttl = Math.min(ROOT_SUBRESOURCE_MAX_AGE_S, rootMaxAge);
      return ttl > 0 ? `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=30` : "no-cache";
    }
    if (rootMaxAge >= IMMUTABLE_MAX_AGE_S) return "public, max-age=31536000, immutable";
    return rootMaxAge > 0 ? `public, max-age=${rootMaxAge}, s-maxage=${rootMaxAge}` : "no-cache";
  }
  if (addressing.kind === "version") return "public, max-age=60, s-maxage=60, stale-while-revalidate=30";
  return "public, max-age=10, s-maxage=60, stale-while-revalidate=30";
}

/**
 * Types that execute or style a document when navigated to, or that do not parse as one MIME type at all: they get a
 * `sandbox` CSP everywhere. See `mime.ts` for why the declared text is parsed the way the browser parses it.
 */
export function isActiveXmlType(mimeType: string): boolean {
  return servedType(mimeType).sandbox;
}
