/** Run only against a local checkout. Real source, synthetic data, no network/provider credentials. */
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const root=resolve(process.argv[2]||process.cwd()),require=createRequire(join(root,"package.json"));
const {build}=require("esbuild"),{testAliases,testEnvironment}=await import(pathToFileURL(join(root,"tests/test-config.mjs")));
const temp=mkdtempSync(join(tmpdir(),"k2-tone-review-"));
let browser;
try{
 const route=join(temp,"route.cjs");
 await build({entryPoints:[join(root,"proofs/k2/review-2790-tone.proof.ts")],outfile:route,bundle:true,platform:"node",format:"cjs",alias:testAliases("failure-cleanup-paths.test.ts",root,join(root,"tests")),logLevel:"error"});
 const run=spawnSync(process.execPath,[route],{cwd:root,env:testEnvironment({PATH:process.env.PATH,HOME:process.env.HOME}),encoding:"utf8"});
 process.stdout.write(run.stdout);process.stderr.write(run.stderr);
 const canvas=join(temp,"canvas.js");
 await build({entryPoints:[join(root,"components/shrink-image.ts")],outfile:canvas,bundle:true,platform:"browser",format:"iife",globalName:"K2Shrink",alias:{"@":root},logLevel:"error"});
 browser=await require("playwright-core").chromium.launch({headless:true});
 const context=await browser.newContext();let attempted=0;
 await context.route("**/*",r=>{attempted++;return r.abort();});
 const page=await context.newPage();await page.addScriptTag({content:readFileSync(canvas,"utf8")});
 const observations=await page.evaluate(async()=>{
  const results=[];
  for(const kind of ["opaque","one transparent pixel","transparent stripe","jpeg control"]){
   const source=document.createElement("canvas");source.width=1024;source.height=1024;
   const ctx=source.getContext("2d");ctx.fillStyle="#336699";ctx.fillRect(0,0,1024,1024);
   if(kind==="one transparent pixel")ctx.clearRect(511,511,1,1);
   if(kind==="transparent stripe")ctx.clearRect(0,0,64,1024);
   const png=await new Promise(done=>source.toBlob(done,"image/png"));
   const shrunk=await globalThis.K2Shrink.shrink(new File([png],"synthetic.png",{type:"image/png"}),1600,1000000,kind==="jpeg control");
   const bitmap=await createImageBitmap(shrunk.blob),decoded=document.createElement("canvas");decoded.width=bitmap.width;decoded.height=bitmap.height;
   const target=decoded.getContext("2d");target.drawImage(bitmap,0,0);
   const pixels=target.getImageData(0,0,bitmap.width,bitmap.height).data;let transparent=0;
   for(let i=3;i<pixels.length;i+=4)if(pixels[i]<255)transparent++;
   bitmap.close();results.push({kind,width:shrunk.width,type:shrunk.blob.type,tone:shrunk.tone,transparent});
  }return results;
 });
 let failures=run.status!==0?1:0;
 for(const item of observations){const pass=item.transparent>0?item.tone===null:typeof item.tone==="string";if(!pass)failures++;console.log("CANVAS_OBSERVATION",JSON.stringify({...item,pass}));}
 console.log("BROWSER_REQUESTS",attempted);if(attempted)failures++;
 process.exitCode=failures?1:0;
}finally{await browser?.close();rmSync(temp,{recursive:true,force:true});}
