/** Real upload route, session, studio allowance and Blob SDK; only supplier/Redis transports are synthetic. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {BlobNotFoundError} from '@vercel/blob';
import {uploadPresigned} from '@vercel/blob/client';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,addProduct,imageFolder} from '@/lib/store';
import {POST} from '@/app/api/store/image/upload/route';
import {BLOB_PUT_TRIES,BLOB_ADVANCED_OP,BLOB_SIMPLE_OP,COST_LINES} from './plan-cost-registry';
import {STORE_ALLOWANCES} from '@/lib/store-allowance-rules';
import {store as redis} from './redis-stub';

const ORIGIN='https://marktmorgen.com';
const world={retry:false,routeCalls:0,issued:0,studio:0,attempts:new Map<string,number>(),path:'',headers:{} as Record<string,string>};
/** Only this supplier boundary is replaced; no real signing credentials exist. */
export async function head(){throw new BlobNotFoundError();}
export async function issueSignedToken(options:{pathname:string;operations:string[];validUntil:number;maximumSizeInBytes:number;allowedContentTypes:string[]}){
 world.issued++;
 const delegationToken=Buffer.from(JSON.stringify({storeId:'store_SyntheticStore01',...options})).toString('base64url')+'.c2lnbmF0dXJl';
 return {delegationToken,clientSigningToken:'synthetic-signing-material-only',validUntil:options.validUntil};
}
const unused=async()=>{throw new Error('unexpected synthetic Blob operation');};
export {unused as get,unused as del,unused as put,unused as list,unused as presignUrl};
/** No URL leaves the process. Actual SDK requests and retry headers arrive here. */
export async function fetch(input:string|URL|Request,init:RequestInit={}){
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.origin===ORIGIN){
  assert.equal(url.pathname,'/api/store/image/upload');world.routeCalls++;
  return POST(new NextRequest(url,{...init,signal:init.signal??undefined,headers:{...Object.fromEntries(new Headers(init.headers)),...world.headers}}));
 }
 assert.ok((url.hostname==='vercel.com'&&url.pathname.startsWith('/api/blob'))||url.hostname==='blob.vercel-storage.com','unexpected network boundary is forbidden');
 assert.ok(url.searchParams.get('vercel-blob-delegation'));assert.ok(url.searchParams.get('vercel-blob-signature'));
 const action=new Headers(init.headers).get('x-mpu-action')??'put';
 const n=(world.attempts.get(action)??0)+1;world.attempts.set(action,n);
 if(world.retry&&n<=10)return Response.json({error:{code:'service_unavailable',message:'synthetic transient failure'}},{status:503});
 if(action==='create')return Response.json({uploadId:'synthetic-upload',key:world.path});
 if(action==='upload')return Response.json({etag:'synthetic-etag'});
 return Response.json({url:'https://synthetic.example.invalid/picture.jpg',downloadUrl:'https://synthetic.example.invalid/picture.jpg',pathname:world.path,contentType:'image/jpeg',contentDisposition:'inline',etag:'synthetic-etag'});
}

for(const [name,multipart,retry] of [['single healthy',false,false],['multipart healthy',true,false],['single retry ceiling',false,true],['multipart retry ceiling',true,true]] as const){
 test(name+': one admitted studio request covers every advanced attempt',async(t)=>{
  redis.clear();world.attempts.clear();world.routeCalls=0;world.issued=0;world.studio=0;world.retry=retry;
  const owner='blob-cost-proof@example.invalid';await claimHandle(owner,'blobcostproof','Synthetic pictures','');await ensureStatsId(owner);
  const product=await addProduct(owner,'Synthetic guide','','19',null);assert.equal(product.ok,true);if(!product.ok)throw Error('setup');
  const session=await openSession(owner);world.headers={cookie:`${SESSION_COOKIE}=${session}`,'sec-fetch-site':'same-origin'};
  world.path=`images/${await imageFolder(owner)}/${'b'.repeat(32)}.jpg`;
  process.env.BLOB_WEBHOOK_PUBLIC_KEY='synthetic-public-key-no-provider-account';
  const original=redis.pipeline.bind(redis);
  redis.pipeline=(async(commands:(string|number)[][])=>{const answer=await original(commands);for(const c of commands)if(c[0]==='INCRBY'&&String(c[1]).startsWith('nl:allow:studio:'))world.studio+=Number(c[2]);return answer;}) as typeof redis.pipeline;
  // The SDK's real async-retry still decides exactly which calls retry. Only its backoff clock is advanced.
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false,failure:unknown;
  const task=uploadPresigned(world.path,Buffer.from([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0]),{access:'private',contentType:'image/jpeg',multipart,handleUploadUrl:ORIGIN+'/api/store/image/upload',clientPayload:JSON.stringify({productId:product.product.id})});
  void task.then(()=>{settled=true;},e=>{settled=true;failure=e;});
  try{
   for(let tick=0;tick<200&&!settled;tick++){await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(2_000_000);}
   assert.equal(settled,true,'finite SDK test must settle');if(failure)throw failure;await task;
   assert.equal(world.routeCalls,1);assert.equal(world.issued,1);assert.equal(world.studio,1);
   const attempts=[...world.attempts.values()].reduce((a,b)=>a+b,0);
   assert.equal(attempts,(multipart?3:1)*(retry?11:1),'actual SDK stage/attempt count');
   const registered=COST_LINES.find(line=>line.id==='picture-uploads')!.monthlyUsd('creator')/STORE_ALLOWANCES.creator.studio;
   // This request only opens and uploads: no attach/GET. Conservatively allow eleven name HEAD attempts too.
   const uploadCostBound=attempts*BLOB_ADVANCED_OP+11*BLOB_SIMPLE_OP;
   assert.ok(uploadCostBound<=registered,'the WHOLE registered request budget still covers this upload, even when the advanced component alone is smaller');
   console.log('EVIDENCE',JSON.stringify({name,multipart,retry,studioUnits:world.studio,routeCalls:world.routeCalls,advancedAttempts:attempts,stages:Object.fromEntries(world.attempts),advancedAttemptsPriced:BLOB_PUT_TRIES,registeredRequestUsd:registered,uploadCostBoundUsd:uploadCostBound,totalBudgetCovers:true}));
   assert.ok(attempts<=BLOB_PUT_TRIES*world.studio,'all potentially billable advanced attempts must fit the registered per-request ceiling');
  }finally{redis.pipeline=original;t.mock.timers.reset();}
 });
}
