/**
 * Error fixtures shaped like what viem REALLY raises (pinned against a fake JSON-RPC server in
 * `audit4/Audit4Classifier.test.ts`), so a handler test does not hand-build a "revert" that the classifier
 * rightly refuses to believe.
 */
type Layer = { name?: string; message: string; cause?: unknown; code?: number; details?: string; data?: unknown; status?: number };

function layer(l: Layer): Error {
  return Object.assign(new Error(l.message), l);
}

/** `ContractFunctionExecutionError > CallExecutionError > ExecutionRevertedError > RpcRequestError(code) > raw`. */
export function revertError(message = "execution reverted", code = 3): Error {
  const raw = { code, message, data: "0x" };
  const rpc = layer({ name: "RpcRequestError", message: `RPC Request failed.\n\nDetails: ${message}`, details: message, code, cause: raw });
  const reverted = layer({ name: "ExecutionRevertedError", message: "Execution reverted", details: message, cause: rpc });
  const call = layer({ name: "CallExecutionError", message: "call failed", details: message, cause: reverted });
  return layer({ name: "ContractFunctionExecutionError", message: "contract call failed", details: message, cause: call });
}

/** The same wrapper around a layer that is NOT a revert (`HttpRequestError`, `TimeoutError`, `InternalRpcError`, ...). */
export function outageError(name: string, extra: Partial<Layer> = {}): Error {
  const inner = layer({ name, message: name, ...extra });
  const call = layer({ name: "CallExecutionError", message: "call failed", cause: inner });
  return layer({ name: "ContractFunctionExecutionError", message: "contract call failed", cause: call });
}

/** What the SDK throws for a missing token: a plain Error built from a multicall sub-call that reverted. */
export function missingTokenError(collection = "0x00000000000000000000000000000000000000a1", tokenId = 1): Error {
  return new Error(`project ${collection}/${tokenId} does not exist (ownerOf reverted): ContractFunctionRevertedError: The contract function "ownerOf" reverted.`);
}

/**
 * A complete v3 address book for tests that talk to a FAKE JSON-RPC server (the canonical registry has no
 * addresses until ABX FS is deployed). The addresses are arbitrary and only need to be distinct.
 */
export const TEST_ADDRESSES = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000d1",
  directoryStore: "0x00000000000000000000000000000000000000d2",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
  orgFactory: "0x00000000000000000000000000000000000000f1",
  orgMinter: "0x00000000000000000000000000000000000000f2",
  lens: "0x00000000000000000000000000000000000000f3",
  projectHook: "0x00000000000000000000000000000000000000f4",
  projectEnumeration: "0x00000000000000000000000000000000000000f5",
} as const satisfies import("@artblocks/abxfs-sdk").ContractAddresses;
