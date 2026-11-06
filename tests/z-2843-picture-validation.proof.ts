/** Independent #2843 proof: page ownership is not a completed picture check. Synthetic transports only. */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {addProduct,claimHandle,ensureStatsId,imageFolder,setProductPage,storeForEmail} from '@/lib/store';
import {readPage} from '@/lib/sales-page-store';
import {picturePaths} from '@/lib/sales-page';
import {store as redis} from '@/tests/redis-stub';
import * as transport from '@/tests/failure-cleanup-world';
import {POST as door} from '@/app/api/store/image/upload/route';
import {POST as pageRoute} from '@/app/api/store/page/route';

export const get=transport.get,put=transport.put,del=transport.del,list=transport.list;
export const issueSignedToken=transport.issueSignedToken,presignUrl=transport.presignUrl;
let pausePath='',paused=false,started:()=>void=()=>{},release:()=>void=()=>{};
let startedPromise:Promise<void>=Promise.resolve(),releasePromise:Promise<void>=Promise.resolve();
export async function head(path:string){
 if(path===pausePath&&!paused){paused=true;started();await releasePromise;}
 return transport.head(path);
}
const OWNER='picture-validation@example.test';
const JPEG=new Uint8Array([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0]);
const PDF=new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x37]);
let external=0;
globalThis.fetch=(async()=>{external++;throw new Error('No supplier transport in this proof');}) as typeof fetch;
const post=(session:string,route:string,body:unknown)=>new NextRequest(`https://marktmorgen.com/api/store/${route}`,{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify(body)});
async function setup(valid:boolean){
 redis.clear();transport.files.clear();transport.deleted.length=0;external=0;pausePath='';paused=false;
 for(const key of Object.keys(transport.calls) as (keyof typeof transport.calls)[])transport.calls[key]=0;
 await claimHandle(OWNER,'zpicturevalidation','Synthetic pictures','');await ensureStatsId(OWNER);
 const made=await addProduct(OWNER,'Synthetic guide','','19',null);assert.equal(made.ok,true);if(!made.ok)throw new Error('setup');
 assert.equal((await setProductPage(OWNER,made.product.id,true)).ok,true);
 const store=(await storeForEmail(OWNER))!;const session=await openSession(OWNER);const folder=await imageFolder(OWNER);
 const path=`images/${folder}/${'a'.repeat(32)}.jpg`;
 const response=await door(post(session,'image/upload',{type:'blob.generate-presigned-url',payload:{pathname:path,clientPayload:JSON.stringify({productId:made.product.id}),multipart:false}}));
 assert.equal(response.status,200,'the real picture door admits the synthetic name');
 transport.files.set(path,{bytes:valid?JPEG:PDF,contentType:'image/jpeg',at:Date.now()+1});
 transport.calls.head=0;transport.calls.get=0;
 const body={id:made.product.id,page:{blocks:[{id:'pics0001',kind:'pictures',heading:'',items:[{path,width:1200,height:800,alt:'Synthetic picture',caption:''}]}]}};
 const save=()=>pageRoute(post(session,'page',body));
 const snapshot=async(label:string,statuses:number[],extra:Record<string,unknown>={})=>{
  const stored=await readPage(store.statsId,made.product.id);const shown=picturePaths(stored).includes(path);
  console.log(JSON.stringify({label,statuses,shown,fileKept:transport.files.has(path),blobHead:transport.calls.head,blobGet:transport.calls.get,external,...extra}));
  assert.equal(external,0);return shown;
 };
 return{store,path,id:made.product.id,save,snapshot};
}
test('control: a healthy picture saves and is checked once',async()=>{
 const x=await setup(true);const first=await x.save(),second=await x.save();
 assert.equal(await x.snapshot('valid-control',[first.status,second.status]),true);assert.deepEqual([first.status,second.status,transport.calls.head,transport.calls.get],[200,200,1,1]);
});
test('control: an invalid file is refused before it can be shown',async()=>{
 const x=await setup(false);const first=await x.save();
 assert.equal(await x.snapshot('invalid-control',[first.status]),false);assert.equal(first.status,400);
});
test('an applied ownership claim with a lost response cannot make retry skip validation',async()=>{
 const x=await setup(false);const original=redis.pipeline;let appliedThenLost=false;
 redis.pipeline=(async function(commands:(string|number)[][]){
  const answer=await original.call(redis,commands);
  if(!appliedThenLost&&commands.some(c=>c[0]==='HSETNX'&&c[1]===`nl:product:pics:${x.store.statsId}`&&c[2]===x.path)){
   appliedThenLost=true;throw new Error('Synthetic response lost after the real ownership write');
  }
  return answer;
 }) as typeof redis.pipeline;
 let first:Response;
 try{first=await x.save();}finally{redis.pipeline=original;}
 const second=await x.save();const shown=await x.snapshot('ownership-response-lost',[first.status,second.status],{appliedThenLost});
 assert.equal(shown,false,'a completed ownership write must not certify uninspected picture bytes');
 assert.notEqual(second.status,200);
});
test('a second save cannot publish a file while the first validation is pending',async()=>{
 const x=await setup(false);pausePath=x.path;
 startedPromise=new Promise<void>(resolve=>{started=resolve;});releasePromise=new Promise<void>(resolve=>{release=resolve;});
 const firstPromise=x.save();
 const early=await Promise.race([startedPromise.then(()=> 'head-started'),firstPromise.then(()=> 'save-finished')]);
 assert.equal(early,'head-started','the first save reaches the genuine Blob check');
 let second:Response;let first:Response;
 try{second=await x.save();}finally{release();first=await firstPromise;pausePath='';}
 const shown=await x.snapshot('concurrent-validation',[first.status,second.status]);
 assert.equal(shown,false,'a pending validation must not let a concurrent save publish invalid or deleted bytes');
 assert.notEqual(second.status,200);
});
