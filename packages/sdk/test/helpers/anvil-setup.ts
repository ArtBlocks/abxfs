import type { TestProject } from "vitest/node";

import { deployOnce, hasFoundry } from "./anvil.js";

/**
 * Vitest global setup for every package whose tests use `startAnvilWithAbxfs`: the deploy scripts run once per run, and
 * each test file's anvil loads the result. Without Foundry it deploys nothing, and a harness says so when asked.
 */
export default async function setup(project: TestProject): Promise<void> {
  if (!hasFoundry()) return;
  project.provide("abxfsDeployments", await deployOnce());
}
