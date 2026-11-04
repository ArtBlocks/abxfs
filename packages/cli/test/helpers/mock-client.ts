/**
 * A stand-in for the `AbxfsClient` a CLI command builds, for tests that mock `../src/client.js`.
 *
 * Every write command now previews its plan and checks the account's balance before its first write
 * (`confirmWrite`), and names the org it acts in (`describeOrg`), so a mock client needs a little more than the
 * calls a test is about: a funded `publicClient.getBalance`, content addresses (the plan is computed offline from
 * them) and `readOrg`. Everything here can be overridden.
 *
 * Use from a `vi.mock` factory, which is hoisted above imports: `const { mockClient } = await import("./helpers/mock-client.js")`.
 */
export const ACCOUNT = "0x00000000000000000000000000000000000a11ce";

/** Five distinct, well-formed content addresses: enough for the offline plan. Never called. */
export const CONTENT_ADDRESSES = {
  chunkStore: "0x0000000000000000000000000000000000000c01",
  fileStore: "0x0000000000000000000000000000000000000c02",
  directoryStore: "0x0000000000000000000000000000000000000c03",
  sstore2Backend: "0x0000000000000000000000000000000000000c04",
  fastLzBackend: "0x0000000000000000000000000000000000000c05",
  projectHook: "0x00000000000000000000000000000000000000b2",
  orgFactory: "0x00000000000000000000000000000000000000f1",
};

export function mockClient<T extends object>(overrides: T, opts: { balance?: bigint; orgName?: string } = {}) {
  const base = {
    addresses: CONTENT_ADDRESSES,
    registry: CONTENT_ADDRESSES,
    walletClient: { account: { address: ACCOUNT } },
    publicClient: {
      getBalance: async () => opts.balance ?? 10n ** 18n,
      // The node's createOrg estimate; a mock without one shows the per-transaction cap instead.
      estimateContractGas: async () => 3_000_000n,
    },
    readOrg: async (org: string) => ({ org, name: opts.orgName ?? "Test Org", admin: ACCOUNT, pendingAdmin: null, open: false, createdBlock: 1n }),
  };
  return { ...base, ...overrides };
}
