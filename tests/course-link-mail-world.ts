import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {claimHandle,ensureStatsId,setProductCourse,setPastBuyers,addProduct,storeForEmail} from '@/lib/store';
import {readProduct} from '@/lib/catalog';
import {grantImported} from '@/lib/imported-purchases';
import {sendCourseLink,requestCourseLink,openCourseLink,LINK_SECONDS} from '@/lib/learn';
import {sendEmail} from '@/lib/email';
import {POST as courseLinkRoute} from '@/app/api/store/course/link/route';
import {CURRENT_RESEND_FALLBACK_REVIEW} from '@/lib/resend-fallback-budget';
import {CURRENT_RESEND_CREDENTIAL_BINDING} from '@/lib/resend-fallback-transport';
import {createResendFallbackFixture} from '@/tests/resend-fallback-fixture';
import {store as redis} from '@/tests/redis-stub';

const origin='https://marktmorgen.com';
const source='real course-link functions under test';
const owner='course-proof-owner@example.test';
const buyer='course-proof-buyer@example.test';
const stranger='course-proof-stranger@example.test';
type Command=(string|number)[];

/** Actual business functions. Only Redis is replaced by MemoryRedis; the
 * sole positive transport is explicitly synthetic and calls the REAL guard.
 * All application sends retain the actual null review/binding defaults. */
export async function auditCourseMail(){
 process.env.RESEND_API_KEY='re_SYNTHETIC_COURSE_PROOF_NO_PROVIDER';
 process.env.NIMBUS_DATA_KEY='SYNTHETIC_COURSE_PROOF_NO_ACCOUNT';
 for(const k of ['AWS_SES_ROLE_ARN','AWS_SES_REGION','AWS_SES_CONFIGURATION_SET','AWS_SES_TOPIC_ARN','VERCEL_OIDC_TOKEN','VERCEL','STRIPE_SECRET_KEY'])delete process.env[k];
 assert.equal(CURRENT_RESEND_FALLBACK_REVIEW,null);
 assert.equal(CURRENT_RESEND_CREDENTIAL_BINDING,null);
 let blockedFetch=0;
 const previousFetch=globalThis.fetch;
 globalThis.fetch=async()=>{blockedFetch++;throw Error('FORBIDDEN_EXTERNAL_IO');};
 redis.clear();
 const originalPipeline=redis.pipeline.bind(redis);
 let trace:Command[]=[];
 redis.pipeline=async commands=>{trace.push(...commands.map(c=>[...c]));return originalPipeline(commands);};
 try{
  assert.ok((await claimHandle(owner,'course-proof-school','Proof School','')).ok);
  await ensureStatsId(owner);await setPastBuyers(owner);
  const made=await addProduct(owner,'Original course','Original summary','49',null);assert.ok(made.ok);
  await setProductCourse(owner,made.product.id,{id:'c'.repeat(32),lessons:1});
  const stored=(await storeForEmail(owner))!;
  const product=(await readProduct(stored,made.product.id))!;assert.ok(product.course);
  // A pre-existing independent imported right, written by its real function.
  // This is not a claim that a synthetic source is a real Stripe purchase.
  assert.deepEqual(await grantImported(stored.statsId!,'a'.repeat(24),[{email:buyer,productId:product.id,items:null}],1793293200,stored.sid),[true]);
  const paidStore={...stored,subscriptionActive:true,subscriptionId:null,trialEnds:0,planEndedAt:'',tier:'pro' as const};
  const snapshot=async()=>{
   const allowanceKeys=redis.keys().filter(k=>k.startsWith('nl:allow:transactional:'));
   const values=await originalPipeline(allowanceKeys.map(k=>['GET',k]));
   const links=redis.keys().filter(k=>k.startsWith('nl:learn:link:')&&!k.endsWith(':opens'));
   return {transactionalUsed:values.reduce<number>((sum,v)=>sum+Number(v),0),tokens:links.length,tokenTTLs:await originalPipeline(links.map(k=>['TTL',k]))};
  };
  const fixture=await createResendFallbackFixture({credential:process.env.RESEND_API_KEY!,cap:2,fetch:async()=>Response.json({id:'SYNTHETIC_ACCEPTED_POSITIVE_CONTROL'})});
  const positive=await sendEmail({meter:{by:'store',store:paidStore,kind:'transactional'},from:'Marktmorgen <owner@example.test>',to:buyer,subject:'Positive control',text:'Original'},fixture.runtime);
  assert.equal(positive,true);
  const direct=[];
  for(let i=0;i<3;i++){
   const before=await snapshot();trace=[];
   const result=await sendCourseLink(paidStore,product,buyer,origin);
   const commands=trace.map(c=>[...c]);const after=await snapshot();
   assert.equal(result,false);
   direct.push({result,before,after,commands:commands.length,grantSets:commands.filter(c=>c[0]==='SET'&&String(c[1]).startsWith('nl:learn:link:')).length});
  }
  async function requested(email:string,ip:string){
   const before=await snapshot();trace=[];
   const result=await requestCourseLink({store:paidStore,product,email,ip,origin});
   const commands=trace.map(c=>[...c]);const after=await snapshot();
   return {result,before,after,commands:commands.length,entitlementLookups:commands.filter(c=>/nl:learn:(paid|enr):/.test(String(c[1]))).length,rateMutations:commands.filter(c=>['SET','INCR'].includes(String(c[0]))&&String(c[1]).startsWith('nl:learn:rate:')).length};
  }
  const entitled=await requested(buyer,'203.0.113.10');
  const unentitled=await requested(stranger,'203.0.113.11');
  async function routed(email:string,ip:string){
   const before=await snapshot();trace=[];
   const reply=await courseLinkRoute(new NextRequest(origin+'/api/store/course/link',{method:'POST',headers:{Host:'marktmorgen.com',Origin:origin,'Content-Type':'application/x-www-form-urlencoded','x-forwarded-for':ip},body:new URLSearchParams({handle:stored.handle,product:product.id,email})}));
   const commands=trace.map(c=>[...c]);const after=await snapshot();
   return {status:reply.status,location:reply.headers.get('location'),before,after,commands:commands.length,entitlementLookups:commands.filter(c=>/nl:learn:(paid|enr):/.test(String(c[1]))).length};
  }
  const entitledRoute=await routed(buyer,'203.0.113.12');
  const unentitledRoute=await routed(stranger,'203.0.113.13');
  assert.equal(entitledRoute.status,303);assert.equal(unentitledRoute.status,303);
  const rateAddress=[];for(let i=0;i<6;i++)rateAddress.push(await requested('down-rate@example.test',`198.51.100.${i+1}`));
  const rateIp=[];for(let i=0;i<11;i++)rateIp.push(await requested(`down-ip-${i}@example.test`,'198.51.100.200'));
  const invalid=await requested('bad email','198.51.100.201');
  const final=await snapshot();assert.ok(final.tokenTTLs.every(ttl=>ttl===LINK_SECONDS));
  const syntheticPositivePosts=fixture.requests.filter(r=>r.method==='POST').length;assert.equal(syntheticPositivePosts,1);assert.equal(blockedFetch,0);
  return {source,review:CURRENT_RESEND_FALLBACK_REVIEW,binding:CURRENT_RESEND_CREDENTIAL_BINDING,aliases:['@/lib/redis => actual MemoryRedis'],actualFunctions:['claimHandle','addProduct','setProductCourse','grantImported','sendEmail','sendCourseLink','requestCourseLink','POST /api/store/course/link'],syntheticPositivePosts,blockedFetch,direct,request:{entitled,unentitled},route:{entitled:entitledRoute,unentitled:unentitledRoute},final,rate:{address:rateAddress,ip:rateIp,invalid},requirements:{noAllowanceSpentOnKnownUnavailable:direct.every(x=>x.after.transactionalUsed===x.before.transactionalUsed),noUndeliverableToken:direct.every(x=>x.after.tokens===x.before.tokens),noEntitlementLookupWhenKnownUnavailable:entitled.entitlementLookups===0&&unentitled.entitlementLookups===0,uniformPublicResponseWhenKnownUnavailable:entitledRoute.location===unentitledRoute.location},limits:'Synthetic providers and MemoryRedis only. No activation, real provider IO, refund/access alteration, synthetic grant as proof of payment, or full-rights availability claim.'};
 }finally{redis.pipeline=originalPipeline;globalThis.fetch=previousFetch;}
}

/** Positive controls use the actual SES sender and independent imported right.
 * The fixture supplies provider HTTP/STS replies, never the send result. */
export async function proveAvailableCourseMail(){
 const {installSesMailFixture}=await import('./ses-mail-fixture');
 const fixture=installSesMailFixture();redis.clear();fixture.configure();
 try{
  await fixture.setReady(true,{max24:50_000,rate:100});
  assert.ok((await claimHandle(owner,'available-course-school','Available School','')).ok);
  await ensureStatsId(owner);await setPastBuyers(owner);
  const made=await addProduct(owner,'Original course','Original summary','49',null);assert.ok(made.ok);
  await setProductCourse(owner,made.product.id,{id:'c'.repeat(32),lessons:1});
  const stored=(await storeForEmail(owner))!,product=(await readProduct(stored,made.product.id))!;
  await grantImported(stored.statsId!,'b'.repeat(24),[{email:buyer,productId:product.id,items:null}],1793293200,stored.sid);
  const paidStore={...stored,subscriptionActive:true,subscriptionId:null,trialEnds:0,planEndedAt:'',tier:'pro' as const};
  assert.equal(await requestCourseLink({store:paidStore,product,email:'bad email',ip:'192.0.2.10',origin}),'email');
  assert.equal(await sendCourseLink(paidStore,product,buyer,origin),true);
  const first=fixture.sent.at(-1)!;assert.deepEqual(first.to,[buyer]);assert.ok(first.subject.includes('Original course'));
  const token=/token=([a-f0-9]{64})/.exec(first.text)?.[1];assert.ok(token);
  const grant=await openCourseLink(token);assert.ok(grant);assert.equal(grant.e,buyer);assert.equal(grant.p,product.id);
  assert.equal(await requestCourseLink({store:paidStore,product,email:buyer,ip:'192.0.2.11',origin}),'sent');
  assert.equal(fixture.sent.length,2);
  assert.equal(await requestCourseLink({store:paidStore,product,email:stranger,ip:'192.0.2.12',origin}),'sent');
  assert.equal(fixture.sent.length,2);
  for(let i=0;i<5;i++)assert.equal(await requestCourseLink({store:paidStore,product,email:'limited@example.test',ip:'192.0.2.13',origin}),'sent');
  assert.equal(await requestCourseLink({store:paidStore,product,email:'limited@example.test',ip:'192.0.2.13',origin}),'limited');
  assert.equal(fixture.sent.length,2);assert.equal(fixture.calls.resend,0);
 }finally{fixture.restore();}
}
