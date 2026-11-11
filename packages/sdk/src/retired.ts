/** Explicit retirement metadata is not a supported generation and is never indexed or watched. */
import type { Address } from "viem";
import { CANONICAL_DEPLOYMENTS } from "./canonical.js";
export const RETIRED_PRESENTATION_FACTORY = "0x4a5D0fCed9b2162Db4517E7248dC0f3243CCB475" as Address;
/** Candidate overrides remain usable until verified canonical replacement promotion. */
export function presentationRetirementActive(): boolean {
  return Object.values(CANONICAL_DEPLOYMENTS).some(({ addresses }) => Boolean(addresses?.projectPresentation && addresses.orgFactory
    && addresses.orgFactory.toLowerCase() !== RETIRED_PRESENTATION_FACTORY.toLowerCase()));
}
export function isRetiredFactory(factory: Address): boolean {
  return presentationRetirementActive() && factory.toLowerCase() === RETIRED_PRESENTATION_FACTORY.toLowerCase();
}
export class RetiredOrgGenerationError extends Error {
  constructor(readonly org?: Address) {
    super(`This org belongs to retired factory ${RETIRED_PRESENTATION_FACTORY}. Its presentation has superseded limits; create a project in the current generation explicitly. Existing NFTs are not upgraded or migrated automatically.`);
    this.name = "RetiredOrgGenerationError";
  }
}
