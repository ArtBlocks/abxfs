/**
 * ABX FS orgs.
 *
 * An org is its own ABX collection, deployed by one immutable factory that renounces ABX ownership
 * at creation. Projects are tokens inside it. The org's *admin* is a record in the factory, not an
 * ABX owner, and its powers are exactly three: decide who may mint into the org, flip it open or
 * closed, and hand the role on. It has no power over any project — a project is governed by
 * `ownerOf` and nothing else.
 *
 * Everything here is an `eth_call` or a transaction against the factory, the hooks, or the lens.
 * Nothing reads `eth_getLogs`, with one exception: {@link createOrg} decodes the `OrgCreated` event
 * from its own receipt, which is the transaction it just sent and is never subject to pruning.
 *
 * See `specs/abx-fs-orgs.md`.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  hexToString,
  parseEventLogs,
  stringToHex,
} from "viem";
import { seriesCodeAbi } from "@artblocks/abx-sdk/abi";

import { lensAbi, orgMinterAbi, iOrgFactoryAbi } from "./abi-org.js";
import { iProjectEnumerationAbi } from "./abi-enumeration.js";
import { iProjectHookAbi } from "./abi-hook.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { assertSafeRecipient } from "./address-safety.js";
import { settle } from "./settle.js";
import { capped, checkCount, readAtBlock, snapshotBlock, type CappedList } from "./snapshot.js";
import { PROBE_SLICE } from "./util.js";
import {
  ProjectKind,
  asAbxfsCid,
  type AbxfsCid,
  type ContractAddresses,
  type OrgGeneration,
} from "./types.js";
import { assertWalletChain } from "./wallet-chain.js";

import { isRetiredFactory, RETIRED_PRESENTATION_FACTORY, RetiredOrgGenerationError } from "./retired.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The factory enforces the same bound; checking here turns a revert into a readable error. */
export const ORG_NAME_MAX_BYTES = 64;

/** The factory's bound on an org description. It is optional, so 0 bytes is allowed. */
export const ORG_DESCRIPTION_MAX_BYTES = 1000;

/** The longest `abxfs.name` a token's marketplace name is taken from. See {@link projectNameShowsOnMarketplaces}. */
export const PROJECT_TOKEN_NAME_MAX_BYTES = 128;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The contracts one chain's org layer is made of. */
export interface OrgContracts {
  factory: Address;
  /** `ProjectEnumeration` — owner → orgs held, and owner → tokens per org. */
  enumeration?: Address;
  /** `ProjectHook` — version history, tags, and both ledgers. */
  hook?: Address;
  /** `Lens` — one-call resolution and the resolved global feed. */
  lens?: Address;
}

export interface Org {
  org: Address;
  /** The ABX collection name. Frozen at creation, so it cannot be changed to pass as another org. */
  name: string;
  admin: Address;
  /** An admin handover offered but not yet accepted, or `null`. */
  pendingAdmin: Address | null;
  /** Anyone may mint into an open org. Otherwise only the admin. */
  open: boolean;
  createdBlock: bigint;
}

export type OrgRole = "admin" | "holder";

/** An org plus how a particular address relates to it. */
export interface MyOrg extends Org {
  /** Why this org is in the list. Both when the address administers it and also holds a project in it. */
  roles: OrgRole[];
}

/** One publish, anywhere in any org, with the org it happened in. */
export interface OrgPublish {
  org: Address;
  tokenId: bigint;
  cid: AbxfsCid;
  publisher: Address;
  publishedAt: number;
  /** The token's own 1-based version number for this publish. */
  version: number;
}

/** What a gateway needs to serve `/<org>/<tokenId>`. */
export interface ResolvedProject {
  /** `false` means the factory does not know this address; nothing else is meaningful. */
  registered: boolean;
  kind: ProjectKind;
  cid: AbxfsCid | null;
  owner: Address;
  /** `abxfs.gateway`, or `null`. */
  gateway: string | null;
}

/** Pick the org-layer contracts out of a chain's addresses, or throw saying what is missing. */
export function requireOrgContracts(addresses: ContractAddresses): OrgContracts {
  if (!addresses.orgFactory) {
    throw new Error(
      "this chain has no ABX FS org factory configured (`orgFactory`) — projects need an org",
    );
  }
  return {
    factory: addresses.orgFactory,
    ...(addresses.projectEnumeration ? { enumeration: addresses.projectEnumeration } : {}),
    ...(addresses.projectHook ? { hook: addresses.projectHook } : {}),
    ...(addresses.lens ? { lens: addresses.lens } : {}),
  };
}

// ─── Factory generations ─────────────────────────────────────────────────────

/**
 * Every org-layer generation a chain has, newest first. Empty when the chain has no org layer.
 *
 * Deduplicated by factory (the current generation wins), so a stale address override left
 * pointing at a superseded factory cannot list every one of its orgs twice. And it refuses an
 * incoherent registry rather than reading orgs through the wrong contracts: a factory paired with a
 * hook, minter or enumeration that belongs to a DIFFERENT generation (a per-key override of the new
 * factory over an old hook) would read every new org through a hook that never saw it. Throws then.
 */
export function orgGenerations(addresses: ContractAddresses): OrgGeneration[] {
  const current: OrgGeneration[] =
    addresses.orgFactory && addresses.projectHook
      ? [
          {
            orgFactory: addresses.orgFactory,
            projectHook: addresses.projectHook,
            ...(addresses.orgMinter ? { orgMinter: addresses.orgMinter } : {}),
            ...(addresses.projectEnumeration ? { projectEnumeration: addresses.projectEnumeration } : {}),
            ...(addresses.lens ? { lens: addresses.lens } : {}),
            ...(addresses.projectPresentation ? { projectPresentation: addresses.projectPresentation } : {}),
          },
        ]
      : [];
  const out: OrgGeneration[] = [];
  const byFactory = new Map<string, OrgGeneration>();
  for (const g of [...current, ...(addresses.previousGenerations ?? [])]) {
    if (isRetiredFactory(g.orgFactory)) continue;
    const key = g.orgFactory.toLowerCase();
    const seen = byFactory.get(key);
    if (seen) {
      if (seen.projectHook.toLowerCase() !== g.projectHook.toLowerCase()) {
        throw new Error(
          `incoherent ABX FS registry: factory ${g.orgFactory} appears with two different hooks ` +
            `(${seen.projectHook} and ${g.projectHook}). A per-key address override is probably stale; ` +
            "remove it or update every address of the generation together.",
        );
      }
      continue; // the same generation listed again (e.g. current also in previousGenerations)
    }
    byFactory.set(key, g);
    out.push(g);
  }
  // A hook, minter or enumeration hook belongs to exactly one generation (a lens is a stateless reader and may be shared).
  const owner = new Map<string, string>();
  for (const g of out) {
    for (const [slot, v] of [
      ["projectHook", g.projectHook],
      ["orgMinter", g.orgMinter],
      ["projectEnumeration", g.projectEnumeration],
    ] as const) {
      if (!v) continue;
      const key = `${slot}:${v.toLowerCase()}`;
      const first = owner.get(key);
      if (first && first !== g.orgFactory.toLowerCase()) {
        throw new Error(
          `incoherent ABX FS registry: ${slot} ${v} is paired with two different factories ` +
            `(${first} and ${g.orgFactory}). A per-key address override is probably stale.`,
        );
      }
      owner.set(key, g.orgFactory.toLowerCase());
    }
  }
  return out;
}

/**
 * The generation whose factory created `org`, or `undefined` if none of them did.
 *
 * "Did none of them create it" is the security answer, not a missing feature: an address no ABX FS
 * factory made is not an org, whatever it claims to be. A factory that errors, has no code, or
 * answers anything but a clean `true` counts as "did not create it" — the caller serves a 404, which
 * is also what an unreachable factory deserves, and this never throws.
 */
export async function generationOfOrg(
  client: PublicClient,
  addresses: ContractAddresses,
  org: Address,
): Promise<OrgGeneration | undefined> {
  for (const generation of orgGenerations(addresses)) {
    if (await isOrg(client, generation.orgFactory, org).catch(() => false)) return generation;
  }
  return undefined;
}

/**
 * `addresses` as seen by one org: the generation that created it takes the org-layer slots, so
 * everything that takes a `ContractAddresses` (the client, publish, tag, history reads) works on an
 * old org unchanged. `ChunkStore` and the backends are shared by every generation; a generation that names its own
 * store pair overrides the book's (see `OrgGeneration`).
 *
 * Returns `undefined` when no generation created `org`.
 */
export async function addressesForOrg(
  client: PublicClient,
  addresses: ContractAddresses,
  org: Address,
): Promise<ContractAddresses | undefined> {
  const generation = await generationOfOrg(client, addresses, org);
  if (!generation) {
    if (isRetiredFactory(RETIRED_PRESENTATION_FACTORY) && await isOrg(client, RETIRED_PRESENTATION_FACTORY, org).catch(() => false))
      throw new RetiredOrgGenerationError(org);
    return undefined;
  }
  const { previousGenerations: _drop, orgMinter: _m, projectEnumeration: _e, lens: _l, projectPresentation: _p, contentReader: _reader, ...rest } = addresses;
  void _drop; void _m; void _e; void _l; void _p;
  // The native reader is bound to the book's immutable store pair, not to arbitrary older stores.
  const changesStores =
    (generation.fileStore && generation.fileStore.toLowerCase() !== addresses.fileStore.toLowerCase()) ||
    (generation.directoryStore && generation.directoryStore.toLowerCase() !== addresses.directoryStore.toLowerCase());
  return {
    ...rest,
    orgFactory: generation.orgFactory,
    projectHook: generation.projectHook,
    // A generation that names its store pair overrides the book's (the pair is part of the generation).
    ...(generation.fileStore && generation.directoryStore
      ? { fileStore: generation.fileStore, directoryStore: generation.directoryStore }
      : {}),
    ...(generation.orgMinter ? { orgMinter: generation.orgMinter } : {}),
    ...(generation.projectEnumeration ? { projectEnumeration: generation.projectEnumeration } : {}),
    ...(generation.lens ? { lens: generation.lens } : {}),
    ...(generation.projectPresentation ? { projectPresentation: generation.projectPresentation } : {}),
    ...(!changesStores && _reader ? { contentReader: _reader } : {}),
  };
}

// ─── Names ───────────────────────────────────────────────────────────────────

/**
 * Throws if `name` is not a legal org name. Mirrors the factory's frozen policy exactly, so the reason
 * appears before any simulation: printable ASCII only (0x20 to 0x7e), 1 to 64 bytes, and not all spaces.
 */
export function validateOrgName(name: string): void {
  if (typeof name !== "string") throw new Error("an org needs a name");
  // Length is measured in UTF-16 units first so a huge string is refused without being encoded.
  if (name.length === 0) throw new Error("an org needs a name");
  if (name.length > ORG_NAME_MAX_BYTES) {
    throw new Error(`org name is ${name.length} characters; the limit is ${ORG_NAME_MAX_BYTES}`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(
        "an org name must be printable ASCII (letters, digits, punctuation and spaces): it is frozen into the org " +
          `and rendered on its card (character ${i + 1} is not allowed)`,
      );
    }
  }
  if (name.trim().length === 0 || /^ +$/.test(name)) throw new Error("an org name cannot be only spaces");
}

/**
 * Throws if `description` is not a legal org description. Mirrors the factory's frozen policy exactly, so
 * the reason appears before any transaction: optional (empty is fine), at most 1000 bytes, every character
 * printable ASCII (0x20 to 0x7e) or a newline, and, if not empty, not only whitespace.
 *
 * The description is permanent: it becomes the collection description marketplaces show, and the fallback
 * description of every token in the org.
 */
export function validateOrgDescription(description: string): void {
  if (typeof description !== "string") throw new Error("an org description must be text");
  if (description.length === 0) return;
  // Every allowed character is one byte, so UTF-16 length equals byte length for any string that passes.
  if (description.length > ORG_DESCRIPTION_MAX_BYTES) {
    throw new Error(
      `org description is ${description.length} characters; the limit is ${ORG_DESCRIPTION_MAX_BYTES}`,
    );
  }
  for (let i = 0; i < description.length; i++) {
    const c = description.charCodeAt(i);
    if (c !== 0x0a && (c < 0x20 || c > 0x7e)) {
      throw new Error(
        "an org description must be printable ASCII (letters, digits, punctuation, spaces and newlines): it is " +
          `frozen into the org and shown on marketplaces (character ${i + 1} is not allowed)`,
      );
    }
  }
  if (/^[ \n]+$/.test(description)) throw new Error("an org description cannot be only spaces and newlines");
}

/**
 * Whether marketplaces show a project under its own name. The org's metadata uses `abxfs.name` as the
 * token name when it is 1 to 128 bytes of printable ASCII (0x20 to 0x7e) and not all spaces; otherwise
 * the token is shown as "<org name> #<id>". Mirrors the on-chain rule, so the site can say which.
 */
export function projectNameShowsOnMarketplaces(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > PROJECT_TOKEN_NAME_MAX_BYTES) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  // `-` is how a cleared string param reads on chain, so the name renderer treats it as unset.
  return name !== "-" && !/^ +$/.test(name);
}

/**
 * A default name for an org nobody named: the owner's address, shortened.
 *
 * Names are immutable and become the ABX collection name, so this is what a marketplace will show
 * for a personal org forever. It is also never mistakable for a brand, which is a feature.
 *
 * ASCII on purpose. The card renders the name through a sanitizer that keeps printable ASCII only, so
 * a typographic ellipsis here would be silently dropped and the card would show `0x1234abcd` — a
 * string that looks like a truncated address but is neither the name nor an address.
 */
export function defaultOrgName(account: Address): string {
  return `${account.slice(0, 6)}..${account.slice(-4)}`;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function isOrg(client: PublicClient, factory: Address, org: Address): Promise<boolean> {
  return (await client.readContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "isOrg",
    args: [org],
  })) as boolean;
}

/** One org's record, or `null` if the factory does not know the address. */
export async function readOrg(
  client: PublicClient,
  factory: Address,
  org: Address,
): Promise<Org | null> {
  const [registered, admin, pending, open, createdBlock, name] = await client.multicall({
    contracts: [
      { address: factory, abi: iOrgFactoryAbi, functionName: "isOrg", args: [org] },
      { address: factory, abi: iOrgFactoryAbi, functionName: "adminOf", args: [org] },
      { address: factory, abi: iOrgFactoryAbi, functionName: "pendingAdminOf", args: [org] },
      { address: factory, abi: iOrgFactoryAbi, functionName: "isOpen", args: [org] },
      { address: factory, abi: iOrgFactoryAbi, functionName: "createdBlockOf", args: [org] },
      { address: org, abi: seriesCodeAbi, functionName: "name" },
    ],
    allowFailure: true,
  });

  if (registered.status !== "success" || registered.result !== true) return null;

  const pendingAdmin =
    pending.status === "success" && pending.result !== ZERO ? (pending.result as Address) : null;

  return {
    org,
    name: name.status === "success" ? (name.result as string) : "",
    admin: (admin.status === "success" ? admin.result : ZERO) as Address,
    pendingAdmin,
    open: open.status === "success" ? (open.result as boolean) : false,
    createdBlock: createdBlock.status === "success" ? BigInt(createdBlock.result as bigint) : 0n,
  };
}

export async function readOrgCount(client: PublicClient, factory: Address): Promise<bigint> {
  return (await client.readContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "orgCount",
  })) as bigint;
}

/** A window of the factory's append-only org list, oldest first. */
export async function readOrgs(
  client: PublicClient,
  factory: Address,
  opts: { start?: bigint; count?: number } = {},
): Promise<Address[]> {
  return [
    ...((await client.readContract({
      address: factory,
      abi: iOrgFactoryAbi,
      functionName: "orgsSlice",
      args: [opts.start ?? 0n, BigInt(opts.count ?? 100)],
    })) as readonly Address[]),
  ];
}

/**
 * Orgs `admin` currently administers, at most `max` (default 2,000; `truncated` on the result says there are more).
 *
 * Paged (`orgsAdministeredSlice` clamps a window and never reverts), so an admin of many orgs costs bounded calls
 * rather than one unbounded return, and every page is read at ONE block: a handover removes an org by swap-and-pop,
 * so pages read either side of it would skip one org and repeat another. `pageSize` (default 200) and `max` must be
 * integers, at least 1 and 0.
 */
export async function readOrgsAdministered(
  client: PublicClient,
  factory: Address,
  admin: Address,
  opts: { pageSize?: number; max?: number } = {},
): Promise<CappedList<Address>> {
  const pageSize = checkCount(opts.pageSize ?? 200, "pageSize", 1);
  const max = checkCount(opts.max ?? 2_000, "max", 0);
  const block = await snapshotBlock(client);
  const slice = async (start: number, count: number) =>
    readAtBlock<readonly Address[]>(
      client,
      { address: factory, abi: iOrgFactoryAbi, functionName: "orgsAdministeredSlice", args: [admin, BigInt(start), BigInt(count)] },
      block,
    );
  const out: Address[] = [];
  for (;;) {
    if (out.length >= max) {
      // At the cap: one more entry would mean the list is longer than what is returned.
      return capped(out, (await slice(out.length, 1)).length > 0);
    }
    const want = Math.min(pageSize, max - out.length);
    const page = await slice(out.length, want);
    out.push(...page.slice(0, want));
    if (page.length < want) return capped(out, false);
  }
}

/**
 * Registered orgs in which `owner` holds at least one project, from the transfer hook's index.
 *
 * Distinct from {@link readOrgsAdministered}: an admin who minted every project to other people
 * holds none, and a collaborator holds projects in an org they do not administer.
 */
export async function readOrgsHeld(
  client: PublicClient,
  enumeration: Address,
  owner: Address,
  opts: { pageSize?: number; max?: number } = {},
): Promise<CappedList<Address>> {
  // Paged (200 per call by default): `orgsHeldBy` is unbounded and anyone can mint to a wallet. The count and every
  // page are read at ONE block: the list is kept by swap-and-pop, so pages read either side of a change would skip an
  // org and repeat another. At most `max` (default 2,000); `truncated` on the result says the wallet holds more.
  const pageSize = checkCount(opts.pageSize ?? 200, "pageSize", 1);
  const max = checkCount(opts.max ?? 2000, "max", 0);
  const block = await snapshotBlock(client);
  const count = await readAtBlock<bigint>(
    client,
    { address: enumeration, abi: iProjectEnumerationAbi, functionName: "orgsHeldCount", args: [owner] },
    block,
  );
  const out: Address[] = [];
  for (let start = 0n; start < count && out.length < max; start += BigInt(pageSize)) {
    const page = await readAtBlock<readonly Address[]>(
      client,
      { address: enumeration, abi: iProjectEnumerationAbi, functionName: "orgsHeldSlice", args: [owner, start, BigInt(pageSize)] },
      block,
    );
    if (page.length === 0) break;
    out.push(...page);
  }
  return capped(out.slice(0, max), count > BigInt(max));
}

/** The orgs a wallet is connected to, plus those whose record could not be read. */
export interface MyOrgsResult {
  orgs: MyOrg[];
  /**
   * Orgs the wallet is connected to whose record read failed: dropped from `orgs`, never silently. When a
   * whole superseded generation could not be read, its FACTORY address is listed here (it names what is
   * missing) and also in {@link failedGenerations}.
   */
  failed: Address[];
  /** Factories of superseded generations that could not be read at all (their orgs are absent from `orgs`). */
  failedGenerations?: Address[];
  /**
   * The wallet is connected to more orgs than one read returns (an index past its cap: 2,000 administered or 2,000
   * held, per generation). Anyone can mint into a wallet from an open org, so the held list can be made this long.
   */
  truncated?: true;
}

function newestFirst(a: MyOrg, b: MyOrg): number {
  return a.createdBlock === b.createdBlock ? 0 : a.createdBlock > b.createdBlock ? -1 : 1;
}

/**
 * Every org an address is connected to, newest first — the list a wallet's org switcher shows — and the
 * orgs that could not be read.
 *
 * Two on-chain indexes, merged: orgs it administers (the factory) and orgs it holds projects in
 * (the enumeration hook). No indexer and no log read, so the cost does not grow with chain age.
 *
 * Anyone can mint into an open org to any address, so the held list is attacker-sized. The per-org record
 * reads therefore run in slices of {@link PROBE_SLICE} and settle individually: one failing batch (or one
 * hostile org) costs that org, not the whole list.
 */
export async function readMyOrgsDetailed(
  client: PublicClient,
  contracts: OrgContracts,
  account: Address,
): Promise<MyOrgsResult> {
  const [administered, held] = await Promise.all([
    readOrgsAdministered(client, contracts.factory, account),
    contracts.enumeration ? readOrgsHeld(client, contracts.enumeration, account) : Promise.resolve(capped<Address>([], false)),
  ]);

  const roles = new Map<string, { org: Address; roles: Set<OrgRole> }>();
  const note = (org: Address, role: OrgRole) => {
    const key = org.toLowerCase();
    const entry = roles.get(key) ?? { org, roles: new Set<OrgRole>() };
    entry.roles.add(role);
    roles.set(key, entry);
  };
  administered.forEach((o) => note(o, "admin"));
  held.forEach((o) => note(o, "holder"));

  const entries = [...roles.values()];
  const orgs: MyOrg[] = [];
  const failed: Address[] = [];
  for (let i = 0; i < entries.length; i += PROBE_SLICE) {
    const slice = entries.slice(i, i + PROBE_SLICE);
    const settled = await Promise.allSettled(slice.map(({ org }) => readOrg(client, contracts.factory, org)));
    settled.forEach((r, j) => {
      const { org, roles: rs } = slice[j]!;
      if (r.status === "rejected") failed.push(org);
      else if (r.value) orgs.push({ ...r.value, roles: [...rs] } satisfies MyOrg);
    });
  }
  orgs.sort(newestFirst);
  return { orgs, failed, ...(administered.truncated || held.truncated ? { truncated: true as const } : {}) };
}

/** {@link readMyOrgsDetailed}, orgs only. Throws when there were orgs to read and none could be. */
export async function readMyOrgs(
  client: PublicClient,
  contracts: OrgContracts,
  account: Address,
): Promise<MyOrg[]> {
  const { orgs, failed } = await readMyOrgsDetailed(client, contracts, account);
  if (orgs.length === 0 && failed.length > 0) {
    throw new Error(`could not read any of this wallet's ${failed.length} org(s); check the RPC endpoint`);
  }
  return orgs;
}

/**
 * {@link readMyOrgsDetailed} across every factory generation, merged newest first.
 *
 * The current generation answers or throws, as it would alone. An earlier generation that cannot be
 * read thins the list rather than failing it (its orgs are an addition, and one dead endpoint for a
 * superseded contract should not hide the wallet's current orgs), but it is REPORTED: its factory is in
 * `failed` and `failedGenerations`, so a caller can say "some orgs could not be loaded".
 */
export async function readMyOrgsAcrossGenerationsDetailed(
  client: PublicClient,
  addresses: ContractAddresses,
  account: Address,
): Promise<MyOrgsResult> {
  const generations = orgGenerations(addresses);
  if (generations.length === 0) requireOrgContracts(addresses); // throws, naming what is missing
  const failedGenerations: Address[] = [];
  const lists = await Promise.all(
    generations.map(async (g, i): Promise<MyOrgsResult> => {
      const contracts: OrgContracts = {
        factory: g.orgFactory,
        hook: g.projectHook,
        ...(g.projectEnumeration ? { enumeration: g.projectEnumeration } : {}),
        ...(g.lens ? { lens: g.lens } : {}),
      };
      try {
        return await readMyOrgsDetailed(client, contracts, account);
      } catch (err) {
        if (i === 0) throw err;
        // Not swallowed: an org list that silently omits every old-generation org reads as "you have none".
        failedGenerations.push(g.orgFactory);
        return { orgs: [], failed: [g.orgFactory] };
      }
    }),
  );
  return {
    orgs: lists.flatMap((l) => l.orgs).sort(newestFirst),
    failed: lists.flatMap((l) => l.failed),
    ...(failedGenerations.length > 0 ? { failedGenerations } : {}),
    ...(lists.some((l) => l.truncated) ? { truncated: true as const } : {}),
  };
}

/** {@link readMyOrgsAcrossGenerationsDetailed}, orgs only. */
export async function readMyOrgsAcrossGenerations(
  client: PublicClient,
  addresses: ContractAddresses,
  account: Address,
): Promise<MyOrg[]> {
  const { orgs, failed } = await readMyOrgsAcrossGenerationsDetailed(client, addresses, account);
  if (orgs.length === 0 && failed.length > 0) {
    throw new Error(`could not read any of this wallet's ${failed.length} org(s); check the RPC endpoint`);
  }
  return orgs;
}

/** The orgs an address administers across every factory generation, and what could not be read. */
export interface AdministeredOrgsResult {
  /** Orgs it administers, newest first (`roles` is `["admin"]`). */
  orgs: MyOrg[];
  /** Orgs it administers whose record could not be read: dropped from `orgs`, never silently. */
  failed: Address[];
  /** Factories whose list of the orgs it administers could not be read at all (generations, not orgs). */
  failedGenerations: Address[];
  /** A generation's list stopped at its cap (2,000): it administers more orgs than were read. */
  truncated?: true;
}

/**
 * Every org `account` ADMINISTERS, in every factory generation, newest first: the answer to "which org is mine",
 * read from each factory's administered list ({@link readOrgsAdministered}) alone. Unlike
 * {@link readMyOrgsAcrossGenerationsDetailed} it never reads the enumeration hook's HELD list: anyone can mint into a
 * wallet from an open org, so the held list is attacker-sized, and a failure to read it must not stand in the way of
 * deciding which org a wallet administers.
 *
 * Nothing here throws for one failed read: a factory whose list cannot be read is in `failedGenerations`, an
 * administered org whose record cannot be read is in `failed`. "Administers none" is a fact only when both are empty
 * and the result is not `truncated`.
 */
export async function readOrgsAdministeredAcrossGenerations(
  client: PublicClient,
  addresses: ContractAddresses,
  account: Address,
): Promise<AdministeredOrgsResult> {
  const generations = orgGenerations(addresses);
  if (generations.length === 0) requireOrgContracts(addresses); // throws, naming what is missing
  const failedGenerations: Address[] = [];
  const lists = await Promise.all(
    generations.map(async (g) => {
      try {
        return { factory: g.orgFactory, orgs: await readOrgsAdministered(client, g.orgFactory, account) };
      } catch {
        failedGenerations.push(g.orgFactory);
        return { factory: g.orgFactory, orgs: capped<Address>([], false) };
      }
    }),
  );
  const entries = lists.flatMap((l) => l.orgs.map((org) => ({ factory: l.factory, org })));
  const orgs: MyOrg[] = [];
  const failed: Address[] = [];
  for (let i = 0; i < entries.length; i += PROBE_SLICE) {
    const slice = entries.slice(i, i + PROBE_SLICE);
    const settled = await Promise.allSettled(slice.map(({ factory, org }) => readOrg(client, factory, org)));
    settled.forEach((r, j) => {
      if (r.status === "rejected") failed.push(slice[j]!.org);
      else if (r.value) orgs.push({ ...r.value, roles: ["admin"] });
    });
  }
  orgs.sort(newestFirst);
  return { orgs, failed, failedGenerations, ...(lists.some((l) => l.orgs.truncated) ? { truncated: true as const } : {}) };
}

/** Whether `who` may mint into `org` right now (it is the admin, or the org is open). */
export async function readMayMint(
  client: PublicClient,
  factory: Address,
  org: Address,
  who: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "mayMint",
    args: [org, who],
  })) as boolean;
}

/** The address `createOrg(_, _, salt)` would produce. */
export async function predictOrg(
  client: PublicClient,
  factory: Address,
  salt: Hex,
): Promise<Address> {
  return (await client.readContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "predictOrg",
    args: [salt],
  })) as Address;
}

// ─── The lens ────────────────────────────────────────────────────────────────

/**
 * Everything a gateway needs for one project in a single `eth_call`: whether the org is canonical,
 * what the project points at, and who owns it.
 *
 * An unregistered `org` returns `registered: false` and is never called — an arbitrary address is
 * not trusted to answer. A token that does not exist makes the lens revert, and this throws.
 */
export async function resolveProject(
  client: PublicClient,
  lens: Address,
  org: Address,
  tokenId: bigint,
): Promise<ResolvedProject> {
  const r = (await client.readContract({
    address: lens,
    abi: lensAbi,
    functionName: "resolve",
    args: [org, tokenId],
  })) as {
    registered: boolean;
    kind: number;
    cid: Hex;
    owner: Address;
    gateway: Hex;
  };

  return {
    registered: r.registered,
    kind: r.kind as ProjectKind,
    cid: /^0x0{64}$/.test(r.cid) ? null : asAbxfsCid(r.cid),
    owner: r.owner,
    gateway: r.gateway === "0x" ? null : new TextDecoder().decode(hexBytes(r.gateway)),
  };
}

function hexBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** How many publishes the hook has recorded across every org. Also the crawler's cursor origin. */
export async function readGlobalPublishCount(client: PublicClient, hook: Address): Promise<bigint> {
  return (await client.readContract({
    address: hook,
    abi: iProjectHookAbi,
    functionName: "globalPublishCount",
  })) as bigint;
}

/**
 * A window of the cross-org publish ledger, oldest first, with full records.
 *
 * This is the whole indexing story for anything that wants to see everything published: keep the
 * last index you read, poll {@link readGlobalPublishCount}, and ask for more from there. One address,
 * one cursor, no logs. The ledger is append-only, so a stored cursor stays valid forever.
 */
export async function readGlobalPublishes(
  client: PublicClient,
  lens: Address,
  opts: { start?: bigint; count?: number } = {},
): Promise<OrgPublish[]> {
  const rows = (await client.readContract({
    address: lens,
    abi: lensAbi,
    functionName: "publishRange",
    args: [opts.start ?? 0n, BigInt(opts.count ?? 100)],
  })) as readonly {
    org: Address;
    record: { cid: Hex; publisher: Address; publishedAt: number | bigint; version: number | bigint; tokenId: bigint };
  }[];

  return rows.map((r) => ({
    org: r.org,
    tokenId: r.record.tokenId,
    cid: asAbxfsCid(r.record.cid),
    publisher: r.record.publisher,
    publishedAt: Number(r.record.publishedAt),
    version: Number(r.record.version),
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function requireAccount(wallet: WalletClient) {
  const account = wallet.account;
  if (!account) throw new Error("walletClient has no account");
  return account;
}

export interface CreatedOrg {
  org: Address;
  /** The first project, minted to the creator in the same transaction. Always token 0. */
  firstTokenId: bigint;
  txHash: Hex;
}

/**
 * Create an org administered by the caller, and mint its first project to them.
 *
 * One transaction: the factory deploys the ABX collection, wires and locks the hooks, renounces
 * ownership, registers the org, and mints. There is no state in which an org exists half-built.
 *
 * `salt` is optional. `0x…0` (the default) is a plain deploy. Otherwise the address is deterministic,
 * and the salt's first 20 bytes must be zero (anyone may use it) or the caller (only they may).
 *
 * Waits until the new org and its first project are visible before returning. The caller's next act
 * is almost always a publish into token 0, which is gated on `ownerOf`, and a public RPC can serve
 * the next read from a replica that has not seen this write.
 */
export async function createOrg(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  factory: Address,
  args: {
    name: string;
    /**
     * Optional and PERMANENT: the collection description marketplaces show, and each token's fallback
     * description. Empty (the default) is allowed. See {@link validateOrgDescription}.
     */
    description?: string;
    salt?: Hex;
    /**
     * Called with the transaction hash IMMEDIATELY after it is submitted, before anything waits on it. A
     * caller that records the hash here still has it when the tab closes mid-wait; one that records it
     * after this function returns does not.
     */
    onSent?: (hash: Hex) => void;
  },
): Promise<CreatedOrg> {
  if (isRetiredFactory(factory)) throw new RetiredOrgGenerationError();
  assertWalletChain(clients.publicClient, clients.walletClient);
  validateOrgName(args.name);
  const description = args.description ?? "";
  validateOrgDescription(description);
  const account = requireAccount(clients.walletClient);
  const salt = args.salt ?? stringToHex("", { size: 32 });

  const { request } = await clients.publicClient.simulateContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "createOrg",
    args: [args.name, description, salt],
    account,
  });
  const txHash = await clients.walletClient.writeContract(request);
  args.onSent?.(txHash);
  const receipt = await waitForSuccessfulReceipt(clients.publicClient, txHash, "createOrg");

  const created = parseEventLogs({
    abi: iOrgFactoryAbi,
    eventName: "OrgCreated",
    logs: receipt.logs,
  }).find((l) => l.address.toLowerCase() === factory.toLowerCase());
  if (!created) throw new Error(`createOrg ${txHash} emitted no OrgCreated — did it revert quietly?`);

  const org = created.args.org as Address;

  const visible = await settle(async () => {
    if (!(await isOrg(clients.publicClient, factory, org))) return false;
    const owner = (await clients.publicClient.readContract({
      address: org,
      abi: seriesCodeAbi,
      functionName: "ownerOf",
      args: [0n],
    })) as Address;
    return owner.toLowerCase() === account.address.toLowerCase();
  });
  if (!visible) {
    throw new Error(
      `org ${org} was created in ${txHash} but is not visible yet — retry the read in a moment`,
    );
  }

  return { org, firstTokenId: 0n, txHash };
}

/**
 * Mint the next project in `org` to `to` (default: the caller), through the org's minter.
 *
 * Allowed for the org's admin, and anyone at all if the org is open. The recipient alone controls the project once
 * it is minted; the admin has no power over it.
 * Otherwise this throws before sending, naming the reason.
 *
 * @returns The minted token id, decoded from the receipt's `Transfer` log.
 */
export async function mintInOrg(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  org: Address,
  opts: {
    to?: Address;
    minter?: Address;
    addresses: ContractAddresses;
    /** Fires with the hash the moment the transaction is submitted, before any waiting. See {@link createOrg}. */
    onSent?: (hash: Hex) => void;
  },
): Promise<{ tokenId: bigint; txHash: Hex }> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  const account = requireAccount(clients.walletClient);

  // Before anything is read from `org` or sent anywhere: an address no ABX FS factory created is not
  // an org, and its `minter()` / `factory()` answers are whatever its deployer wants them to be.
  // The factory used below is the generation that created it, never one the minter names.
  if (opts.to) assertSafeRecipient(opts.to, { forbid: [org, ...abxfsContractAddresses(opts.addresses)], what: "mint target" });
  const generation = await generationOfOrg(clients.publicClient, opts.addresses, org);
  if (!generation) {
    throw new Error(`${org} was not created by an ABX FS org factory on this chain, so it is not an org`);
  }
  const factory = generation.orgFactory;
  if (opts.to) {
    assertSafeRecipient(opts.to, {
      forbid: [org, factory, generation.orgMinter, generation.projectHook, generation.projectEnumeration, generation.lens],
      what: "mint target",
    });
  }

  // The collection's own `minter()` is authoritative, and frozen when the org was created.
  const minter =
    opts.minter ??
    ((await clients.publicClient.readContract({
      address: org,
      abi: seriesCodeAbi,
      functionName: "minter",
    })) as Address);
  if (!minter || minter === ZERO) throw new Error(`org ${org} has no minter`);
  if (generation.orgMinter && minter.toLowerCase() !== generation.orgMinter.toLowerCase()) {
    throw new Error(`org ${org} names minter ${minter}, which is not its factory generation's minter`);
  }

  if (!(await readMayMint(clients.publicClient, factory, org, account.address))) {
    throw new Error(
      `${account.address} may not mint into org ${org} — it is admin-only unless the admin ` +
        `opens it`,
    );
  }

  const { request, result } = await clients.publicClient.simulateContract({
    address: minter,
    abi: orgMinterAbi,
    functionName: "mint",
    args: [org, opts.to ?? account.address],
    account,
  });
  const txHash = await clients.walletClient.writeContract(request);
  opts.onSent?.(txHash);
  // `result` is the id the simulation expected; another mint landing first could shift it, so the
  // receipt's own Transfer log decides.
  const tokenId = await mintedIdFromReceipt(clients.publicClient, org, txHash, result as bigint);

  // The caller's next act is a publish, gated on `ownerOf`. See `project.ts` for why this waits.
  const to = (opts.to ?? account.address).toLowerCase();
  await settle(async () => {
    const owner = (await clients.publicClient.readContract({
      address: org,
      abi: seriesCodeAbi,
      functionName: "ownerOf",
      args: [tokenId],
    })) as Address;
    return owner.toLowerCase() === to;
  });

  return { tokenId, txHash };
}

/** What chain state says about a write that was sent but never confirmed in this session. */
export type RecoveredWrite =
  | { state: "pending" }
  /** The transaction was mined and FAILED: nothing was minted, a fresh attempt is safe. */
  | { state: "reverted" }
  /**
   * The chain gave an answer that neither proves a mint nor proves its absence (a successful receipt with no
   * mint log from this org, or a token this account no longer holds). Never a cue to mint again: show the hash.
   */
  | { state: "unknown"; reason: string }
  | { state: "mined"; org: Address; tokenId: bigint };

async function receiptOrPending(client: PublicClient, hash: Hex) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (err) {
    // Not mined yet (or this replica has not seen it): that is "pending", never an error and never a cue to resend.
    if ((err as Error).name === "TransactionReceiptNotFoundError" || /not found|could not be found/i.test((err as Error).message)) return null;
    throw err;
  }
}

/**
 * After a mint's receipt wait timed out ({@link TransactionTimeoutError}), find out what happened by
 * READING CHAIN STATE instead of minting again: a retried mint would create a second, empty project.
 * `mined` carries the token id the first mint produced, so the caller publishes into it; `pending` means
 * keep waiting; `reverted` means nothing was minted and a fresh attempt is safe.
 */
export async function recoverMint(
  client: PublicClient,
  org: Address,
  hash: Hex,
  /** `holder`: who must hold the token now (the account that minted, or the `to` it minted for). Checked when given. */
  opts: { holder?: Address } = {},
): Promise<RecoveredWrite> {
  const receipt = await receiptOrPending(client, hash);
  if (!receipt) return { state: "pending" };
  if (receipt.status !== "success") return { state: "reverted" };
  const transfer = parseEventLogs({ abi: seriesCodeAbi, eventName: "Transfer", logs: receipt.logs }).find(
    (l) => l.address.toLowerCase() === org.toLowerCase() && (l.args.from as Address | undefined) === ZERO,
  );
  const id = transfer?.args.id as bigint | undefined;
  // A SUCCESSFUL receipt with no mint from this org is not evidence that nothing was minted (a different
  // transaction, a wrong org, a log shape this code does not know): it must never read as "reverted", which
  // tells the caller a fresh mint is safe and can leave a second empty project behind.
  if (id === undefined) {
    return { state: "unknown", reason: `transaction ${hash} succeeded but did not mint a project in ${org}` };
  }
  if (opts.holder) {
    let owner: string;
    try {
      owner = (await client.readContract({ address: org, abi: seriesCodeAbi, functionName: "ownerOf", args: [id] })) as string;
    } catch {
      return { state: "unknown", reason: `project #${id} could not be read back from ${org}` };
    }
    if (owner.toLowerCase() !== opts.holder.toLowerCase()) {
      return { state: "unknown", reason: `project #${id} in ${org} is no longer held by ${opts.holder} (it is held by ${owner})` };
    }
  }
  return { state: "mined", org, tokenId: id };
}

/** {@link recoverMint} for `createOrg`: the org the first transaction made, and its first project (token 0). */
export async function recoverCreateOrg(client: PublicClient, factory: Address | ContractAddresses, hash: Hex): Promise<RecoveredWrite> {
  const receipt = await receiptOrPending(client, hash);
  if (!receipt) return { state: "pending" };
  if (receipt.status !== "success") return { state: "reverted" };
  const factories = new Set((typeof factory === "string" ? [factory] : [...(factory.orgFactory ? [factory.orgFactory] : []), ...(factory.previousGenerations ?? []).map(g => g.orgFactory)]).map(a => a.toLowerCase()));
  const created = parseEventLogs({ abi: iOrgFactoryAbi, eventName: "OrgCreated", logs: receipt.logs }).filter(
    (l) => factories.has(l.address.toLowerCase()),
  );
  if (created.length !== 1) return { state: "unknown", reason: `transaction ${hash} succeeded but has ${created.length} matching org creations across the configured factories; refusing to guess` };
  return { state: "mined", org: created[0]!.args.org as Address, tokenId: 0n };
}

async function mintedIdFromReceipt(
  client: PublicClient,
  org: Address,
  txHash: Hex,
  expected: bigint,
): Promise<bigint> {
  // A timeout surfaces as TransactionTimeoutError ("may still confirm", with the hash): the mint is NOT
  // retried here, because a second mint would create a second empty project.
  const receipt = await waitForSuccessfulReceipt(client, txHash, "mint");
  const transfer = parseEventLogs({
    abi: seriesCodeAbi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).find(
    (l) =>
      l.address.toLowerCase() === org.toLowerCase() &&
      (l.args.from as Address | undefined) === ZERO,
  );
  const id = transfer?.args.id as bigint | undefined;
  if (id === undefined) {
    throw new Error(
      `mint ${txHash} succeeded but emitted no Transfer from ${org}; refusing to guess the token id ` +
        `(the simulation expected ${expected})`,
    );
  }
  return id;
}

/**
 * Every ABX FS contract address a configuration names, across EVERY generation (factory, minter, hook,
 * enumeration and lens of each): none is a sane recipient, and sending a project or an admin role to one
 * locks it. Callers building a `forbid` list for {@link assertSafeRecipient} use this.
 */
export function abxfsContractAddresses(a: ContractAddresses): (string | undefined)[] {
  const out: (string | undefined)[] = [a.orgFactory, a.orgMinter, a.projectHook, a.projectEnumeration, a.lens, a.projectPresentation, a.contentReader];
  for (const g of a.previousGenerations ?? []) out.push(g.orgFactory, g.orgMinter, g.projectHook, g.projectEnumeration, g.lens, g.projectPresentation);
  return out;
}

/** Offer the admin role to `to`. Nothing changes until they call {@link acceptAdmin}. */
export function transferAdmin(
  wallet: WalletClient,
  factory: Address,
  org: Address,
  to: Address,
  opts: { withdraw?: boolean; forbid?: readonly (string | undefined)[] } = {},
): Promise<Hex> {
  // `withdraw: true` offers to the zero address, which cancels a pending offer. It is the only
  // case where zero is acceptable.
  if (!(opts.withdraw && to === ZERO)) {
    assertSafeRecipient(to, { forbid: [org, factory, ...(opts.forbid ?? [])], what: "admin offer target" });
  }
  return wallet.writeContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "transferAdmin",
    args: [org, to],
    account: requireAccount(wallet),
    chain: wallet.chain,
  });
}

export function acceptAdmin(wallet: WalletClient, factory: Address, org: Address): Promise<Hex> {
  return wallet.writeContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "acceptAdmin",
    args: [org],
    account: requireAccount(wallet),
    chain: wallet.chain,
  });
}

export function setOrgOpen(
  wallet: WalletClient,
  factory: Address,
  org: Address,
  open: boolean,
): Promise<Hex> {
  return wallet.writeContract({
    address: factory,
    abi: iOrgFactoryAbi,
    functionName: "setOpen",
    args: [org, open],
    account: requireAccount(wallet),
    chain: wallet.chain,
  });
}

/** Decode an ABX `bytes32` org-name-sized label, trimming zero padding. Exported for symmetry with keys. */
export function decodeLabel(value: Hex): string {
  return hexToString(value, { size: 32 }).replace(/\0+$/, "");
}
