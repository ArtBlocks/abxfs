import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Chain-touching tests each spawn an Anvil instance; serialize file execution.
    fileParallelism: false,
    // The SDK's anvil harness loads the deployment this makes once per run.
    globalSetup: ["../sdk/test/helpers/anvil-setup.ts"],
  },
});
