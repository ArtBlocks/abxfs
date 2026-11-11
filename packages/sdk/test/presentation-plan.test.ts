import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient, Address } from "viem";
import { CODEC_GZIP } from "../src/compression.js";
import { ZERO_HASH } from "../src/cid.js";
import { asAbxfsCid, type ContractAddresses } from "../src/types.js";
import { planPresentation, applyPresentationPlan, PresentationApplyError, selectPresentationEntrypoint, validatePresentationPath } from "../src/presentation-plan.js";
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
  const missing=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,emptyDirectories:[],path:"missing.webp",method:PresentationMethod.Embedded});
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

describe("presentation target path grammar",()=>{
 const maxPath=[...Array<string>(7).fill("a".repeat(255)),"b".repeat(254),"c"].join("/");
 it("accepts empty root and exact UTF-8 segment/depth/total-byte boundaries",()=>{
  expect(new TextEncoder().encode(maxPath)).toHaveLength(2048);
  for(const path of ["","a".repeat(255),"é".repeat(127)+"a",Array<string>(32).fill("a").join("/"),maxPath])
   expect(()=>validatePresentationPath(path)).not.toThrow();
 });
 it.each(["../index.html","./index.html","/index.html","a/","a//b","a\\b","a\x1fb","a\x7fb","é".repeat(128),Array<string>(33).fill("a").join("/"),maxPath+"d"])("blocks explicit invalid target %j for every delivery method",async path=>{
  for(const method of [PresentationMethod.ChainGateway,PresentationMethod.Embedded,PresentationMethod.Ipfs]){
   const plan=await planPresentation(client,addresses,{root,files:[file("index.html",20,"text/html")],rootIsDirectory:true,path,method});
   expect(plan.readiness).toBe("blocked");expect(plan.diagnostics[0]?.code).toBe("invalid_path");
   expect(plan.configureTarget).toBe(true);expect(plan.method).toBe(method);
  }
 });
 it("keeps a valid deep-directory upload on its root and recommends ChainGateway instead of setting an invalid suggested entrypoint",async()=>{
  const deep=Array<string>(33).fill("folder").join("/")+"/art.html";
  const plan=await planPresentation(client,addresses,{root,files:[file(deep,20,"text/html")],rootIsDirectory:true,firstPublication:true,current:config});
  expect(plan).toMatchObject({path:"",target:{path:""},method:PresentationMethod.ChainGateway,readiness:"warning",configureTarget:true});
  expect(plan.diagnostics[0]?.code).toBe("entrypoint_path_policy");
 });
});

describe("method-specific URL preflight",()=>{
 it("blocks known native IPFS codec incompatibility without replacing the explicit method",async()=>{
  const plan=await planPresentation(client,addresses,{root,files:[file("art.html",20,"text/html")],rootIsDirectory:false,path:"",codec:CODEC_GZIP,method:PresentationMethod.Ipfs});
  expect(plan).toMatchObject({method:PresentationMethod.Ipfs,readiness:"blocked"});
  expect(plan.diagnostics.some(d=>d.code === "ipfs_codec" && d.technical)).toBe(true);
 });
 it("checks known changed codec files anywhere in the proposed IPFS directory root, even when the displayed path has no index",async()=>{
  const plan=await planPresentation(client,addresses,{root,files:[file("elsewhere/changed.html",20,"text/html")],entries:[{path:"art.html",cid:root},{path:"elsewhere/changed.html",cid:root}],rootIsDirectory:true,path:"",codec:CODEC_GZIP,method:PresentationMethod.Ipfs});
  expect(plan.readiness).toBe("blocked");expect(plan.diagnostics.some(d=>d.code === "ipfs_codec")).toBe(true);
 });
 it("blocks a changed gzip sibling even when the selected file itself is known raw, without scanning other siblings",async()=>{
  const metadata=vi.fn(async ({functionName}:{functionName:string})=>{
   if(functionName === "presentationVersion") return 2n;
   if(functionName === "directoryExists") return false;
   if(functionName === "fileExists") return true;
   if(functionName === "getFileInfo") return {root,rootLevel:0,size:200_000n,chunkCount:10n,mimeType:"text/html",codec:ZERO_HASH,outputHash:ZERO_HASH};
   throw new Error(`unexpected ${functionName}`);
  });
  const plan=await planPresentation({readContract:metadata} as unknown as PublicClient,addresses,{root,files:[file("other.html",20,"text/html")],entries:[{path:"index.html",cid:root},{path:"other.html",cid:root}],rootIsDirectory:true,path:"index.html",codec:CODEC_GZIP,method:PresentationMethod.Ipfs});
  expect(plan.readiness).toBe("blocked");expect(plan.diagnostics.some(d=>d.code === "ipfs_codec")).toBe(true);
  expect(plan.diagnostics.some(d=>d.code === "unsupported_codec")).toBe(false);
  expect(metadata.mock.calls.filter(([request])=>request.functionName === "getFileInfo")).toHaveLength(1);
  const historical=await planPresentation({readContract:metadata} as unknown as PublicClient,addresses,{root,files:[file()],rootIsDirectory:false,codec:CODEC_GZIP,method:PresentationMethod.Ipfs,current:{...config,selection:PresentationSelection.Version,version:1,root:asAbxfsCid(`0x${"cd".repeat(32)}`)}});
  expect(historical.readiness).not.toBe("blocked");expect(historical.diagnostics.some(d=>d.code === "ipfs_codec")).toBe(false);
 });
 it.each([PresentationMethod.ChainGateway,PresentationMethod.Ipfs])("blocks proven absent configured targets for URL method %s, but accepts a directory without index",async method=>{
  const missing=await planPresentation(client,addresses,{root,files:[file("art.html",20,"text/html")],rootIsDirectory:true,emptyDirectories:[],path:"missing.html",method});
  expect(missing.readiness).toBe("blocked");expect(missing.diagnostics[0]?.code).toBe("missing_target");
  const directory=await planPresentation(client,addresses,{root,files:[file("art.html",20,"text/html")],rootIsDirectory:true,path:"",method});
  expect(directory.readiness).toBe("warning");expect(directory.diagnostics[0]?.code).toBe("missing_index");
  const filePath=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:false,path:"child",method});
  expect(filePath.readiness).toBe("blocked");expect(filePath.diagnostics[0]?.code).toBe("invalid_file_path");
 });
 it("allows explicit IPFS MIME and size policy overrides and codec-bearing ChainGateway",async()=>{
  const ipfs=await planPresentation(client,addresses,{root,files:[file("data.bin",DEFAULT_AUTO_MAX_BYTES+1,"application/octet-stream")],rootIsDirectory:false,method:PresentationMethod.Ipfs});
  expect(ipfs).toMatchObject({method:PresentationMethod.Ipfs,readiness:"warning"});
  expect(ipfs.diagnostics.map(d=>d.code)).toEqual(expect.arrayContaining(["unsupported_mime","auto_policy"]));
  const gateway=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:false,codec:CODEC_GZIP,method:PresentationMethod.ChainGateway});
  expect(gateway.readiness).toBe("warning");
 });
 it("preserves ordinary update choices with warnings instead of rewriting or refusing them",async()=>{
  const plan=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:false,codec:CODEC_GZIP,current:{...config,configuredFlags:3,method:PresentationMethod.Ipfs}});
  expect(plan).toMatchObject({method:PresentationMethod.Ipfs,requested:"preserve",readiness:"warning",configureTarget:false,configureMethod:false});
  const missing=await planPresentation(client,addresses,{root,files:[file()],rootIsDirectory:true,emptyDirectories:[],current:{...config,configuredFlags:3,path:"removed.html"}});
  expect(missing.readiness).toBe("warning");expect(missing.configureTarget).toBe(false);
 });
});

describe("complete empty-directory target evidence",()=>{
 it.each([PresentationMethod.ChainGateway,PresentationMethod.Ipfs])("accepts known empty directory and its ancestor for URL method %s while blocking a genuinely absent target",async method=>{
  for(const path of ["empty","parent","parent/empty"]){
   const plan=await planPresentation(client,addresses,{root,files:[file("art.html",20,"text/html")],emptyDirectories:["empty","parent/empty"],rootIsDirectory:true,path,method});
   expect(plan).toMatchObject({method,readiness:"warning",path});
   expect(plan.diagnostics[0]?.code).toBe("missing_index");
  }
  const missing=await planPresentation(client,addresses,{root,files:[file("art.html",20,"text/html")],emptyDirectories:["empty","parent/empty"],rootIsDirectory:true,path:"absent",method});
  expect(missing.readiness).toBe("blocked");expect(missing.diagnostics[0]?.code).toBe("missing_target");
 });
});

it.each([PresentationMethod.ChainGateway,PresentationMethod.Ipfs])("does not mistake omitted empty-directory evidence for proven absence with URL method %s",async method=>{
 const request={root,files:[file("art.html",20,"text/html")],rootIsDirectory:true,path:"maybe-empty",method};
 const unknown=await planPresentation(client,addresses,request);
 expect(unknown.readiness).toBe("unresolved");expect(unknown.diagnostics[0]?.code).toBe("target_unproven");
 const absent=await planPresentation(client,addresses,{...request,emptyDirectories:[]});
 expect(absent.readiness).toBe("blocked");expect(absent.diagnostics[0]?.code).toBe("missing_target");
 const embedded=await planPresentation(client,addresses,{...request,method:PresentationMethod.Embedded});
 expect(embedded.readiness).toBe("blocked");
});
