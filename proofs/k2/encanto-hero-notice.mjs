/** Opt-in local Next proof. Synthetic services/fonts; no inherited credentials. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const root=resolve(process.argv[2] || process.cwd());
const require=createRequire(join(root,"package.json"));
const {startServices}=await import(pathToFileURL(join(root,"tests/e2e/services.mjs")));
const {checkHomeHero,checkHomeHeroLayout}=await import(pathToFileURL(join(root,"tests/e2e/home-hero.mjs")));
const services=await startServices(4519);
const fake="http://127.0.0.1:4519",origin="http://127.0.0.1:3219";
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1",NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(root,"tests/e2e/google-fonts-mock.cjs"),E2E_FONT_ORIGIN:fake,UPSTASH_REDIS_REST_URL:fake,UPSTASH_REDIS_REST_TOKEN:"local",STRIPE_SECRET_KEY:"sk_test_local_only_a_stand_in_0000",STRIPE_CONNECT_API_BASE:fake,RESEND_API_KEY:"re_local_only_a_stand_in",RESEND_API_BASE:fake};
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"dev","--webpack","-H","127.0.0.1","-p","3219"],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
let output="",browser,checks=0,failures=0,blocked=0,writes=0;
for(const stream of [app.stdout,app.stderr])stream.on("data",c=>output=(output+c).slice(-8000));
const is=(name,actual,expected)=>{checks++;try{assert.deepEqual(actual,expected);}catch{failures++;console.error("FAIL",name,JSON.stringify({actual,expected}));}};
try{
 let up=false;
 for(let i=0;i<60;i++){
  if(app.exitCode!==null)throw Error(output);
  try{up=(await fetch(origin+"/",{signal:AbortSignal.timeout(1000)})).ok;}catch{}
  if(up)break;
  await new Promise(r=>setTimeout(r,500));
 }
 if(!up)throw Error("App unavailable: "+output);
 const playwright=require("playwright-core");
 for(const engine of (process.env.K2_BROWSERS || "chromium").split(",")){
  if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unknown engine");
  browser=await playwright[engine].launch({headless:true});
  for(const reducedMotion of ["reduce","no-preference"]){
   const context=await browser.newContext({viewport:{width:320,height:1000},reducedMotion});
   await context.route("**/*",route=>{
    const request=route.request();
    if(!["GET","HEAD"].includes(request.method())){writes++;return route.abort();}
    if(new URL(request.url()).origin!==origin){blocked++;return route.abort();}
    return route.continue();
   });
   const page=await context.newPage();
   for(const width of [320,390,640,768,1024,1280,1440]){
    await page.setViewportSize({width,height:1000});
    const response=await page.goto(origin+"/",{waitUntil:"networkidle",timeout:60000});
    is("HTTP "+engine+" "+width,response.status(),200);
    await page.evaluate(()=>document.fonts.ready);
    await page.locator(".hm-hero-art").evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
    console.log("CASE",JSON.stringify({engine,reducedMotion,width}));
    await checkHomeHeroLayout({page,width,is});
    if(process.argv[3]&&reducedMotion==="reduce"&&[390,1440].includes(width)){
     mkdirSync(process.argv[3],{recursive:true});
     await page.locator(".hm-hero-art").screenshot({path:join(process.argv[3],engine+"-hero-"+width+".png")});
    }
   }
   await context.close();
  }
  // Preserve the existing full hero/typed-address/native sign-in journey and axe checks.
  if(process.env.K2_FULL_HERO==="1")await checkHomeHero({browser,LOCAL:origin,axeSource:readFileSync(require.resolve("axe-core/axe.min.js"),"utf8"),is});
  await browser.close();browser=undefined;
 }
 is("No browser write attempted",writes,0);
 is("No browser foreign request attempted",blocked,0);
 console.log("HERO_NOTICE_RESULT",JSON.stringify({checks,failures,blocked,writes}));
 process.exitCode=failures?1:0;
}finally{await browser?.close();app.kill("SIGTERM");await services.close();}
