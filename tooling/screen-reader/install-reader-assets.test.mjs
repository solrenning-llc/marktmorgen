import test from "node:test";
import assert from "node:assert/strict";
import {installReaderAssets,PINNED_READER_ASSETS} from "./install-reader-assets.mjs";
const env={GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:"viniciussucupira/marktmorgen",AX2_PUBLIC_DISPOSABLE_RUNNER:"true"};
const ok={status:0,signal:null,stdout:"NVDA successfully downloaded\n",stderr:""};
// The exact output of the failed merge-group jobs (guidepup 0.29.3 install).
function downloadFailure(platform,cause){
 const asset=PINNED_READER_ASSETS[platform];
 const causes={
  http504:`Cause: Error: Failed to download Guidepup cache asset: ${asset} (504 )`,
  fetchFailed:"Cause: TypeError: fetch failed",
 };
 return {status:1,signal:null,stdout:"",
  stderr:`\n[!] Error: Failed to download Guidepup cache asset: ${asset}\n\nUnable to complete screen reader installation\n\n${causes[cause]}\n`};
}
const quiet={write(){}};
test("pinned assets are exactly what the locked guidepup manifest installs on the runners",async()=>{
 const {readFileSync}=await import("node:fs");
 const manifest=JSON.parse(readFileSync(new URL("./node_modules/@guidepup/guidepup/manifest.json",import.meta.url),"utf8"));
 const assets=id=>manifest.screenReaders.find(reader=>reader.id===id).assets;
 assert.deepEqual(assets("nvda").map(asset=>asset.asset),[PINNED_READER_ASSETS.win32]);
 // macos-26 runner images report Darwin 25.
 assert.equal(assets("voiceover").find(asset=>asset.platformVersion==="25")?.asset,PINNED_READER_ASSETS.darwin);
});
test("refuses every unowned, non-disposable or unsupported host before running",async()=>{
 for(const opts of [{env:{}},{env:{...env,AX2_PUBLIC_DISPOSABLE_RUNNER:"false"}},{env:{...env,GITHUB_REPOSITORY:"other/repo"}},{env:{...env,GITHUB_ACTIONS:"false"}},{platform:"linux"}]){
  let calls=0;await assert.rejects(installReaderAssets({...quiet,env,platform:"win32",...opts,run:()=>{calls++;return ok;}}));assert.equal(calls,0);
 }
});
test("a successful install runs the exact pinned CLI once and keeps its output in the log",async()=>{
 for(const platform of ["win32","darwin"]){
  let calls=0;const written=[];
  const result=await installReaderAssets({env,platform,write:text=>written.push(text),run:(file,args,options)=>{
   calls++;assert.equal(file,process.execPath);
   assert.ok(args[0].split(String.fromCharCode(92)).join("/").endsWith("/tooling/screen-reader/node_modules/@guidepup/setup/bin/guidepup"));
   assert.deepEqual(args.slice(1),["install"]);
   assert.ok(options.cwd.split(String.fromCharCode(92)).join("/").endsWith("/tooling/screen-reader/"));
   assert.equal(options.timeout,undefined,"no new timeout beyond the job's own");
   return ok;
  }});
  assert.deepEqual(result,{attempts:1});assert.equal(calls,1);assert.deepEqual(written,[ok.stdout]);
 }
});
for(const platform of ["win32","darwin"])for(const cause of ["http504","fetchFailed"]){
 test(`${platform} pinned asset ${cause} repeats only the install once (50 runs)`,async()=>{
  for(let run=0;run<50;run++){
   let calls=0;const delays=[];
   const result=await installReaderAssets({...quiet,env,platform,wait:async ms=>{delays.push(ms);},
    run:()=>++calls===1?downloadFailure(platform,cause):ok});
   assert.deepEqual(result,{attempts:2});assert.equal(calls,2);assert.deepEqual(delays,[2000]);
  }
 });
}
test("a persistent download failure fails without a third attempt",async()=>{
 for(const platform of ["win32","darwin"]){
  let calls=0;
  await assert.rejects(installReaderAssets({...quiet,env,platform,wait:async()=>{},run:()=>{calls++;return downloadFailure(platform,"http504");}}),/remained unavailable/);
  assert.equal(calls,2);
 }
});
test("checksum, other assets, other statuses, timeouts, spawn errors and unknown failures never repeat",async()=>{
 const win=downloadFailure("win32","http504");
 for(const [platform,result] of [
  ["win32",{...win,stderr:win.stderr.replaceAll("0.2.1-2026.2","0.2.2-2026.3")}],
  ["win32",downloadFailure("darwin","http504")],
  ["darwin",downloadFailure("win32","fetchFailed")],
  ["win32",{...win,stderr:win.stderr.replace("(504 )","(503 )")}],
  ["win32",{...win,stderr:win.stderr.replace("(504 )","(404 Not Found)")}],
  ["win32",{status:1,signal:null,stderr:"[!] Error: Guidepup cache asset checksum mismatch: guidepup-nvda-0.2.1-2026.2.zip"}],
  ["win32",{...win,signal:"SIGTERM",status:null}],
  ["win32",{...win,error:Object.assign(Error("spawnSync ENOBUFS"),{code:"ENOBUFS"})}],
  ["darwin",{status:1,signal:null,stderr:"unknown error"}],
 ]){
  let calls=0;
  await assert.rejects(installReaderAssets({...quiet,env,platform,wait:async()=>{},run:()=>{calls++;return result;}}),/no permitted recovery/);
  assert.equal(calls,1);
 }
});
