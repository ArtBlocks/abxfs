import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type Address, type PublicClient } from "viem";
import { pinnedReadPolicy } from "../src/snapshot.js";
import { verifyPresentationTokenUri } from "../src/presentation.js";
const org = "0x00000000000000000000000000000000000000a1" as Address;
function fixture(animation: string) {
  const metadata = `data:application/json;base64,${btoa(JSON.stringify({ animation_url: animation }))}`;
  const call = vi.fn(async () => ({ data: encodeAbiParameters([{ type: "string" }], [metadata]) }));
  return { call, client: { call } as unknown as PublicClient };
}
describe("bounded complete presentation metadata read", () => {
  it("checks the complete tokenURI once with explicit caller gas without fetching its animation", async () => {
    const { call, client } = fixture("data:text/html;base64,PGgxPkFydDwvaDE+");
    expect(await verifyPresentationTokenUri(client, org, 3n)).toMatchObject({ ok: true, status: "ready", callerGas: 50_000_000n });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ to: org, gas: 50_000_000n }));
  });
  it.each(["", "data:text/plain;base64,"])("detects neutral renderer output %s rather than claiming readiness", async animation => {
    expect(await verifyPresentationTokenUri(fixture(animation).client, org, 3n)).toMatchObject({ ok: false, status: "neutral" });
  });
  it("retains a structured read warning without retrying or writing when the RPC budget is insufficient", async () => {
    const call = vi.fn(async () => { throw new Error("execution exceeded caller gas"); });
    const client = { call } as unknown as PublicClient;
    expect(await verifyPresentationTokenUri(client, org, 3n, { gas: 12_000_000n })).toMatchObject({ ok: false, status: "read-failed", callerGas: 12_000_000n });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("bounds response inspection and rejects malformed metadata", async () => {
    expect(await verifyPresentationTokenUri(fixture("ipfs://example").client, org, 3n, { maxMetadataBytes: 10 })).toMatchObject({ status: "read-failed" });
    const call = vi.fn(async () => ({ data: encodeAbiParameters([{ type: "string" }], ["data:application/json,{}"]) }));
    expect(await verifyPresentationTokenUri({ call } as unknown as PublicClient, org, 3n)).toMatchObject({ status: "read-failed" });
  });
});

describe("complete metadata reads after confirmed configuration",()=>{
 it("does not accept stale latest Ready output when the receipt-block output is neutral",async()=>{
  const ready=fixture("https://gateway.example/root");
  const neutral=fixture("data:text/plain;base64,");
  const call=vi.fn(async (request:{blockNumber?:bigint})=>request.blockNumber === 42n ? neutral.call() : ready.call());
  const waitForTransactionReceipt=vi.fn(async()=>({status:"success",blockNumber:42n}));
  const checked=await verifyPresentationTokenUri({call,waitForTransactionReceipt} as unknown as PublicClient,org,3n,{afterTransactionHash:"0x1234"});
  expect(checked).toMatchObject({ok:false,status:"neutral",blockNumber:42n,afterTransactionHash:"0x1234"});
  expect(ready.call).not.toHaveBeenCalled();expect(call).toHaveBeenCalledTimes(1);
 });
 it("verifies normal confirmed-state success and never falls back to latest",async()=>{
  const {call}=fixture("data:image/svg+xml;base64,PHN2Zy8+");
  const waitForTransactionReceipt=vi.fn(async()=>({status:"success",blockNumber:43n}));
  expect(await verifyPresentationTokenUri({call,waitForTransactionReceipt} as unknown as PublicClient,org,3n,{afterTransactionHash:"0x5678"})).toMatchObject({ok:true,blockNumber:43n});
  expect(call).toHaveBeenCalledWith(expect.objectContaining({blockNumber:43n}));
 });
 it("refuses an unconfirmed/reverted prerequisite or conflicting explicit block before reading metadata",async()=>{
  for(const status of ["reverted","success"]){
   const {call}=fixture("https://example.com");
   const waitForTransactionReceipt=vi.fn(async()=>({status,blockNumber:43n}));
   expect(await verifyPresentationTokenUri({call,waitForTransactionReceipt} as unknown as PublicClient,org,3n,{afterTransactionHash:"0x5678",blockNumber:42n})).toMatchObject({ok:false,status:"read-failed"});
   expect(call).not.toHaveBeenCalled();
  }
 });
});

it("uses the existing bounded header-availability policy and never retries genuine render reverts",async()=>{
 const previous={...pinnedReadPolicy};pinnedReadPolicy.attempts=3;pinnedReadPolicy.delayMs=0;
 try {
  const ready=fixture("ipfs://example");let calls=0;
  const call=vi.fn(async()=>{if(++calls<3)throw Object.assign(new Error("header not found"),{code:-32000});return ready.call()});
  expect(await verifyPresentationTokenUri({call} as unknown as PublicClient,org,3n,{blockNumber:44n})).toMatchObject({ok:true,blockNumber:44n});
  expect(call).toHaveBeenCalledTimes(3);
  const revert=vi.fn(async()=>{throw Object.assign(new Error("execution reverted: RenderFailed"),{code:3})});
  expect(await verifyPresentationTokenUri({call:revert} as unknown as PublicClient,org,3n,{blockNumber:44n})).toMatchObject({status:"read-failed"});
  expect(revert).toHaveBeenCalledTimes(1);
  const unavailable=vi.fn(async()=>{throw Object.assign(new Error("header not found"),{code:-32000})});
  expect(await verifyPresentationTokenUri({call:unavailable} as unknown as PublicClient,org,3n,{blockNumber:44n})).toMatchObject({status:"read-failed"});
  expect(unavailable).toHaveBeenCalledTimes(3);
 } finally {Object.assign(pinnedReadPolicy,previous)}
});
