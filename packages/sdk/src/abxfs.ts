/**
 * Top-level ABX FS client. A thin wrapper around the functional modules for ergonomics.
 *
 * The project surface takes a **token id**, not a project id: an ABX FS project is an ABX NFT in an
 * org, so project methods act on the org the client is bound to (`forOrg`) and the hook comes from
 * `addresses.projectHook`. Org-level methods (`createOrg`, `myOrgs`, …) need only the factory.
 * Content-layer methods (`upload`, `readFile`, `readDirectory`, …) need neither and work against any
 * ABX FS deployment.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import type {
  AbxfsCid,
  ContractAddresses,
  FileCodec,
  Directory,
  DirectoryEntry,
  FileDescriptor,
  IpfsCid,
} from "./types.js";
import {
  uploadFiles,
  uploadSingleFile,
  planUpload,
  type UploadOptions,
  type UploadResult,
} from "./upload.js";
import { cidKind, locateContent, type ContentLocation } from "./kind.js";
import { contentStores, type ContentStores } from "./stores.js";
import type { ProjectKind } from "./types.js";
import {
  listTags,
  publishVersion,
  readProject,
  readTag,
  readTokenLinks,
  readVersionHistory,
  readVersionHistoryPage,
  readTagPage,
  type VersionHistoryPage,
  type TagPage,
  type TokenLinks,
  waitForVersion,
  assertCanPublish,
  readRecentProjects,
  readPublishFeed,
  readPublishCount,
  readOwnedProjects,
  readEmptyOwnedProjects,
  readTrackedTokens,
  readPublishPage,
  iteratePublishLedger,
  iterateOwnedProjects,
  type PublishPage,
  type ProjectIndexes,
  type PublishRecord,
  removeTag,
  setPreferredGateway,
  setViewUrl,
  setProjectName,
  setTag,
  transferProject,
  type AbxfsProject,
  type ProjectContracts,
  type ProjectTag,
  type ProjectVersion,
} from "./project.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { assertValidPublishInputs } from "./validate.js";
import { publishRootAndTag, type PublishAndTagPhase } from "./publish.js";
import {
  acceptAdmin,
  createOrg,
  mintInOrg,
  readGlobalPublishCount,
  readGlobalPublishes,
  readMayMint,
  readMyOrgsAcrossGenerations,
  readOrg,
  readOrgCount,
  requireOrgContracts,
  setOrgOpen,
  transferAdmin,
  type CreatedOrg,
  type MyOrg,
  type Org,
  type OrgContracts,
  type OrgPublish,
  addressesForOrg,
  abxfsContractAddresses,
  generationOfOrg,
  recoverCreateOrg,
  recoverMint,
  type RecoveredWrite,
} from "./org.js";
import {
  readFile,
  readFileByPath,
  readDirectory,
  resolvePath,
  lookupEntry,
  walkDirectory,
  walkDirectoryTree,
  type WalkedTree,
  fileChunkCount,
  getFileChunkIdsPage,
  directoryEntryCount,
  getDirectoryEntriesPage,
  type ReadFileOptions,
} from "./read.js";
import {
  diffProject,
  updateProject,
  type Diff,
  type UpdateProjectArgs,
} from "./update.js";
import {
  applyDraftToBase,
  applyNewProject,
  applyFileReplacement,
  executeDraftPublish,
  executeNewProjectPublish,
  planPublish,
  type AppliedDraft,
  type ApplyDraftOptions,
  type DraftOp,
  type ExecuteDraftPublishOptions,
  type ExecuteDraftPublishResult,
  type ExecuteNewProjectPublishOptions,
  type ExecuteNewProjectPublishResult,
  type PlanPublishOptions,
  type TxPlan,
} from "./draft.js";
import { verifyLocalIpfsCid, verifyOnChainIpfsCid, assertIpfsCidAgreement } from "./verify.js";
import { assertWalletChain } from "./wallet-chain.js";

export interface AbxfsClientOptions {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  addresses: ContractAddresses;
  /**
   * The org this client's project methods act on. Projects live in orgs, and token ids repeat across
   * them, so every project read and write needs one. Leave unset for the content layer and the
   * org-level methods, and bind one with {@link AbxfsClient.forOrg}.
   */
  org?: Address;
  /**
   * The chain's FULL registry (current generation plus `previousGenerations`), when `addresses` is the
   * view of one org's own, possibly superseded, generation. Set by {@link AbxfsClient.resolveOrg}. Org-level
   * methods that are about the chain, not the bound org (`createOrg`, `orgCount`, `myOrgs`, the recipient
   * safety lists) use it, so a client resolved to an old org still creates new orgs in the CURRENT factory.
   */
  registry?: ContractAddresses;
}

/** Create an ABX FS client from a viem public/wallet client pair and contract addresses. */
export class AbxfsClient {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly addresses: ContractAddresses;
  /** The org project methods act on, if bound. See {@link forOrg}. */
  readonly org?: Address;
  /** See {@link AbxfsClientOptions.registry}. Defaults to `addresses`. */
  readonly registry: ContractAddresses;

  constructor(opts: AbxfsClientOptions) {
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.addresses = opts.addresses;
    this.org = opts.org;
    this.registry = opts.registry ?? opts.addresses;
  }

  /**
   * The same client, bound to `org`, assuming `org` was made by the factory these addresses name.
   * Cheap and synchronous, which is right for an org just created here. For an org that could
   * predate the current factory — anything a user typed or followed a link to — use
   * {@link resolveOrg}: bound to the wrong generation, a publish reads the wrong hook's history.
   */
  forOrg(org: Address): AbxfsClient {
    return new AbxfsClient({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      addresses: this.addresses,
      org,
      registry: this.registry,
    });
  }

  /**
   * Bound to `org` through the factory generation that created it. One `eth_call` per generation
   * tried, newest first. Throws if no ABX FS factory created `org`.
   */
  async resolveOrg(org: Address): Promise<AbxfsClient> {
    const addresses = await addressesForOrg(this.publicClient, this.registry, org);
    if (!addresses) {
      throw new Error(`${org} was not created by an ABX FS org factory on this chain, so it is not an org`);
    }
    return new AbxfsClient({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      addresses,
      org,
      registry: this.registry,
    });
  }

  // ─── orgs ──────────────────────────────────────────────────────────────────

  /**
   * Create an org administered by the connected account, and mint its first project to it.
   *
   * Always created in the CURRENT factory (the registry's top-level one), even on a client that
   * {@link resolveOrg} bound to a superseded org: a new org frozen into a dead generation would carry its
   * bugs forever.
   */
  createOrg(args: { name: string; description?: string; salt?: Hex; onSent?: (hash: Hex) => void }): Promise<CreatedOrg> {
    this._requireWallet();
    return createOrg(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      requireOrgContracts(this.registry).factory,
      args,
    );
  }

  /**
   * Check, before paying for any content, that the connected account holds `tokenId` in the bound org and
   * (optionally) that its head is what you built on. See {@link assertCanPublish}.
   */
  assertCanPublish(tokenId: bigint, opts: { expectedHead?: AbxfsCid | null } = {}) {
    this._requireWallet();
    return assertCanPublish(this.publicClient, this._project(), tokenId, this.walletClient!.account?.address, opts);
  }

  /** What became of a mint into the bound org whose receipt wait timed out. See {@link recoverMint}. */
  recoverMint(hash: Hex, opts?: { holder?: Address }): Promise<RecoveredWrite> {
    return recoverMint(this.publicClient, this._requireOrg(), hash, opts);
  }

  /** What became of a `createOrg` whose receipt wait timed out. See {@link recoverCreateOrg}. */
  recoverCreateOrg(hash: Hex): Promise<RecoveredWrite> {
    return recoverCreateOrg(this.publicClient, requireOrgContracts(this.registry).factory, hash);
  }

  /** One org's record, or `null` if the factory does not know the address. */
  async readOrg(org: Address): Promise<Org | null> {
    this._orgs(); // throws, naming what is missing, when the chain has no org layer
    const generation = await generationOfOrg(this.publicClient, this.registry, org);
    return generation ? readOrg(this.publicClient, generation.orgFactory, org) : null;
  }

  /** Every org an address administers or holds a project in, newest first. */
  myOrgs(account: Address): Promise<MyOrg[]> {
    this._orgs(); // throws, naming what is missing, when the chain has no org layer
    return readMyOrgsAcrossGenerations(this.publicClient, this.registry, account);
  }

  /** How many orgs the current factory has created. Earlier generations have their own count. */
  orgCount(): Promise<bigint> {
    return readOrgCount(this.publicClient, requireOrgContracts(this.registry).factory);
  }

  /** Whether `who` may mint into the bound org right now. */
  mayMint(who: Address): Promise<boolean> {
    return readMayMint(this.publicClient, this._orgs().factory, this._requireOrg(), who);
  }

  /** Mint the next project in the bound org (default recipient: the connected account). */
  mintProject(opts?: { to?: Address; onSent?: (hash: Hex) => void }) {
    this._requireWallet();
    return mintInOrg(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      this._requireOrg(),
      { ...opts, addresses: this.registry },
    );
  }

  transferAdmin(to: Address) {
    this._requireWallet();
    return this._confirmed(transferAdmin(this.walletClient!, this._orgs().factory, this._requireOrg(), to, { forbid: abxfsContractAddresses(this.registry) }), "transferAdmin");
  }

  acceptAdmin() {
    this._requireWallet();
    return this._confirmed(acceptAdmin(this.walletClient!, this._orgs().factory, this._requireOrg()), "acceptAdmin");
  }

  setOpen(open: boolean) {
    this._requireWallet();
    return this._confirmed(setOrgOpen(this.walletClient!, this._orgs().factory, this._requireOrg(), open), "setOpen");
  }

  /** One window of the cross-org publish ledger, oldest first. The crawler's whole API. */
  globalPublishes(opts?: { start?: bigint; count?: number }): Promise<OrgPublish[]> {
    const lens = this.addresses.lens;
    if (!lens) throw new Error("this chain has no ABX FS lens configured");
    return readGlobalPublishes(this.publicClient, lens, opts);
  }

  /** Total publishes across every org. Also the crawler's cursor origin. */
  globalPublishCount(): Promise<bigint> {
    const hook = this.addresses.projectHook;
    if (!hook) throw new Error("this chain has no ABX FS hook configured");
    return readGlobalPublishCount(this.publicClient, hook);
  }

  // ─── upload / create ────────────────────────────────────────────────────────
  /** A dry run (`opts.dryRun`) computes the plan and the root and needs no wallet. */
  upload(files: FileDescriptor[], opts?: UploadOptions): Promise<UploadResult> {
    if (!opts?.dryRun) this._requireWallet();
    return uploadFiles(
      { publicClient: this.publicClient, walletClient: this.walletClient },
      this.addresses,
      files,
      opts,
    );
  }

  /** Upload a single file as the root of a future file-kind project. See
   *  {@link uploadSingleFile} for the kind-discovery semantics. A dry run needs no wallet. */
  uploadFile(file: FileDescriptor, opts?: UploadOptions): Promise<UploadResult> {
    if (!opts?.dryRun) this._requireWallet();
    return uploadSingleFile(
      { publicClient: this.publicClient, walletClient: this.walletClient },
      this.addresses,
      file,
      opts,
    );
  }

  planUpload(files: FileDescriptor[], opts?: { codec?: FileCodec; fastLz?: boolean; emptyDirectories?: readonly string[] }) {
    return planUpload(files, { addresses: this.addresses, ...opts });
  }

  /**
   * Publish a root CID as the project's current version.
   *
   * A project IS an ABX token, so it is brought into existence by MINTING (`mintInOrg`: the org's admin,
   * or anyone while the org is open), not by an ABX FS call. Mint, then publish into the token you own —
   * which is also what lets you publish into a token you bought.
   */
  publishVersion(tokenId: bigint, rootCid: AbxfsCid) {
    this._requireWallet();
    return this._confirmed(publishVersion(this.walletClient!, this._project(), tokenId, rootCid), "publishVersion");
  }

  /** Set `abxfs.name`. Metadata only — a project is always named by chain, org and token id. */
  setProjectName(tokenId: bigint, name: string) {
    assertValidPublishInputs({ name });
    this._requireWallet();
    return this._confirmed(setProjectName(this.walletClient!, this._project(), tokenId, name), "setProjectName");
  }

  /**
   * Set where the project's token links point on marketplaces (`abxfs.view`): the whole URL, used as
   * is. Pass `""` to clear it and fall back to the default on the ABX FS site.
   */
  setViewUrl(tokenId: bigint, url: string) {
    this._requireWallet();
    return this._confirmed(setViewUrl(this.walletClient!, this._project(), tokenId, url), "setViewUrl");
  }

  /** Set the project's preferred IPFS gateway prefix. Pass `""` to clear it. */
  setPreferredGateway(tokenId: bigint, gateway: string) {
    this._requireWallet();
    return this._confirmed(setPreferredGateway(this.walletClient!, this._project(), tokenId, gateway), "setPreferredGateway");
  }

  /**
   * Transfer the project: an ERC-721 transfer moves publish rights, tag rights, and the token together.
   */
  transferProject(tokenId: bigint, to: Address) {
    this._requireWallet();
    return this._confirmed(transferProject(this.walletClient!, this._project(), tokenId, to, { forbid: abxfsContractAddresses(this.registry) }), "transferProject");
  }

  /**
   * Resolve the kind of a loose root CID by probing both stores. Returns {@link ProjectKind.Unset}
   * when the CID is in neither — the same value the hook reports for an unpublished project. Useful
   * for predicting whether a publish will pass the hook's kind check before spending gas.
   */
  cidKind(cid: AbxfsCid): Promise<ProjectKind> {
    return cidKind(this.publicClient, this.addresses, cid);
  }


  // ─── update ────────────────────────────────────────────────────────────────
  diff(
    existingRootCid: AbxfsCid,
    newFiles: FileDescriptor[],
    opts?: { codec?: FileCodec; fastLz?: boolean; emptyDirectories?: readonly string[] },
  ): Promise<Diff> {
    return diffProject(this.publicClient, this.addresses, existingRootCid, newFiles, opts);
  }

  update(args: UpdateProjectArgs) {
    this._requireWallet();
    return updateProject(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      this.addresses,
      args,
    );
  }

  // ─── high-level publish (plan-driven, multicall-batched, atomic-tag) ────────
  //
  // These wrap `applyNewProject` / `applyDraftToBase` + `planPublish` +
  // `executeNewProjectPublish` / `executeDraftPublish` into a single call so
  // UI callers can render a precise tx breakdown before the user signs and
  // get phase-level lifecycle events as the on-chain work progresses.
  //
  // These helpers:
  //   - batch chunks / file-creates / dir-creates ACROSS files via multicall
  //     (saves N-1 prompts per phase),
  //   - emit `onPhase` so the modal can flip step rows in lockstep with chain
  //     progress (no more "bundle 0 of 1" mystery rows),
  //   - report the version number the hook actually assigned, read back after the publish lands
  //     rather than predicted.
  //
  // A tagged publish costs one extra tx: the CID write lands on the ABX collection and the tag on
  // the hook, so no single-contract multicall can span them. A wallet with EIP-5792 support can
  // still present the pair as one approval.

  /**
   * Plan a new-project publish without sending any txs. Returns the
   * `AppliedDraft` (root CID + per-file plan) and the `TxPlan` (concrete
   * bundles + final create/tag step) so the UI can preview exactly what
   * the user will sign for.
   */
  async planNewProject(
    files: FileDescriptor[],
    args: { tag?: string; name?: string; opts?: ApplyDraftOptions & PlanPublishOptions } = {},
  ): Promise<{ applied: AppliedDraft; plan: TxPlan }> {
    assertValidPublishInputs({ tag: args.tag, name: args.name });
    const applied = await applyNewProject(this.publicClient, this.addresses, files, args.opts);
    const plan = await planPublish(this.publicClient, this.addresses, applied, {
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      // A new project always sets a name, and that is its own transaction. Forwarding it is what
      // lets the plan report the real number of wallet prompts.
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...args.opts,
    });
    return { applied, plan };
  }

  /**
   * Publish a project's FIRST version end-to-end: chunks → files → dirs → publish (+ tag, + name).
   * Reuses the same multicall packer as `publishUpdate`, so a 50-file upload runs in ~3 bundled
   * prompts for the content plus one per trailing param write.
   *
   * `tokenId` must already exist and be owned by the signer — minting is an ABX mint, deliberately a
   * separate step. Pass `applied` if you already ran `planNewProject`.
   */
  async publishNewProject(args: {
    tokenId: bigint;
    name: string;
    files: FileDescriptor[];
    tag?: string;
    applied?: AppliedDraft;
    opts?: ApplyDraftOptions & ExecuteNewProjectPublishOptions;
  }): Promise<ExecuteNewProjectPublishResult> {
    // First thing, ahead of `applyNewProject` and every transaction.
    assertValidPublishInputs({ tag: args.tag, name: args.name });
    this._requireWallet();
    const applied =
      args.applied ?? (await applyNewProject(this.publicClient, this.addresses, args.files, args.opts));
    return executeNewProjectPublish(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      this.addresses,
      this._project(),
      args.tokenId,
      args.name,
      applied,
      { tag: args.tag, ...args.opts },
    );
  }

  /**
   * Plan a new version of a **file-kind** project — one whose root is a file, not a directory.
   *
   * Only projects created outside the web app have this shape (`abxfs upload --kind file`), and the
   * kind is locked for life, so this is the single way such a project can ever be edited. The
   * ordinary update path walks the base root as a directory and reverts against one.
   */
  async planFileUpdate(args: {
    baseRootCid: AbxfsCid;
    bytes: Uint8Array;
    mimeType?: string;
    path?: string;
    tag?: string;
    opts?: ApplyDraftOptions & PlanPublishOptions;
  }): Promise<{ applied: AppliedDraft; plan: TxPlan }> {
    const applied = await applyFileReplacement(
      this.publicClient,
      this.addresses,
      args.baseRootCid,
      {
        bytes: args.bytes,
        ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
      },
      args.opts,
    );
    const plan = await planPublish(this.publicClient, this.addresses, applied, {
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      ...args.opts,
    });
    return { applied, plan };
  }

  /**
   * Plan an update / new-version publish for an existing project without
   * sending any txs. Same return shape as `planNewProject` so the UI can
   * share rendering code across both flows.
   */
  async planUpdate(args: {
    baseRootCid: AbxfsCid;
    ops: DraftOp[];
    tag?: string;
    opts?: ApplyDraftOptions & PlanPublishOptions;
  }): Promise<{ applied: AppliedDraft; plan: TxPlan }> {
    const applied = await applyDraftToBase(
      this.publicClient,
      this.addresses,
      args.baseRootCid,
      args.ops,
      args.opts,
    );
    const plan = await planPublish(this.publicClient, this.addresses, applied, {
      tag: args.tag,
      ...args.opts,
    });
    return { applied, plan };
  }

  /**
   * Publish a new version end-to-end via the delta pipeline: writes only
   * the chunks / files / dirs that aren't already on chain, then writes the
   * `abxfs.cid` param (plus the tag, when supplied).
   *
   * Pass `applied` if you already ran `planUpdate`; otherwise we compute
   * it for you.
   */
  async publishUpdate(args: {
    tokenId: bigint;
    baseRootCid: AbxfsCid;
    ops: DraftOp[];
    tag?: string;
    applied?: AppliedDraft;
    opts?: ApplyDraftOptions & ExecuteDraftPublishOptions;
  }): Promise<ExecuteDraftPublishResult> {
    assertValidPublishInputs({ tag: args.tag });
    this._requireWallet();
    const applied =
      args.applied ??
      (await applyDraftToBase(
        this.publicClient,
        this.addresses,
        args.baseRootCid,
        args.ops,
        args.opts,
      ));
    return executeDraftPublish(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      this.addresses,
      this._project(),
      args.tokenId,
      applied,
      { tag: args.tag, expectedHead: args.baseRootCid, ...args.opts },
    );
  }

  // ─── read ──────────────────────────────────────────────────────────────────
  readFile(cid: AbxfsCid, options?: ReadFileOptions) {
    return readFile(this.publicClient, this.addresses, cid, options);
  }

  readFileByPath(rootCid: AbxfsCid, path: string, options?: ReadFileOptions) {
    return readFileByPath(this.publicClient, this.addresses, rootCid, path, options);
  }

  readDirectory(cid: AbxfsCid, opts: { maxEntries?: number } = {}): Promise<Directory> {
    return readDirectory(this.publicClient, this.addresses, cid, opts);
  }

  resolvePath(rootCid: AbxfsCid, path: string) {
    return resolvePath(this.publicClient, this.addresses, rootCid, path);
  }

  walkDirectory(rootCid: AbxfsCid): Promise<Array<{ path: string; cid: AbxfsCid }>> {
    return walkDirectory(this.publicClient, this.addresses, rootCid);
  }

  /** {@link walkDirectory} plus the tree's empty directories, which are part of its root. */
  walkDirectoryTree(rootCid: AbxfsCid): Promise<WalkedTree> {
    return walkDirectoryTree(this.publicClient, this.addresses, rootCid);
  }

  /** One entry of a directory by exact name (its bytes, or its text form as a listing gives it): a binary search on chain. */
  lookupEntry(dirCid: AbxfsCid, name: string | Uint8Array) {
    return lookupEntry(this.publicClient, this.addresses, dirCid, name);
  }

  /** What a root CID is: a file or a directory (or unset). */
  locateContent(cid: AbxfsCid): Promise<ContentLocation> {
    return locateContent(this.publicClient, this.addresses, cid);
  }

  /** The content stores this client reads and writes. Throws when its address book has none. */
  get contentStores(): ContentStores {
    return contentStores(this.addresses);
  }

  // ─── projects (ABX tokens) ─────────────────────────────────────────────────

  /** Full current state of a project: owner, name, head CID, kind, version count, gateway. */
  readProject(tokenId: bigint): Promise<AbxfsProject> {
    return readProject(this.publicClient, this._project(), tokenId);
  }

  /**
   * The links this project's token shows on marketplaces (`animation_url`, `external_url`), as its metadata renders
   * them: read from the renderer of this client's `orgMeta`, so bind the client with {@link resolveOrg} first.
   */
  readTokenLinks(tokenId: bigint): Promise<TokenLinks> {
    const orgMeta = this.addresses.orgMeta;
    if (!orgMeta) throw new Error("ABX FS client has no `orgMeta` configured — required to read a token's links");
    return readTokenLinks(this.publicClient, orgMeta, this._requireOrg(), tokenId);
  }

  /** Version history from the hook — one `eth_call`, no log-range limits. */
  projectVersions(
    tokenId: bigint,
    opts?: { start?: number; end?: number; limit?: number },
  ): Promise<ProjectVersion[]> {
    return readVersionHistory(this.publicClient, this._project(), tokenId, opts);
  }

  /** One page of history, newest page first, with a cursor for "load more". */
  projectVersionsPage(tokenId: bigint, opts?: { before?: number; limit?: number }): Promise<VersionHistoryPage> {
    return readVersionHistoryPage(this.publicClient, this._project(), tokenId, opts);
  }

  /** One page of tag names, newest page first, with a cursor for "load more". */
  tagPage(tokenId: bigint, opts?: { before?: number; limit?: number }): Promise<TagPage> {
    return readTagPage(this.publicClient, this._project(), tokenId, opts);
  }

  /**
   * Publish a root and optionally tag it. The one shared implementation: counts before, aborts if the
   * count cannot be read, takes the version from the receipt, proves it with a settled read, and only
   * then tags. Used by the draft path and by the CLI's `upload` and `update`.
   */
  publishAndTag(
    tokenId: bigint,
    rootCid: AbxfsCid,
    opts?: { tag?: string; onPhase?: (phase: PublishAndTagPhase) => void },
  ) {
    assertValidPublishInputs({ tag: opts?.tag });
    this._requireWallet();
    return publishRootAndTag(
      { publicClient: this.publicClient, walletClient: this.walletClient! },
      this._project(),
      tokenId,
      rootCid,
      opts,
    );
  }

  /**
   * The most recently active projects, newest first, one row per project.
   *
   * Reads the hook's publish ledger — one `eth_call` against state. Keyed on publication rather than
   * minting: mint is open and free, so a mint-based feed would surface empty tokens and be trivially
   * spammed.
   */
  recentProjects(opts?: { limit?: number; maxScan?: number }): Promise<PublishRecord[]> {
    return readRecentProjects(this.publicClient, this._project(), opts);
  }

  /** Raw publish ledger entries, newest first. Pass `before` to page. */
  publishFeed(opts?: { limit?: number; before?: bigint }): Promise<PublishRecord[]> {
    return readPublishFeed(this.publicClient, this._project(), opts);
  }

  /** How many publishes this collection has recorded, ever. Also the paging cursor origin. */
  publishCount(): Promise<bigint> {
    return readPublishCount(this.publicClient, this._project());
  }

  /**
   * Projects owned by an address, from the transfer hook's index.
   *
   * Returns `undefined` when no enumeration hook is configured — distinct from owning nothing, and
   * worth keeping distinct: collapsing them tells someone they own no projects when the truth is
   * their projects are not indexed.
   */
  projectsByOwner(owner: Address): Promise<bigint[] | undefined> {
    return readOwnedProjects(this.publicClient, this._indexes(), owner);
  }

  /**
   * Tokens this address holds in the bound org that were minted and never published to, newest first. Ask
   * before minting: publishing into one of these beats leaving a second empty project. `undefined` when no
   * enumeration hook is configured. See {@link readEmptyOwnedProjects}.
   */
  emptyProjectsOf(owner: Address, opts: { limit?: number; scan?: number } = {}): Promise<bigint[] | undefined> {
    return readEmptyOwnedProjects(this.publicClient, this._indexes(), owner, opts);
  }

  /**
   * Wait until the hook has recorded at least `count` versions for a project.
   *
   * Needed between a publish and anything that reads the version back — tagging, most obviously.
   * See `settle.ts` for why a receipt is not enough.
   */
  waitForVersion(tokenId: bigint, count: number): Promise<void> {
    return waitForVersion(this.publicClient, this._project(), tokenId, count);
  }

  /** One page of the publish ledger, newest first, with a cursor to continue from. */
  publishPage(opts?: { limit?: number; before?: bigint }): Promise<PublishPage> {
    return readPublishPage(this.publicClient, this._project(), opts);
  }

  /** Walk the whole publish ledger, oldest first, without holding it all in memory. */
  ledger(opts?: { pageSize?: number }) {
    return iteratePublishLedger(this.publicClient, this._project(), opts);
  }

  /** Walk every token an address owns, a page at a time. */
  ownedProjects(owner: Address, opts?: { pageSize?: number }) {
    return iterateOwnedProjects(this.publicClient, this._indexes(), owner, opts);
  }

  /** A window of this org's tokens, ids `0 … nextTokenId() - 1` (see {@link readTrackedTokens}). */
  trackedTokens(opts?: { start?: bigint; limit?: number }): Promise<bigint[] | undefined> {
    return readTrackedTokens(this.publicClient, this._indexes(), opts);
  }

  // ─── tags ──────────────────────────────────────────────────────────────────

  /** Resolve a tag. `"latest"` is virtual and always resolves to the head. */
  readTag(tokenId: bigint, tag: string): Promise<ProjectTag> {
    return readTag(this.publicClient, this._project(), tokenId, tag);
  }

  /** Every tag on a project. Excludes the virtual `"latest"`. */
  listTags(tokenId: bigint, opts?: { limit?: number }): Promise<string[]> {
    return listTags(this.publicClient, this._project(), tokenId, opts);
  }

  setTag(tokenId: bigint, tag: string, version: number) {
    this._requireWallet();
    return this._confirmed(setTag(this.walletClient!, this._project(), tokenId, tag, version), "setTag");
  }

  removeTag(tokenId: bigint, tag: string) {
    this._requireWallet();
    return this._confirmed(removeTag(this.walletClient!, this._project(), tokenId, tag), "removeTag");
  }


  // ─── verify ────────────────────────────────────────────────────────────────
  verifyLocalIpfsCid(cid: AbxfsCid): Promise<IpfsCid> {
    return verifyLocalIpfsCid(this.publicClient, this.addresses, cid);
  }

  verifyOnChainIpfsCid(cid: AbxfsCid): Promise<IpfsCid> {
    return verifyOnChainIpfsCid(this.publicClient, this.addresses, cid);
  }

  assertIpfsCidAgreement(cid: AbxfsCid) {
    return assertIpfsCidAgreement(this.publicClient, this.addresses, cid);
  }

  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Every write this client sends is confirmed before it is reported, because a mined-but-reverted
   * transaction still has a hash. Resolves the hash once the receipt says `success`, and throws otherwise.
   */
  private async _confirmed(sent: Promise<Hex> | Hex, what: string): Promise<Hex> {
    const hash = await sent;
    await waitForSuccessfulReceipt(this.publicClient, hash, what);
    return hash;
  }

  private _requireWallet(): void {
    if (!this.walletClient) throw new Error("ABX FS client has no walletClient — reads only");
    assertWalletChain(this.publicClient, this.walletClient);
  }

  /**
   * The ABX collection + hook pair every project method needs.
   *
   * Both are optional on {@link ContractAddresses} because the content layer is independently
   * useful — `/cid/<chain>/<root>` resolves content whether or not any token points at it — so a
   * content-only deployment is a legitimate configuration rather than a misconfiguration.
   */
  private _project(): ProjectContracts {
    const collection = this._requireOrg();
    const hook = this.addresses.projectHook;
    if (!hook) {
      throw new Error(
        "ABX FS client has no `projectHook` configured — required for version history and tags",
      );
    }
    return {
      collection,
      hook,
      ...(this.addresses.projectEnumeration ? { enumeration: this.addresses.projectEnumeration } : {}),
    };
  }

  /**
   * Both indexes, for the reads that need the transfer hook. `enumeration` stays optional: a
   * deployment that never armed it simply has no owner index, and the reads report that as
   * `undefined` rather than as an empty result.
   */
  private _indexes(): ProjectIndexes {
    return {
      ...this._project(),
      ...(this.addresses.projectEnumeration
        ? { enumeration: this.addresses.projectEnumeration }
        : {}),
    };
  }

  private _requireOrg(): Address {
    const org = this.org;
    if (!org) {
      throw new Error(
        "ABX FS client is not bound to an org — call `client.forOrg(org)`; projects live in orgs",
      );
    }
    return org;
  }

  private _orgs(): OrgContracts {
    return requireOrgContracts(this.addresses);
  }
}

export type { DirectoryEntry, UploadResult, UploadOptions, Diff, UpdateProjectArgs };
