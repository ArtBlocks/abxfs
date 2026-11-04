/**
 * A failure with an HTTP status, safe to show to the visitor. Anything else becomes a generic 502.
 *
 * `negativeCacheable` marks a 404 that says "nothing lives at this address" (an org the factory did not
 * create, a token that does not exist), which a shared cache may hold for a few seconds so that bots
 * walking nonexistent hosts are absorbed at the edge. A 404 that says "not yet" (a project that has not
 * published) never sets it.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly negativeCacheable: boolean = false,
    /**
     * Seconds a shared cache may hold THIS 404, when shorter than the gateway's own `notFoundTtl`. A
     * 404 for something that may exist a moment later (a token a lagging RPC replica has not seen yet)
     * must not be pinned for the full TTL.
     */
    readonly negativeTtl?: number,
    /**
     * Seconds a shared cache may hold THIS error, for a failure that is a fact about immutable content rather than
     * about the moment: a file over the size limit (413), stored with a codec this gateway cannot decode (501), or
     * whose decoded content does not match its `outputHash` (502). The message is then the visitor's to read.
     */
    readonly edgeTtl?: number,
  ) {
    super(message);
  }
}
