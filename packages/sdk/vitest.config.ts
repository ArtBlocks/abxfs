import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The deploy scripts run once per run here; each chain test file starts its own anvil on a free port and loads that
    // deployment (test/helpers/anvil.ts), so test files run in parallel.
    globalSetup: ["test/helpers/anvil-setup.ts"],
  },
});
