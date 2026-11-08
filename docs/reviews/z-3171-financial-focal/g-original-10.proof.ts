/** G independent: direct REAL POST handlers, synthetic requests only, no HTTP server/provider.
 * No assertion that echoing a made-up signature grants Blob authority. It only tests the claimed funded pairing.
 */
import { NextRequest } from "next/server";
import { POST as imagePost } from "@/app/api/store/image/upload/route";
import { POST as filePost } from "@/app/api/store/file/route";
import { store as redis } from "../../../tests/redis-stub";
import { done, is, part } from "../../../tests/check";
const params:Record<string,string>={};for(let i=0;i<7;i++)params['x'+i]='x'.repeat(1900);
const madeUp={delegationToken:"not-issued",signature:"not-a-real-signature",params};
const body=JSON.stringify({type:"blob.generate-presigned-url",payload:{pathname:"no-store/no-file",clientPayload:JSON.stringify({handBack:madeUp}),multipart:false}});
const first=JSON.stringify({type:"blob.generate-presigned-url",payload:{pathname:"no-store/no-file",clientPayload:JSON.stringify({productId:"missing"}),multipart:false}});
function request(path:string,raw:string,cross=false){return new NextRequest('https://marktmorgen.test'+path,{method:"POST",headers:{host:"marktmorgen.test","content-type":"application/json","content-length":String(Buffer.byteLength(raw)),...(cross?{origin:"https://other.test"}:{})},body:raw});}
async function main(){
 const oldEnv=process.env.VERCEL_ENV,oldKey=process.env.BLOB_WEBHOOK_PUBLIC_KEY;process.env.VERCEL_ENV="production";
 // Presence-only SDK configuration; no callback verifies this value and no signature/token is issued.
 process.env.BLOB_WEBHOOK_PUBLIC_KEY="G-synthetic-public-fixture-unused-for-no-cookie-request";
 try{
 for(const [path,post] of [["/api/store/image/upload",imagePost],["/api/store/file",filePost]] as const){
  part(path+": claimed one funded hand-back per paid studio request");redis.clear();
  is("synthetic request is below the real 16000-byte ceiling",Buffer.byteLength(body)<16000,true);
  is("cross-site POST still refused",(await post(request(path,body,true))).status,403);
  const normal=await post(request(path,first));
  is("ordinary unsigned first leg refused without a session",normal.status===401||normal.status===403,true);
  const responses=[];
  for(let i=0;i<3;i++){const r=await post(request(path,body));const text=await r.text();responses.push({status:r.status,bytes:Buffer.byteLength(text)});}
  console.log("G_PAIRING",JSON.stringify({path,bodyBytes:Buffer.byteLength(body),initialAccepted:0,responses,keys:redis.keys(),runs:(globalThis as unknown as {__sRuns?:number}).__sRuns}));
  is("no storage key or allowance was written",redis.keys(),[]);
  is("without a first accepted studio leg no hand-back is funded",responses.filter(r=>r.status===200).length,0);
 }
 }finally{if(oldEnv===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=oldEnv;if(oldKey===undefined)delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;else process.env.BLOB_WEBHOOK_PUBLIC_KEY=oldKey;redis.clear();}
 done();
}
void main();
