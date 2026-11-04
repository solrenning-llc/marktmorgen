import assert from "node:assert/strict";
import { test } from "node:test";
import * as route from "@/app/api/store/download/route";
import { fixture, expireGrant } from "./single-digital-access-renewal-world";
import type { ShipmentMailRuntime } from "@/lib/shipment-mail-outbox";
import type { NextRequest } from "next/server";

test("the expired original URL offers a funded one-button inbox renewal without exposing its address", async () => {
  const f = await fixture(); await expireGrant(f.token);
  const runtime: ShipmentMailRuntime = { ...f.runtime, policy: { ...f.runtime.policy!,
    coveredOrigins: ["single-digital-confirmation", "single-digital-access-renewal"] as never,
    singleDigitalAccessEvidence: "SYNTHETIC_ONLY", singleDigitalRenewalEvidence: "SYNTHETIC_ONLY" } as never };
  const handler = (route as unknown as { paidDownloadGet?: (r:NextRequest,s:ShipmentMailRuntime)=>Promise<Response> }).paidDownloadGet ?? route.GET;
  const response = await handler({ nextUrl:f.url, headers:new Headers() } as NextRequest,runtime);
  assert.equal(response.status,200); const html=await response.text();
  assert.ok(html.includes('<form')); assert.ok(html.includes('method="post"')); assert.equal(html.includes(f.email),false);
});

import { paidDownloadGet, paidDownloadRenewalPost } from "@/app/api/store/download/route";
import { renewalFixture, request, formFields, tokenKeys } from "./single-digital-access-renewal-world";
import { runOrderConfirmationMail, readSingleDigitalRenewalOrigin, forgetOrderConfirmationMail, confirmationOriginRowKey } from "@/lib/order-confirmation-outbox";
import { store as redis } from "./redis-stub";
import { queuedShipmentMailSender } from "@/lib/email";

async function queued() {
  const f=await renewalFixture();
  const form=await paidDownloadGet({nextUrl:f.url,headers:new Headers()} as NextRequest,f.runtime);
  const fields=formFields(await form.text());
  const response=await paidDownloadRenewalPost(request(f.url,fields),f.runtime);assert.equal(response.status,200);
  const key=[...redis.keys()].find(k=>k.startsWith("nl:order-confirmation:row:"))!;assert.ok(key);
  return {...f,id:key.slice("nl:order-confirmation:row:".length),fields};
}

test("client old URL -> buttonPOST -> durable outage25h -> fresh inbox token -> actual file",async()=>{
  const f=await queued();assert.equal(tokenKeys().length,0,"POST does not issue a grant");
  const initial=await readSingleDigitalRenewalOrigin(f.id,f.runtime);assert.ok(initial);
  assert.equal(initial.row.purpose,"single-digital-access-renewal");
  assert.equal(Object.hasOwn(initial.payload,"preintentToken"),false);assert.equal(Object.hasOwn(initial.payload,"settlementToken"),false);
  // The existing sender has no eligible live provider in this synthetic run;
  // guarded fallback is closed and never invokes its beforePost callback.
  await runOrderConfirmationMail(f.runtime.now!()+30_000,queuedShipmentMailSender(),f.runtime);
  assert.equal(tokenKeys().length,0,"waiting transport cannot start token24h");
  f.advance(25*3_600_000);let text="",posts=0;
  await runOrderConfirmationMail(f.runtime.now!()+30_000,async(message,beforePost)=>{
    assert.equal(tokenKeys().length,0);assert.equal(await beforePost(),true);posts++;text=message.text;return "accepted";
  },{...f.runtime});
  assert.equal(posts,1);assert.equal(await readSingleDigitalRenewalOrigin(f.id,f.runtime),null);
  const url=new URL(text.split("\n").find(line=>line.startsWith("https://"))!);
  const download=await paidDownloadGet({nextUrl:url,headers:new Headers()} as NextRequest,f.runtime);
  assert.equal(download.status,200);assert.equal(await download.text(),"SYNTHETIC_PAID_FILE");
  const key=tokenKeys()[0];assert.ok(Number(redis.run(["TTL",key]))>=86390,"token lifetime starts at dispatch");
  assert.equal(f.calls.filter(c=>c.method==="POST").length,0,"renewal never creates payment");
  assert.equal(f.commands.some(c=>String(c[1]).includes("order-confirmation-settlement")),false);
});

test("renewal unknown ACK never rePOSTs or expires; erasure removes its retained payload",async()=>{
  const f=await queued();let posts=0;
  const send=async(_message:unknown,beforePost:()=>Promise<boolean>)=>{assert.equal(await beforePost(),true);posts++;return "unknown" as const;};
  await runOrderConfirmationMail(f.runtime.now!()+30_000,send,f.runtime);
  f.advance(73*3_600_000);await runOrderConfirmationMail(f.runtime.now!()+30_000,send,{...f.runtime});
  assert.equal(posts,1);assert.equal((await readSingleDigitalRenewalOrigin(f.id,f.runtime))?.row.state,"dispatching");
  assert.equal(redis.run(["TTL",confirmationOriginRowKey(f.id)]),-1);
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId,undefined,f.runtime),1);
});

test("renewal request rejects CSRF, unknown funding and corrupted capsule before any mail/grant",async()=>{
  const f=await renewalFixture(),fields=new URLSearchParams({handle:f.store.handle,origin:f.url.searchParams.get("origin")!,request:"a".repeat(64)});
  assert.equal((await paidDownloadRenewalPost(request(f.url,fields,"https://elsewhere.test"),f.runtime)).status,403);
  assert.equal((await paidDownloadRenewalPost(request(f.url,fields),{...f.runtime,policy:null})).status,503);
  fields.set("origin",fields.get("origin")+"corrupt");
  assert.equal((await paidDownloadRenewalPost(request(f.url,fields),f.runtime)).status,404);
  assert.equal(tokenKeys().length,0);assert.equal([...redis.keys()].some(k=>k.startsWith("nl:order-confirmation:row:")),false);
});

import { createCheckout } from "@/lib/store-checkout";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";

test("complete client journey renews an actually accepted purchase email without manually joining grants",async()=>{
  const f=await renewalFixture();
  const checkout=await createCheckout(f.store,f.product,"https://example.test",undefined,{digitalConsent:{version:EU_WITHDRAWAL_CONSENT_VERSION,at:Math.floor(f.created/1000)}},f.runtime);
  const session=f.sessions.get(checkout.id)!;
  Object.assign(session,{...f.session,id:session.id,created:session.created,metadata:session.metadata});
  f.advance(61_000);let receipt="";
  await runOrderConfirmationMail(f.runtime.now!()+30_000,async(message,beforePost)=>{assert.equal(await beforePost(),true);receipt=message.text;return "accepted";},f.runtime);
  const oldUrl=new URL(receipt.split("\n").find(line=>line.startsWith("Open what you bought: "))!.slice("Open what you bought: ".length));
  await expireGrant(oldUrl.searchParams.get("token")!);
  const form=await paidDownloadGet({nextUrl:oldUrl,headers:new Headers()} as NextRequest,f.runtime);
  const fields=formFields(await form.text());
  assert.equal((await paidDownloadRenewalPost(request(oldUrl,fields),f.runtime)).status,200);
  const counted=f.commands.filter(c=>String(c[1]).includes("order-confirmation-settlement")).length;
  await runOrderConfirmationMail(f.runtime.now!()+30_000,queuedShipmentMailSender(),f.runtime);
  assert.equal(tokenKeys().length,0);
  f.advance(26*3_600_000);let renewed="";
  await runOrderConfirmationMail(f.runtime.now!()+30_000,async(message,beforePost)=>{assert.equal(await beforePost(),true);renewed=message.text;return "accepted";},{...f.runtime});
  const inboxUrl=new URL(renewed.split("\n").find(line=>line.startsWith("https://"))!);
  const downloaded=await paidDownloadGet({nextUrl:inboxUrl,headers:new Headers()} as NextRequest,f.runtime);
  assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),"SYNTHETIC_PAID_FILE");
  assert.equal(f.commands.filter(c=>String(c[1]).includes("order-confirmation-settlement")).length,counted);
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1,"only the original payment creation");
});

test("refund after enqueue keeps renewal pending; repeat requests deduplicate and address limit caps work",async()=>{
  const f=await queued();
  const initialCount=[...redis.keys()].filter(k=>k.startsWith("nl:order-confirmation:row:")).length;
  assert.equal((await paidDownloadRenewalPost(request(f.url,f.fields),f.runtime)).status,200);
  assert.equal([...redis.keys()].filter(k=>k.startsWith("nl:order-confirmation:row:")).length,initialCount);
  f.session.payment_intent.latest_charge.refunded=true;let posts=0;
  await runOrderConfirmationMail(f.runtime.now!()+30_000,async()=>{posts++;return "accepted";},f.runtime);
  assert.equal(posts,0);assert.ok(await readSingleDigitalRenewalOrigin(f.id,f.runtime));assert.equal(tokenKeys().length,0);
  f.session.payment_intent.latest_charge.refunded=false;
  let limited=false;
  for(let i=0;i<6;i++){const fields=new URLSearchParams(f.fields);fields.set("request",String(i+1).padStart(64,"0"));if((await paidDownloadRenewalPost(request(f.url,fields),f.runtime)).status===429)limited=true;}
  assert.equal(limited,true);
});

import { confirmationLocalPipeline } from "./order-confirmation-paid-fixture";

test("exact Lua and live grant family execute the renewal flow on owned disposable Redis",{skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=="1"},async()=>{
  const f=await renewalFixture(),base=redis.pipeline.bind(redis);
  f.runtime.pipeline=confirmationLocalPipeline;
  redis.pipeline=async commands=>{
    const replies:unknown[]=[];
    for(const c of commands)replies.push(...await(String(c[1]??"").startsWith("nl:orders:link:")?confirmationLocalPipeline([c]):base([c])));
    return replies;
  };
  try{
    const form=await paidDownloadGet({nextUrl:f.url,headers:new Headers()} as NextRequest,f.runtime);
    const response=await paidDownloadRenewalPost(request(f.url,formFields(await form.text())),f.runtime);assert.equal(response.status,200);
    const [members]=await confirmationLocalPipeline([["SMEMBERS",`nl:order-confirmation:store:${f.store.statsId}`]]);
    const id=(members as string[])[0];assert.ok(id);
    assert.equal((await readSingleDigitalRenewalOrigin(id,f.runtime))?.row.purpose,"single-digital-access-renewal");
    await runOrderConfirmationMail(f.runtime.now!()+30_000,queuedShipmentMailSender(),f.runtime);
    assert.deepEqual((await confirmationLocalPipeline([["KEYS","nl:orders:link:*"]]))[0],[]);
    const waiting=await readSingleDigitalRenewalOrigin(id,f.runtime);assert.ok(waiting);
    const memoryKeys=[confirmationOriginRowKey(id),`nl:order-confirmation:source:${id}`,"nl:order-confirmation:due",`nl:order-confirmation:store:${f.store.statsId}`,`nl:order-confirmation:person:${f.store.statsId}:${waiting.row.person}`,"nl:ship:mail:pool",`nl:ship:mail:pool:${f.store.statsId}`,"nl:ship:mail:all"];
    const memory=await confirmationLocalPipeline(memoryKeys.map(k=>["MEMORY","USAGE",k,"SAMPLES",0]));
    assert.ok(memory.reduce<number>((n,v)=>n+Number(v??0),0)<waiting.row.bytes);
    f.advance(25*3_600_000);let message="";
    await runOrderConfirmationMail(f.runtime.now!()+30_000,async(mail,beforePost)=>{assert.equal(await beforePost(),true);message=mail.text;return "accepted";},f.runtime);
    assert.equal(await readSingleDigitalRenewalOrigin(id,f.runtime),null);
    const url=new URL(message.split("\n").find(l=>l.startsWith("https://"))!);
    const file=await paidDownloadGet({nextUrl:url,headers:new Headers()} as NextRequest,f.runtime);assert.equal(await file.text(),"SYNTHETIC_PAID_FILE");
    const [tokens]=await confirmationLocalPipeline([["KEYS","nl:orders:link:*"]]);assert.equal((tokens as string[]).length,1);
    const [ttl,tokenBytes]=await confirmationLocalPipeline([["TTL",(tokens as string[])[0]],["MEMORY","USAGE",(tokens as string[])[0],"SAMPLES",0]]);assert.ok(Number(ttl)>=86390);
    console.log(JSON.stringify({proof:"renewal-owned-Redis",waitingRowJsonBytes:Buffer.byteLength(waiting.raw),waitingTotalRedisBytes:memory.reduce<number>((n,v)=>n+Number(v??0),0),reservedBytes:waiting.row.bytes,issuedTokenRedisBytes:tokenBytes,issuedTokenTtl:ttl,providerPaymentPosts:0}));
    assert.equal(f.calls.filter(c=>c.method==="POST").length,0);
  }finally{redis.pipeline=base;}
});


test("a renewal copied under another source identity is unknown and leaves the authentic origin intact", async () => {
  const f = await queued(), different = "d".repeat(64);
  assert.notEqual(f.id, different);
  const raw = String(redis.run(["GET", confirmationOriginRowKey(f.id)]));
  const source = String(redis.run(["GET", `nl:order-confirmation:source:${f.id}`]));
  redis.run(["SET", confirmationOriginRowKey(different), raw]);
  redis.run(["SET", `nl:order-confirmation:source:${different}`, source]);
  assert.equal(await readSingleDigitalRenewalOrigin(different, f.runtime), null);
  assert.equal((await readSingleDigitalRenewalOrigin(f.id, f.runtime))?.row.id, f.id);
  assert.equal(redis.run(["GET", confirmationOriginRowKey(f.id)]), raw);
  assert.equal(tokenKeys().length, 0);
});


import { orderConfirmationMailOf } from "@/lib/order-confirmation-outbox";
import { singleDigitalRenewalCopy } from "@/lib/single-digital-access";
test("personal copy includes the existing renewal request without exposing a capsule or creating a token",async()=>{
 const f=await queued(),before=f.calls.length;
 const commands:(string|number)[][]=[];
 const rows=await orderConfirmationMailOf(f.store.statsId!,f.email,{...f.runtime,lifecycle:"retired",pipeline:async batch=>{commands.push(...batch);return f.runtime.pipeline!(batch);}});
 assert.equal(rows.length,1);assert.equal(tokenKeys().length,0);assert.equal(f.calls.length,before);
 const saved=await readSingleDigitalRenewalOrigin(f.id,f.runtime);assert.ok(saved);
 const expected={checkout:f.capsule.sessionId,product:f.capsule.productId,unitCents:f.capsule.unitCents,paidCents:f.capsule.paidCents,currency:f.capsule.currency,paidAt:f.capsule.created};
 assert.deepEqual(rows[0],{...expected,purpose:"single-digital-access-renewal",phase:"renewal_queued",state:"queued",created:saved.row.created});
 assert.deepEqual(singleDigitalRenewalCopy(saved.payload.capsule,f.store.statsId!,saved.row.accountId,f.email),expected);
 for(const [sealed,stats,account,email] of [[saved.payload.capsule+"corrupt",f.store.statsId!,saved.row.accountId,f.email],[saved.payload.capsule,"other_store",saved.row.accountId,f.email],[saved.payload.capsule,f.store.statsId!,"acct_Other",f.email],[saved.payload.capsule,f.store.statsId!,saved.row.accountId,"other@example.test"]])
  assert.equal(singleDigitalRenewalCopy(sealed,stats,account,email),null);
 assert.ok(commands.every(c=>["TYPE","SCARD","SMEMBERS","GETRANGE","GET"].includes(String(c[0]))));
 const text=JSON.stringify(rows);assert.ok(text.includes("single-digital-access-renewal"));
 assert.equal(/capsule|sealed|token|storeRef|fingerprint/i.test(text),false);
 assert.deepEqual(await orderConfirmationMailOf(f.store.statsId!,"other@example.test",f.runtime),[]);
 await runOrderConfirmationMail(f.runtime.now!()+30000,async(_m,barrier)=>{assert.equal(await barrier(),true);return "unknown";},f.runtime);
 assert.equal((await readSingleDigitalRenewalOrigin(f.id,f.runtime))?.row.state,"dispatching");
 const grants=tokenKeys().length,gets=f.gets.length;
 const after=await orderConfirmationMailOf(f.store.statsId!,f.email,{...f.runtime,lifecycle:"retired"});
 assert.equal((after[0] as {state:string}).state,"dispatching");
 for(const [key,value] of Object.entries(expected))assert.equal((after[0] as Record<string,unknown>)[key],value);
 assert.equal(tokenKeys().length,grants);assert.equal(f.gets.length,gets);
});
