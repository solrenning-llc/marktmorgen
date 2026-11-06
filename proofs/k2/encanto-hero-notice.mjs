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
const {checkHomeHero,checkHomeHeroLayout,checkMorningNoticeFocus,checkNoticeLineRegression}=await import(pathToFileURL(join(root,"tests/e2e/home-hero.mjs")));
const {checkHomeActions}=await import(pathToFileURL(join(root,"tests/e2e/home-actions.mjs")));
if(process.env.K2_NOTICE_OBSERVER_ONLY==="1"){
 const browser=await require("playwright-core").chromium.launch({headless:true});let failures=0,checks=0;
 try{const page=await browser.newPage();await page.setContent("<!doctype html><html><body></body></html>");await checkNoticeLineRegression({page,is:(name,actual,expected)=>{checks++;try{assert.deepEqual(actual,expected);}catch{failures++;console.error("FAIL",name,JSON.stringify({actual,expected}));}}});console.log("NOTICE_LINE_RESULT",JSON.stringify({checks,failures}));}finally{await browser.close();}
 process.exit(failures?1:0);
}
const services=await startServices(4519);
const fake="http://127.0.0.1:4519",origin="http://127.0.0.1:3219";
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1",NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(root,"tests/e2e/google-fonts-mock.cjs"),E2E_FONT_ORIGIN:fake,UPSTASH_REDIS_REST_URL:fake,UPSTASH_REDIS_REST_TOKEN:"local",STRIPE_SECRET_KEY:"sk_test_local_only_a_stand_in_0000",STRIPE_CONNECT_API_BASE:fake,RESEND_API_KEY:"re_local_only_a_stand_in",RESEND_API_BASE:fake};
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"dev","--webpack","-H","127.0.0.1","-p","3219"],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
let output="",browser,checks=0,failures=0,blocked=0,writes=0;
for(const stream of [app.stdout,app.stderr])stream.on("data",c=>output=(output+c).slice(-8000));
const is=(name,actual,expected)=>{checks++;try{assert.deepEqual(actual,expected);}catch{failures++;console.error("FAIL",name,JSON.stringify({actual,expected}));}};
const guard=async context=>context.route("**/*",route=>{
 const request=route.request();
 if(!["GET","HEAD"].includes(request.method())){writes++;return route.abort();}
 if(new URL(request.url()).origin!==origin){blocked++;return route.abort();}
 return route.continue();
});
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
   await guard(context);
   const page=await context.newPage();
   for(const width of [320,390,640,768,1024,1280,1440]){
    await page.setViewportSize({width,height:1000});
    const response=await page.goto(origin+"/",{waitUntil:"networkidle",timeout:60000});
    is("HTTP "+engine+" "+width,response.status(),200);
    await page.evaluate(()=>document.fonts.ready);
    await page.locator(".hm-hero-art").evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
    console.log("CASE",JSON.stringify({engine,reducedMotion,width}));
    await checkMorningNoticeFocus({page,width,is});
    await checkHomeHeroLayout({page,width,is});
    if(engine==="chromium"&&width===320&&reducedMotion==="reduce"){
     const protocol=await context.newCDPSession(page);
     for(const expanded of [false,true]){
      if(expanded){await page.locator("summary#hm-preview-toggle").focus();await page.keyboard.press("Space");}
      const tree=await protocol.send("Accessibility.getFullAXTree");
      const nodes=tree.nodes.filter(node=>node.name?.value==="Still being built. Plans closed."&&node.properties?.some(p=>p.name==="expanded"));
      is("native browser AX disclosure exists",nodes.length,1);
      is("native browser AX disclosure role",["DisclosureTriangle","button"].includes(nodes[0]?.role?.value),true);
      is("native browser AX expanded state",nodes[0]?.properties?.find(p=>p.name==="expanded")?.value?.value,expanded);
      console.log("NOTICE_NATIVE_AX",JSON.stringify({expanded,nodes}));
     }
     await page.locator("summary#hm-preview-toggle").focus();await page.keyboard.press("Enter");
     await protocol.detach();
    }
    if(process.argv[3]&&reducedMotion==="reduce"&&[390,1440].includes(width)){
     mkdirSync(process.argv[3],{recursive:true});
     await page.locator(".hm-hero-art").screenshot({path:join(process.argv[3],engine+"-hero-"+width+".png")});
    }
   }
   for(const width of [320,390]){
    await page.setViewportSize({width,height:1000});
    await page.goto(origin+"/pricing",{waitUntil:"networkidle",timeout:60000});
    await checkMorningNoticeFocus({page,width,is});
   }
   await page.setViewportSize({width:320,height:1000});
   await page.goto(origin+"/",{waitUntil:"networkidle",timeout:60000});
   await page.addStyleTag({content:"html { font-size: 200% !important; }"});
   const summary=page.locator(".hm-preview-compact");
   is("200% native summary retained",await summary.isVisible(),true);
   if(await summary.count()){
    const size=await summary.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth,height:node.getBoundingClientRect().height,font:parseFloat(getComputedStyle(node).fontSize)}));
    is("200% summary uses enlarged type",size.font,32);
    is("200% summary reflows without clipping",size.scroll<=size.client,true);
    is("200% summary keeps large target",size.height>=44,true);
    await page.locator("#hm-preview-toggle").focus();await page.keyboard.press("Space");
    is("200% full notice accessible",(await page.locator(".hm-preview-full").innerText()).includes("its paid plans are not on sale yet"),true);
   }
   await context.close();
  }
  const plain=await browser.newContext({viewport:{width:320,height:1000},javaScriptEnabled:false,serviceWorkers:"block",reducedMotion:"reduce"});
  await guard(plain);
  const plainPage=await plain.newPage();
  await plainPage.goto(origin+"/",{waitUntil:"networkidle",timeout:60000});
  await checkMorningNoticeFocus({page:plainPage,width:320,is});
  await checkHomeHeroLayout({page:plainPage,width:320,is});
  await plain.close();
  // Preserve the existing full hero/typed-address/native sign-in journey and axe checks.
  if(process.env.K2_FULL_HERO==="1"){
   // In Next dev the document can arrive before its compiled client chunks.
   // Wait for those actual requests before exercising the hydrated journey.
   const hydratedBrowser={newContext:async options=>{
    const context=await browser.newContext(options);await guard(context);
    const newPage=context.newPage.bind(context);
    context.newPage=async()=>{const page=await newPage(),goto=page.goto.bind(page);
     page.goto=async(...args)=>{const response=await goto(...args);await page.waitForLoadState("networkidle");return response;};
     return page;
    };return context;
   }};
   await checkHomeHero({browser:hydratedBrowser,LOCAL:origin,axeSource:readFileSync(require.resolve("axe-core/axe.min.js"),"utf8"),is});
   await checkHomeActions({browser:hydratedBrowser,LOCAL:origin,axeSource:readFileSync(require.resolve("axe-core/axe.min.js"),"utf8"),is});
  }
  await browser.close();browser=undefined;
 }
 is("No browser write attempted",writes,0);
 is("No browser foreign request attempted",blocked,0);
 console.log("HERO_NOTICE_RESULT",JSON.stringify({checks,failures,blocked,writes}));
 process.exitCode=failures?1:0;
}finally{await browser?.close();app.kill("SIGTERM");await services.close();}
