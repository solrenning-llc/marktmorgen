import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { test as nodeTest } from "node:test";
import { prepareOrderConfirmationSettlement, prepareOrderConfirmationPreintent, bindOrderConfirmationPreintent, commitOrderConfirmationSettlement } from "@/lib/orders";
import { unseal } from "@/lib/secret-box";
import type { Store } from "@/lib/store";
import { admitOrders } from "@/lib/order-admission";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
process.env.NIMBUS_DATA_KEY="SYNTHETIC-ONLY-order-confirmation-key-2026";
const restarting=process.env.MARKTMORGEN_PREINTENT_RECOVERY==="1";
const test=(name:string,run:()=>void|Promise<void>)=>restarting?undefined:nodeTest(name,run);
const at = Date.UTC(2026, 9, 31, 23, 30);
const hour = Math.floor(at / 3_600_000);
const reference = "checkout:cs_test_confirmationCheckpoint01";
const store = () => ({ email: "checkpoint@example.test", sid: "", statsId: "synthetic_checkpoint", handle: "checkpoint", extra: false, shared: false,stripeAccountId:"acct_TestIntent01",
  subscriptionActive: true, subscriptionId: "sub_SyntheticCheckpoint", trialEnds: 0, tier: "creator", planEndedAt: "", cycle: "month",
  period: { start: Date.UTC(2026,9,20)/1000, end: Date.UTC(2026,10,20)/1000, renews: true } }) as Store;
const clock = { now: () => at };
const identity=()=>({nonce:"a".repeat(64),accountId:"acct_TestIntent01",bodyDigest:"b".repeat(64)});
async function acknowledgedAdmission(s=store(), n=1, items=2, admissionAt=at) {
  const prior=redis.pipeline;redis.pipeline=async()=>[1];
  try{return await admitOrders(s,n,admissionAt,items);}finally{redis.pipeline=prior;}
}
const prepare = async (s=store(), ref=reference) => prepareOrderConfirmationSettlement(s,ref,await acknowledgedAdmission(s),clock);

if(restarting) {
  // A genuinely fresh process has no admission WeakMap entries. Only the
  // protected token read back by the parent crosses this crash boundary.
  const fixture=JSON.parse(process.env.MARKTMORGEN_PREINTENT_FIXTURE??"null");
  void bindOrderConfirmationPreintent(fixture.store,fixture.token,fixture.identity,{now:()=>fixture.now})
    .then(candidate=>process.stdout.write(`RECOVERED:${JSON.stringify(candidate)}\n`))
    .catch(()=>{process.exitCode=1;});
}

test("snapshot captures the original hour, window and explicit share before payment",async()=>{
  const sourceStore=store(),admission=await acknowledgedAdmission(sourceStore);
  // A billing update after admission must not move this order's accounting.
  sourceStore.period={start:Date.UTC(2026,10,20)/1000,end:Date.UTC(2026,11,20)/1000,renews:true};
  const token=await prepareOrderConfirmationSettlement(sourceStore,reference,admission,clock); assert.ok(token);
  const opened=unseal(token,`order-confirmation-settlement|${reference}`); assert.equal(opened.ok,true);
  if(!opened.ok) throw Error("Expected synthetic snapshot");
  const source=JSON.parse(opened.value);
  assert.equal(source.window,"2026-10-20"); assert.equal(source.month,"2026-10");
  assert.equal(source.hour,hour); assert.equal(source.share,0); assert.equal(source.captured,at);
  assert.ok(source.until>at+400*86_400_000);
  const renewed={...store(), shared:true, tier:"scale", period:{start:Date.UTC(2026,10,20)/1000,end:Date.UTC(2026,11,20)/1000,renews:true}} as Store;
  let commands: Command[]=[];
  const result=await commitOrderConfirmationSettlement(renewed,reference,token,1500,{now:()=>at+73*3_600_000,pipeline:async c=>{commands=c;return[1];}});
  assert.equal(result,"committed"); assert.equal(commands.length,1);
  assert.match(String(commands[0][4]),/:2026-10-20$/);
  assert.match(String(commands[0][7]),/:2026-10$/);
  assert.equal(commands[0][10],String(hour)); assert.equal(commands[0][12],1);
});

test("missing original share/window/admission evidence does not manufacture a snapshot",async()=>{
  const missingShare={...store()} as Partial<Store>; delete missingShare.shared;
  assert.equal(await prepare(missingShare as Store),null);
  assert.equal(await prepare({...store(),period:null}),null);
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference,{ok:true,hour:hour-1},clock),null);
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference,{ok:true,hour:null},clock),null);
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference,{ok:false,reason:"unavailable"},clock),null);
  let getters=0;
  const accessor=Object.defineProperty({...store()},"shared",{get(){getters++;return false;}});
  assert.equal(await prepare(accessor),null); assert.equal(getters,0);
  const admission=Object.defineProperty({ok:true},"hour",{get(){getters++;return hour;}});
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference,admission as never,clock),null); assert.equal(getters,0);
  const real=await acknowledgedAdmission();
  assert.ok(await prepareOrderConfirmationSettlement(store(),reference,real,clock));
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference+"other",real,clock),null);
  assert.equal(await prepareOrderConfirmationSettlement(store(),reference,await acknowledgedAdmission(store(),2),clock),null);
  const previous=redis.pipeline;redis.pipeline=async()=>["1"];
  try {
    const uncertain=await admitOrders(store(),1,at,2);
    assert.deepEqual(uncertain,{ok:false,reason:"unavailable"});
    assert.equal(await prepareOrderConfirmationSettlement(store(),reference,uncertain,clock),null);
  } finally {redis.pipeline=previous;}
  let coercions=0;
  for(const key of ["tier","cycle"] as const) {
    const s=store(),admitted=await acknowledgedAdmission(s);
    Object.defineProperty(s,key,{value:{toString(){coercions++;return key==="tier"?"creator":"month";}}});
    assert.equal(await prepareOrderConfirmationSettlement(s,reference,admitted,clock),null);
  }
  assert.equal(coercions,0);
  // A malformed tier at admission cannot become a proof through coercion.
  const malformed={...store(),tier:{toString(){coercions++;return "creator";}}} as unknown as Store;
  const actual=await acknowledgedAdmission(malformed);
  assert.equal(actual.ok,true); // Preserve the legacy admission's behavior.
  const legacyCoercions=coercions;
  malformed.tier="creator";
  assert.equal(await prepareOrderConfirmationSettlement(malformed,reference,actual,clock),null);
  assert.equal(coercions,legacyCoercions);
});

test("unknown ACK never claims settlement, and replay uses an identical receipt",async()=>{
  const token=await prepare(); assert.ok(token); let first:Command|undefined;
  assert.equal(await commitOrderConfirmationSettlement(store(),reference,token,1500,{...clock,pipeline:async c=>{first=c[0];throw Error("Lost ACK after commit");}}),"unknown");
  assert.equal(await commitOrderConfirmationSettlement(store(),reference,token,1500,{now:()=>at+73*3_600_000,pipeline:async c=>{
    assert.deepEqual(c[0].slice(0,-2),first!.slice(0,-2)); return[2];
  }}),"already");
  let getters=0;
  const bad:unknown[]=[undefined,null,[],["1"],[true],[[1]],[1,1],new Array(1),Object.defineProperty(new Array(1),"0",{get(){getters++;return 1;}})];
  for(const reply of bad) assert.equal(await commitOrderConfirmationSettlement(store(),reference,token,1500,{...clock,pipeline:async()=>reply as unknown[]}),"unknown");
  assert.equal(getters,0);
});

test("unbound or expired source refuses without IO, even after the receipt expires",async()=>{
  const token=await prepare(); assert.ok(token); let calls=0;
  const pipeline=async()=>{calls++;return[1];};
  assert.equal(await commitOrderConfirmationSettlement(store(),reference,token.slice(0,-8)+"AAAAAAAA",1500,{...clock,pipeline}),"unknown","changed authentication tag");
  assert.equal(await commitOrderConfirmationSettlement(store(),reference+"other",token,1500,{...clock,pipeline}),"unknown","other source");
  assert.equal(await commitOrderConfirmationSettlement({...store(),email:"other@example.test"},reference,token,1500,{...clock,pipeline}),"unknown","other owner");
  assert.equal(await commitOrderConfirmationSettlement(store(),reference,token,1500,{now:()=>at+800*86_400_000,pipeline}),"unknown");
  assert.equal(await commitOrderConfirmationSettlement(store(),reference,token,NaN,{...clock,pipeline}),"unknown");
  let getters=0;
  const accessor=Object.defineProperty({...store()},"email",{get(){getters++;return "checkpoint@example.test";}});
  assert.equal(await commitOrderConfirmationSettlement(accessor,reference,token,1500,{...clock,pipeline}),"unknown");
  assert.equal(getters,0);
  assert.equal(calls,0);
});

test("preintent persists the actual admission before Stripe exists and recovers without a WeakMap reconstruction",async()=>{
  const source=store(),admission=await acknowledgedAdmission(source),original=identity();
  const intent=await prepareOrderConfirmationPreintent(source,admission,original,clock);assert.ok(intent);const token=intent.token;
  const opened=unseal(token,`order-confirmation-preintent|${original.nonce}`);assert.equal(opened.ok,true);
  if(!opened.ok) throw Error("Synthetic preintent did not open");
  const before=JSON.parse(opened.value).original;
  assert.equal(before.hour,hour);assert.equal(before.window,"2026-10-20");assert.equal(before.month,"2026-10");assert.equal(before.captured,at);
  assert.equal(await prepareOrderConfirmationPreintent(source,{ok:true,hour},original,clock),null);
  // Original request objects can disappear after POST; bind needs only the
  // persisted token and provider evidence verified by the source integration.
  const restarted={...store(),shared:true,tier:"scale",period:{start:Date.UTC(2027,0,1)/1000,end:Date.UTC(2027,1,1)/1000,renews:true}} as Store;
  const sessionId=reference.slice("checkout:".length);
  const recovered=await bindOrderConfirmationPreintent(restarted,token,{...original,sessionId},{now:()=>at+73*3_600_000});assert.ok(recovered);
  const after=unseal(recovered.settlementToken,`order-confirmation-settlement|${reference}`);assert.equal(after.ok,true);
  if(!after.ok) throw Error("Synthetic bound candidate did not open");
  assert.deepEqual(JSON.parse(after.value),{...before,reference});
  assert.equal(recovered.expiresAtMs,intent.expiresAtMs);assert.equal(recovered.intentFingerprint,intent.intentFingerprint);
  const retry=await bindOrderConfirmationPreintent(restarted,token,{...original,sessionId},{now:()=>at+73*3_600_000});assert.ok(retry);
  assert.equal(retry.bindingFingerprint,recovered.bindingFingerprint);assert.equal(retry.intentFingerprint,recovered.intentFingerprint);
  assert.notEqual(retry.settlementToken,recovered.settlementToken); // Source CAS must return its persisted winner.
  assert.equal(await prepareOrderConfirmationPreintent(source,admission,{...original,bodyDigest:"c".repeat(64)},clock),null);
  assert.equal(await prepareOrderConfirmationSettlement(source,reference,admission,clock),null);
});

test("foreign nonce/account/body, malformed session and computed identities cannot bind the preintent",async()=>{
  const source=store(),original=identity(),intent=await prepareOrderConfirmationPreintent(source,await acknowledgedAdmission(source),original,clock);assert.ok(intent);const token=intent.token;
  const sessionId=reference.slice("checkout:".length),match={...original,sessionId};
  for(const wrong of [{...match,nonce:"c".repeat(64)},{...match,accountId:"acct_TestOther01"},{...match,bodyDigest:"c".repeat(64)},{...match,sessionId:"cs_unverified"}]) {
    assert.equal(await bindOrderConfirmationPreintent(source,token,wrong,clock),null);
  }
  let getters=0,coercions=0;
  const accessor=Object.defineProperty({...match},"accountId",{get(){getters++;return match.accountId;}});
  assert.equal(await bindOrderConfirmationPreintent(source,token,accessor,clock),null);
  const computed={...match,nonce:{toString(){coercions++;return match.nonce;}}};
  assert.equal(await bindOrderConfirmationPreintent(source,token,computed as never,clock),null);
  assert.equal(getters,0);assert.equal(coercions,0);
  assert.equal(await bindOrderConfirmationPreintent({...source,email:"foreign@example.test"},token,match,clock),null);
  assert.equal(await bindOrderConfirmationPreintent(source,token,match,{now:()=>at-1}),null);
  assert.equal(await bindOrderConfirmationPreintent(source,token,match,{now:()=>at+800*86_400_000}),null);
  const changed=store(),admitted=await acknowledgedAdmission(changed);changed.stripeAccountId="acct_TestOther01";
  assert.equal(await prepareOrderConfirmationPreintent(changed,admitted,{...original,accountId:changed.stripeAccountId},clock),null);
  const a=await bindOrderConfirmationPreintent(source,token,match,clock);
  const b=await bindOrderConfirmationPreintent(source,token,{...match,sessionId:sessionId+"other"},clock);
  assert.ok(a);assert.ok(b);assert.notEqual(a.bindingFingerprint,b.bindingFingerprint);
  // Valid-shaped different sessions are candidates, not permission to replace
  // one another. Their immutable winner is enforced by the funded source CAS.
});

/** Disposable loopback only. This transport exercises the production TS
 * preparation/commit functions and actual Lua together; no account or sender.
 */
async function localPipeline(commands:Command[]):Promise<unknown[]> {
  const port=Number(process.env.MARKTMORGEN_CONFIRMATION_REDIS_PORT);
  if(process.env.MARKTMORGEN_REDIS_INTEGRATION!=="1" || !Number.isInteger(port) || port<1024 || port>65535) throw Error("Dedicated disposable loopback Redis required");
  const encoded=commands.map(c=>`*${c.length}\r\n`+c.map(v=>{const s=String(v);return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;}).join("")).join("");
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:"127.0.0.1",port});let buffer=Buffer.alloc(0);
    const parse=(start:number):{value:unknown;end:number}|null=>{
      const eol=buffer.indexOf("\r\n",start);if(eol<0)return null;
      const kind=String.fromCharCode(buffer[start]),text=buffer.toString("utf8",start+1,eol),next=eol+2;
      if(kind==="+")return{value:text,end:next};
      if(kind==="-")throw Error(text);
      if(kind===":")return{value:Number(text),end:next};
      if(kind==="$"){const n=Number(text);if(n===-1)return{value:null,end:next};if(buffer.length<next+n+2)return null;return{value:buffer.toString("utf8",next,next+n),end:next+n+2};}
      if(kind==="*"){const n=Number(text);if(n===-1)return{value:null,end:next};const out=[];let cursor=next;for(let i=0;i<n;i++){const item=parse(cursor);if(!item)return null;out.push(item.value);cursor=item.end;}return{value:out,end:cursor};}
      throw Error("Invalid disposable Redis reply");
    };
    socket.setTimeout(5000,()=>socket.destroy(Error("Disposable Redis timed out")));
    socket.on("error",reject);socket.on("connect",()=>socket.write(encoded));
    socket.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);try{const replies=[];let cursor=0;for(let i=0;i<commands.length;i++){const item=parse(cursor);if(!item)return;replies.push(item.value);cursor=item.end;}socket.end();resolve(replies);}catch(e){socket.destroy();reject(e);}});
  });
}

if(process.env.MARKTMORGEN_REDIS_INTEGRATION==="1") test("production TS plus real Redis keeps the other order's hold after a lost ACK and 73h",async()=>{
  const serverTime=(await localPipeline([["TIME"]]))[0];assert.ok(Array.isArray(serverTime));
  // Deliberately lag the worker without changing the admitted hour/window.
  const realAt=Number(serverTime[0])*1000+Math.floor(Number(serverTime[1])/1000)-73*3_600_000;
  const realClock={now:()=>realAt},realHour=Math.floor(realAt/3_600_000);
  const source={...store(),period:{start:Math.floor(realAt/1000)-10*86400,end:Math.floor(realAt/1000)+20*86400,renews:true}};
  const ref=`checkout:cs_test_realCheckpoint${process.pid}`;
  let admissionKeys:string[]=[];
  const previous=redis.pipeline;
  redis.pipeline=async commands=>{
    if(admissionKeys.length===0) {
      assert.equal(commands[0][0],"EVAL");admissionKeys=commands[0].slice(3,7).map(String);
      await localPipeline([["DEL",...admissionKeys]]);
    }
    return localPipeline(commands);
  };
  let token:string|null, second:Awaited<ReturnType<typeof admitOrders>>;
  try {
    const admitted=await admitOrders(source,1,realAt,2);
    assert.equal(admitted.ok,true);
    second=await admitOrders(source,1,realAt,2);assert.equal(second.ok,true);
    token=await prepareOrderConfirmationSettlement(source,ref,admitted,realClock);
  } finally {redis.pipeline=previous;}
  assert.ok(token);
  let command:Command|undefined;
  await commitOrderConfirmationSettlement(source,ref,token,1500,{...realClock,pipeline:async c=>{command=c[0];return[-1];}});
  assert.ok(command);const keys=command.slice(3,9).map(String),bytes=Number(command[11]);
  let secondKeys:string[]=[];
  try {
    assert.deepEqual(await localPipeline([["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]),["2",String(2*bytes)]);
    assert.equal(await commitOrderConfirmationSettlement(source,ref,token,1500,{...realClock,pipeline:async c=>{await localPipeline(c);throw Error("Synthetic ACK lost");}}),"unknown");
    const before=await localPipeline([["GET",keys[1]],["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]);
    assert.deepEqual(before,["1","1",String(bytes)]);
    assert.equal(await commitOrderConfirmationSettlement(source,ref,token,1500,{now:()=>realAt+73*3_600_000,pipeline:localPipeline}),"already");
    assert.deepEqual(await localPipeline([["GET",keys[1]],["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]),before);
    assert.equal(await commitOrderConfirmationSettlement(source,ref,token,1501,{...realClock,pipeline:localPipeline}),"unknown");
    assert.deepEqual(await localPipeline([["GET",keys[1]],["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]),before);
    // A third order is still held when B fails after all accounting effects.
    // Its hold must survive every retry of B's uncertain intent.
    redis.pipeline=localPipeline;
    try {assert.equal((await admitOrders(source,1,realAt,2)).ok,true);}finally{redis.pipeline=previous;}
    const secondRef=ref+"B",secondToken=await prepareOrderConfirmationSettlement(source,secondRef,second!,realClock);assert.ok(secondToken);
    assert.equal(await commitOrderConfirmationSettlement(source,secondRef,secondToken,1500,{...realClock,pipeline:async c=>{
      secondKeys=c[0].slice(3,9).map(String);
      const fault=c.map(row=>[...row]);
      const finish="redis.call('SET',KEYS[1],receipt,'PXAT',untilAt)";
      assert.ok(String(fault[0][1]).includes(finish));
      fault[0][1]=String(fault[0][1]).replace(finish,"error('synthetic TS partial settlement'); "+finish);
      return localPipeline(fault);
    }}),"unknown");
    const partial=await localPipeline([["GET",keys[1]],["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]);
    assert.deepEqual(partial,["2","1",String(bytes)]);
    assert.match(String((await localPipeline([["GET",secondKeys[0]]]))[0]),/^oci:/);
    assert.equal(await commitOrderConfirmationSettlement(source,secondRef,secondToken,1500,{now:()=>realAt+73*3_600_000,pipeline:localPipeline}),"unknown");
    assert.deepEqual(await localPipeline([["GET",keys[1]],["HGET",keys[2],String(realHour)],["HGET",keys[3],String(realHour)]]),partial);
  } finally {await localPipeline([["DEL",...keys,...admissionKeys,...secondKeys]]);}
});

if(process.env.MARKTMORGEN_REDIS_INTEGRATION==="1") test("persisted preintent survives process death before the create-session ACK",async()=>{
  const serverTime=(await localPipeline([["TIME"]]))[0];assert.ok(Array.isArray(serverTime));
  const created=Number(serverTime[0])*1000+Math.floor(Number(serverTime[1])/1000)-73*3_600_000;
  const source={...store(),period:{start:Math.floor(created/1000)-10*86400,end:Math.floor(created/1000)+20*86400,renews:true}};
  const previous=redis.pipeline;let admissionKeys:string[]=[];
  const persistedKey=`marktmorgen:integration:preintent:${process.pid}`;
  try {
    redis.pipeline=async commands=>{
      admissionKeys=commands[0].slice(3,7).map(String);await localPipeline([["DEL",...admissionKeys]]);
      return localPipeline(commands);
    };
    const admission=await admitOrders(source,1,created,2);assert.equal(admission.ok,true);
    redis.pipeline=previous;
    const original=identity(),intent=await prepareOrderConfirmationPreintent(source,admission,original,{now:()=>created});assert.ok(intent);const token=intent.token;
    // This isolated storage round trip represents persisted bytes, not the
    // production source's funding/CAS protocol, which the integrator owns.
    await localPipeline([["SET",persistedKey,token,"PX",60_000]]);
    const stored=(await localPipeline([["GET",persistedKey]]))[0];assert.equal(stored,token);
    const sessionId="cs_test_recoveredPreintent123",current={...source,shared:true,tier:"scale",period:{start:created/1000+86400,end:created/1000+30*86400,renews:true}};
    const child=spawnSync(process.execPath,[__filename],{encoding:"utf8",env:{...process.env,MARKTMORGEN_REDIS_INTEGRATION:"0",MARKTMORGEN_PREINTENT_RECOVERY:"1",
      MARKTMORGEN_PREINTENT_FIXTURE:JSON.stringify({store:current,token:stored,identity:{...original,sessionId},now:created+73*3_600_000})}});
    assert.equal(child.status,0,child.stderr);
    const line=child.stdout.split("\n").find(value=>value.startsWith("RECOVERED:"));assert.ok(line);
    const candidate=JSON.parse(line.slice("RECOVERED:".length));assert.ok(candidate);
    const opened=unseal(candidate.settlementToken,`order-confirmation-settlement|checkout:${sessionId}`);assert.equal(opened.ok,true);
    if(!opened.ok)throw Error("Recovered candidate did not open");
    const recovered=JSON.parse(opened.value);
    assert.equal(recovered.captured,created);assert.equal(recovered.hour,Math.floor(created/3_600_000));assert.equal(recovered.share,0);
    assert.equal(recovered.window,new Date(source.period.start*1000).toISOString().slice(0,10));
    assert.equal((await localPipeline([["GET",admissionKeys[0]]]))[0],null); // No count before payment.
    assert.equal((await localPipeline([["HGET",admissionKeys[1],String(recovered.hour)]]))[0],"1");
  } finally {redis.pipeline=previous;await localPipeline([["DEL",persistedKey,...admissionKeys]]);}
});
