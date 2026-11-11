import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
const state=vi.hoisted(()=>({factory:"0x4a5D0fCed9b2162Db4517E7248dC0f3243CCB475"}));
vi.mock("../src/canonical.js",()=>({CANONICAL_DEPLOYMENTS:{1:{get addresses(){return {orgFactory:state.factory,projectPresentation:"0x0000000000000000000000000000000000000006"}}}}}));
import { isRetiredFactory, RETIRED_PRESENTATION_FACTORY, RetiredOrgGenerationError } from "../src/retired.js";
import { addressesForOrg, orgGenerations } from "../src/org.js";
import type { ContractAddresses } from "../src/types.js";
const a=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address;
const addresses:ContractAddresses={chunkStore:a(1),fileStore:a(2),directoryStore:a(3),sstore2Backend:a(4),fastLzBackend:a(5),orgFactory:a(10),projectHook:a(11),projectPresentation:a(12),previousGenerations:[{orgFactory:a(20),projectHook:a(21)},{orgFactory:RETIRED_PRESENTATION_FACTORY,projectHook:a(31)}]};
afterEach(()=>{state.factory=RETIRED_PRESENTATION_FACTORY});
describe("explicit presentation generation retirement",()=>{
 it("keeps candidate overrides and intermediate current factory usable before canonical promotion",()=>{
  expect(isRetiredFactory(RETIRED_PRESENTATION_FACTORY)).toBe(false);
  expect(orgGenerations(addresses).map(g=>g.orgFactory)).toEqual([a(10),a(20),RETIRED_PRESENTATION_FACTORY]);
 });
 it("retains original history and excludes the intermediate factory after replacement promotion",async()=>{
  state.factory=a(10);
  expect(orgGenerations(addresses).map(g=>g.orgFactory)).toEqual([a(10),a(20)]);
  const readContract=vi.fn(async ({address}:{address:Address})=>address===RETIRED_PRESENTATION_FACTORY);
  await expect(addressesForOrg({readContract} as unknown as PublicClient,addresses,a(99))).rejects.toBeInstanceOf(RetiredOrgGenerationError);
  expect(readContract.mock.calls.map(([r])=>r.address)).toEqual([a(10),a(20),RETIRED_PRESENTATION_FACTORY]);
 });
 it("does not invent historical generations for a fresh chain",()=>{
  state.factory=a(10);
  expect(orgGenerations({...addresses,previousGenerations:[]})).toHaveLength(1);
 });
});
