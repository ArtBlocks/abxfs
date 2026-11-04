import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // The SDK's anvil harness loads the deployment this makes once per run.
    globalSetup: ["../sdk/test/helpers/anvil-setup.ts"],
  },
});
