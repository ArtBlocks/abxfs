import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient, Address } from "viem";
import { ZERO_HASH } from "../src/cid.js";
import { asAbxfsCid, type ContractAddresses } from "../src/types.js";
import { planPresentation, applyPresentationPlan, PresentationApplyError, selectPresentationEntrypoint } from "../src/presentation-plan.js";
import { PresentationMethod, PresentationSelection, presentationVersion, DEFAULT_AUTO_MAX_BYTES } from "../src/presentation.js";
const a = (n: number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
const addresses: ContractAddresses = { chunkStore:a(1),fileStore:a(2),directoryStore:a(3),sstore2Backend:a(4),fastLzBackend:a(5),projectPresentation:a(6) };
const root = asAbxfsCid(`0x${"ab".repeat(32)}`);
const client = { readContract: vi.fn(async()=>2n), chain:{id:1} } as unknown as PublicClient;
const config = { selection:PresentationSelection.Latest,method:PresentationMethod.ChainGateway,locks:0,configuredFlags:0,version:0,frozenRoot:ZERO_HASH,tag:"",path:"",chainBase:"",ipfsBase:"" };
const file = (path="pfp.webp",size=20,mimeType="image/webp") => ({path,mimeType,bytes:new Uint8Array(size)});

describe("shared presentation planning",()=>{
 it("selects index or sole image in tooling and keeps explicit root literal",async()=>{
  expect(selectPresentationEntrypoint(["a.png","index.html"]).path).toBe("index.html");
  const plan=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,firstPublication:true,current:config});
  expect(plan).toMatchObject({path:"pfp.webp",method:PresentationMethod.Embedded,configureTarget:true,configureMethod:true,readiness:"ready",presentationVersion:2});
  const explicitRoot=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,firstPublication:true,current:config,path:""});
  expect(explicitRoot.path).toBe("");expect(explicitRoot.method).toBe(PresentationMethod.ChainGateway);
 });
 it("preserves a deliberate blank directory path and analyzes its index.html fallback",async()=>{
  const plan=await planPresentation(client,addresses,{root,files:[file("index.html",20,"text/html")],rootIsDirectory:true,firstPublication:true,current:{...config,configuredFlags:1},method:PresentationMethod.Embedded});
  expect(plan).toMatchObject({path:"",method:PresentationMethod.Embedded,configureTarget:false,readiness:"ready"});
  const multi=await planPresentation(client,addresses,{root,files:[file("index.html",20,"text/html"),file()],rootIsDirectory:true,path:"",method:PresentationMethod.Embedded});
  expect(multi).toMatchObject({path:"",readiness:"warning",method:PresentationMethod.Embedded});
  expect(multi.diagnostics[0]?.code).toBe("directory_origin");
  const missing=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,path:"",method:PresentationMethod.Embedded});
  expect(missing.readiness).toBe("blocked");expect(missing.diagnostics[0]?.code).toBe("missing_index");
 });
 it("resolves nested directory indexes and rejects nonexistent local targets before writes",async()=>{
  const nested=await planPresentation(client,addresses,{root,files:[file("art/index.html",20,"text/html")],rootIsDirectory:true,path:"art",method:PresentationMethod.Embedded});
  expect(nested).toMatchObject({path:"art",readiness:"ready"});
  const missing=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,path:"missing.webp",method:PresentationMethod.Embedded});
  expect(missing.readiness).toBe("blocked");expect(missing.diagnostics[0]?.code).toBe("missing_target");
  const filePath=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:false,path:"invalid",method:PresentationMethod.Embedded});
  expect(filePath.readiness).toBe("blocked");expect(filePath.diagnostics[0]?.code).toBe("invalid_file_path");
 });
 it("makes Auto a configurable 100KiB policy while explicit Embedded stays owner controlled",async()=>{
  const request={root,files:[file("large.webp",DEFAULT_AUTO_MAX_BYTES+1)],rootIsDirectory:true,firstPublication:true,current:config};
  expect((await planPresentation(client,addresses,request)).method).toBe(PresentationMethod.ChainGateway);
  const explicit=await planPresentation(client,addresses,{...request,method:PresentationMethod.Embedded});
  expect(explicit.method).toBe(PresentationMethod.Embedded);expect(explicit.readiness).toBe("warning");
  expect(explicit.readReach).toMatchObject({nativeReadable:true,tokenUri:"not-measured"});
  expect((await planPresentation(client,addresses,{...request,autoPolicy:{maxBytes:200*1024}})).method).toBe(PresentationMethod.Embedded);
 });
 it("honors independently configured zero values and endpoint-only preconfiguration",async()=>{
  const request={root,files:[file()],rootIsDirectory:true,firstPublication:true};
  const method=await planPresentation(client,addresses,{...request,current:{...config,configuredFlags:2}});
  expect(method).toMatchObject({requested:"preserve",method:PresentationMethod.ChainGateway,configureMethod:false});
  const target=await planPresentation(client,addresses,{...request,current:{...config,configuredFlags:1}});
  expect(target.path).toBe("");expect(target.configureTarget).toBe(false);expect(target.method).toBe(PresentationMethod.ChainGateway);
  const endpoints=await planPresentation(client,addresses,{...request,current:{...config,configuredFlags:4,chainBase:"https://gateway.example"}});
  expect(endpoints).toMatchObject({method:PresentationMethod.Embedded,configureTarget:true,configureMethod:true});
 });
 it("preserves saved target/method on updates and blocks actual locked changes before publication",async()=>{
  const current={...config,method:PresentationMethod.Embedded,path:"pfp.webp",configuredFlags:3};
  const plan=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,current});
  expect(plan).toMatchObject({requested:"preserve",path:"pfp.webp",method:PresentationMethod.Embedded,configureTarget:false,configureMethod:false});
  const locked=await planPresentation(client,addresses,{root,files:[file()],current:{...current,locks:2},method:PresentationMethod.Ipfs});
  expect(locked.readiness).toBe("blocked");expect(locked.diagnostics.some(d=>d.code==="method_locked")).toBe(true);
 });
 it("distinguishes codec/MIME technical constraints from recommendations; never silently downgrades explicit Embedded",async()=>{
  for(const input of [{codec:`0x${"11".repeat(32)}` as `0x${string}`}, {files:[file("url",10,"text/uri-list")]}]){
   const plan=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:false,firstPublication:true,method:PresentationMethod.Embedded,...input});
   expect(plan.method).toBe(PresentationMethod.Embedded);expect(plan.readiness).toBe("blocked");
   expect(plan.diagnostics.some(d=>d.technical)).toBe(true);expect(plan.readReach.nativeReadable).toBe(false);
  }
 });
 it("does not mistake transport/unknown version errors for legacy capability",async()=>{
  const error=new Error("request timed out");
  await expect(presentationVersion({readContract:async()=>{throw error}} as unknown as PublicClient,addresses)).rejects.toBe(error);
  expect(await presentationVersion({readContract:async()=>{throw Object.assign(new Error("execution reverted"),{code:3})}} as unknown as PublicClient,addresses)).toBe(1);
 });
 it("retains completed settings phases on partial failure and never publishes or mints",async()=>{
  const plan=await planPresentation(client,addresses,{root,files:[file()],firstPublication:true});
  const write=vi.fn().mockResolvedValueOnce(`0x${"11".repeat(32)}`).mockRejectedValueOnce(new Error("method unavailable"));
  const c={publicClient:{chain:{id:1},waitForTransactionReceipt:async()=>({status:"success"})} as unknown as PublicClient,walletClient:{chain:{id:1},account:{address:a(99)},writeContract:write} as unknown as WalletClient};
  const error=await applyPresentationPlan(c,addresses,a(90),3n,plan).catch(e=>e);
  expect(error).toBeInstanceOf(PresentationApplyError);expect(error.phase).toBe("set-method");expect(error.completed).toHaveLength(1);
  expect(write.mock.calls.map(call=>call[0].functionName)).toEqual(["setTarget","setMethod"]);
 });
});
