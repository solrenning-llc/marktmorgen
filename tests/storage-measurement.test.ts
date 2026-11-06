/**
 * Bundle with blob, vault and stream aliases to storage-provider-stub.ts.
 * Exercises the real file aggregation and upload authorization, without provider credentials.
 */
import { filesHeld } from "@/lib/file-store";
import { fits, storageUsed } from "@/lib/storage-quota";
import { resetStorageAnswers, storageAnswers as answers } from "./storage-provider-stub";
import { done, is } from "./check";
const folder="0123456789abcdef0123456789abcdef";
const path=(n:number)=>`stores/${folder}/file-${n}`;
const page=(n:number,hasMore=false,cursor?:string)=>({blobs:[{pathname:path(n),size:n}],hasMore,cursor});
async function main():Promise<void>{
 resetStorageAnswers();
 let held=await storageUsed(folder,100);
 is("confirmed empty storage remains available",[held.bytes,held.left,held.available],[0,100,true]);
 is("confirmed free space authorizes upload",fits(held,50),true);
 resetStorageAnswers(); answers.pages=[page(10,true,"next"),page(20)]; answers.vault=30;answers.video=40;
 held=await storageUsed(folder,200);
 is("all providers and pages contribute",[held.bytes,held.left,held.available],[100,100,true]);
 for(const state of ["paid","trial","none","ended"] as const){
  resetStorageAnswers();answers.fail=true;held=await storageUsed(folder,100);
  is("failed provider blocks "+state, fits(held,1),false);
  is("failure is unavailable, not full", [held.available,held.full,held.left],[false,false,0]);
 }
 for(const bad of [null,-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){
  resetStorageAnswers();answers.vault=bad;held=await storageUsed(folder,100);
  is("unknown or invalid vault cannot authorize",held.available,false);
  resetStorageAnswers();answers.video=bad;held=await storageUsed(folder,100);
  is("unknown or invalid video cannot authorize",held.available,false);
 }
 const cases:unknown[][]=[
  [{blobs:[],hasMore:true}],
  [page(1,true,"same"),page(2,true,"same")],
  [page(1,true,"next"),page(1)],
  [{blobs:[{pathname:path(1)}],hasMore:false}],
  [{blobs:[{pathname:path(1),size:-1}],hasMore:false}],
  [{blobs:[{pathname:"stores/another/file",size:1}],hasMore:false}],
  [{blobs:[{pathname:path(1),size:0.5}],hasMore:false}],
  [{blobs:null,hasMore:false}],
  [{blobs:[]}],
  Array.from({length:20},(_,i)=>page(i,true,String(i+1))),
 ];
 for(const pages of cases){
  resetStorageAnswers();answers.pages=pages;held=await storageUsed(folder,100);
  is("incomplete or invalid listing blocks more storage",held.available,false);
 }
 resetStorageAnswers();answers.pages=Array.from({length:20},(_,i)=>page(i,i<19,i<19?String(i+1):undefined));
 is("twentieth final page is complete",await filesHeld(folder),190);
 const fullPage=()=>Array.from({length:1000},(_,i)=>({pathname:path(i),size:1}));
 resetStorageAnswers();answers.pages=[{blobs:fullPage(),hasMore:false}];
 held=await storageUsed(folder,1001);
 is("the complete requested thousand-entry page remains usable",[held.bytes,held.available,fits(held,1)],[1000,true,true]);
 resetStorageAnswers();answers.pages=[{blobs:Array.from({length:1001},(_,i)=>({pathname:path(i),size:0})),hasMore:false}];
 held=await storageUsed(folder,100);
 is("an oversized final page is unavailable, never confirmed empty",[held.available,held.full,held.left,fits(held,1)],[false,false,0,false]);
 resetStorageAnswers();answers.pages=[page(10,true,"next"),{blobs:Array.from({length:1001},(_,i)=>({pathname:path(i+100),size:0})),hasMore:false}];
 held=await storageUsed(folder,100);
 is("an oversized later page cannot authorize from its valid partial prefix",[held.available,fits(held,1)],[false,false]);
 resetStorageAnswers();answers.pages=Array.from({length:20},(_,p)=>({blobs:Array.from({length:1000},(_,i)=>({pathname:path(p*1000+i),size:1})),hasMore:p<19,cursor:p<19?String(p+1):undefined}));
 held=await storageUsed(folder,20001);
 is("all twenty full requested pages remain measurable",[held.bytes,held.available,fits(held,1)],[20000,true,true]);
 resetStorageAnswers();answers.pages=[{blobs:[{pathname:path(1),size:Number.MAX_SAFE_INTEGER}],hasMore:false}];answers.vault=1;
 is("unsafe aggregate blocks upload",(await storageUsed(folder,100)).available,false);
 resetStorageAnswers();answers.pages=[page(100)];
 held=await storageUsed(folder,100);
 is("confirmed full remains distinct",[held.available,held.full],[true,true]);
 is("missing folder cannot authorize",(await storageUsed("",100)).available,false);
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
