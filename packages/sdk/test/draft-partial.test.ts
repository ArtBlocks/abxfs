import { describe, expect, it, vi } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
const h=vi.hoisted(()=>({nameFails:false,sent:[] as string[]}));
vi.mock("../src/project.js",async original=>({...await original<typeof import("../src/project.js")>(),assertCanPublish:async()=>{},setProjectName:async()=>{h.sent.push("name");if(h.nameFails)throw new Error("name submission rejected");return "0xname"}}));
vi.mock("../src/stores.js",async original=>({...await original<typeof import("../src/stores.js")>(),assertHookAcceptsContent:async()=>{}}));
vi.mock("../src/content-write.js",async original=>({...await original<typeof import("../src/content-write.js")>(),runContentStages:async()=>{}}));
vi.mock("../src/publish.js",async original=>({...await original<typeof import("../src/publish.js")>(),publishRootAndTag:async()=>{h.sent.push("publish");return {publishTxHash:"0xpublish",versionNumber:1n}}}));
import { executeNewProjectPublish, type AppliedDraft, type TxPlan } from "../src/draft.js";
import { PublishedPartialError } from "../src/publish.js";
import { LEGACY_GAS_SCHEDULE } from "../src/gas-schedule.js";
import { asAbxfsCid, type ContractAddresses } from "../src/types.js";
const a=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address;
const addresses:ContractAddresses={chunkStore:a(1),fileStore:a(2),directoryStore:a(3),sstore2Backend:a(4),fastLzBackend:a(5)};
const root=asAbxfsCid(`0x${"ab".repeat(32)}`);
const applied:AppliedDraft={newRootCid:root,files:[],backends:{raw:a(4),fastLz:a(5)}};
const plan={chunksToWrite:[],chunkNodesToCreate:[],entryNodesToCreate:[],filesToCreate:[],dirsToCreate:[],bundles:[],publishVersion:{estGas:1n}} as unknown as TxPlan;
describe("first publication name followup",()=>{
 it.each(["submission","receipt"])("retains confirmed publication after name %s failure without repeating content or publish",async failure=>{
  h.sent=[];h.nameFails=failure === "submission";
  const receipt=vi.fn(async()=>({status:"reverted"}));
  const error=await executeNewProjectPublish({publicClient:{waitForTransactionReceipt:receipt} as unknown as PublicClient,walletClient:{account:{address:a(9)}} as unknown as WalletClient},addresses,{collection:a(7),hook:a(8)},0n,"Artwork",applied,{plan,gasSchedule:LEGACY_GAS_SCHEDULE}).catch(e=>e);
  expect(error).toBeInstanceOf(PublishedPartialError);
  expect(error).toMatchObject({published:true,retryPublish:false,phase:"setting-name",root,org:a(7),tokenId:0n,publishTxHash:"0xpublish",versionNumber:1n});
  expect(error.nameTxHash).toBe(failure === "receipt" ? "0xname" : undefined);
  expect(h.sent).toEqual(["publish","name"]);
 });
});
