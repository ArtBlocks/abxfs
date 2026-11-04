/**
 * Public types for @abxfs/pinning.
 *
 * Pinning hands a service exactly the IPFS DAG derived from chain: every raw leaf and dag-pb node under one root, as a
 * CARv1 (Content Addressable aRchive). The service imports the blocks and pins the root; it rebuilds nothing. So the
 * pinned root is the derived root by construction, for any tree: empty directories, empty files and files stored with
 * a codec (whose IPFS form is their decoded content) pin like everything else.
 */
import type { IpfsCid } from "@abxfs/sdk";

/**
 * A service that can import a CAR and pin its root. Built-in: {@link localPinningProvider} (Kubo) and
 * {@link pinataPinningProvider} (Pinata). Anything else that accepts a CARv1 is a few lines to wrap.
 */
export interface PinningProvider {
  /** Provider name for diagnostics ("local", "pinata", or custom). */
  readonly name: string;
  /**
   * Import `car` (a CARv1 whose header names `root` and which holds every block under it), pin `root`, and return the
   * root CID the service reports. The orchestrator compares that with the root it derived; the service's word is not
   * taken for it.
   */
  pinCar(args: { root: IpfsCid; car: Blob; name: string }): Promise<{ pinnedCid: IpfsCid }>;
  /**
   * Check, cheaply and before any content is read from chain or hashed, that the service is there and accepts the
   * credential: Kubo answers `/api/v0/version`, Pinata accepts the key. Throws, naming the endpoint's host, when not.
   * Optional for a custom provider.
   */
  preflight?(): Promise<void>;
  /** Best-effort unpin. */
  unpin(cid: IpfsCid): Promise<void>;
  /** Whether the provider has a pin recorded for {@link cid}. */
  isPinned(cid: IpfsCid): Promise<boolean>;
}

/** A file in a pinned tree: its first path (`""` for a file root) and the IPFS CID of its content. */
export interface PinnedFile {
  path: string;
  ipfsCid: IpfsCid;
}
