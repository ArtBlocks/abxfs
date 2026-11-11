import { planPresentation, type AbxfsClient, type PresentationPlanRequest, type PresentationPlan } from "@artblocks/abxfs-sdk";
/** The same SDK planner serves fresh minting, pre-minted first publication and later updates. */
export async function publicationPresentation(client: AbxfsClient, tokenId: bigint | undefined, request: PresentationPlanRequest): Promise<PresentationPlan | undefined> {
  if (!client.addresses.projectPresentation) {
    if (request.method !== undefined || request.path !== undefined) throw new Error("this org generation does not support presentation");
    return undefined;
  }
  const [project, current] = tokenId !== undefined
    ? await Promise.all([client.readProject(tokenId), client.inspectPresentation(tokenId)])
    : [undefined, undefined];
  const plan = await planPresentation(client.publicClient, client.addresses, { ...request, current,
    firstPublication: tokenId === undefined || project?.versionCount === 0 });
  if (plan.readiness === "blocked") throw new Error(plan.diagnostics.map(d => d.message).join("; "));
  return plan;
}
