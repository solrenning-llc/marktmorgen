import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {resolve,join} from "node:path";
const appRoot=resolve(process.argv[2]??".");
const require=createRequire(join(appRoot,"package.json"));
const {chromium}=require("playwright-core");
const label=process.env.MOBILE_RENDER_LABEL??"candidate";
const version=process.env.MOBILE_RENDER_SHA??"unknown";
const port=3177,LOCAL="http://127.0.0.1:"+port;
// 281 [SF1]: creators' pages too. The demo store is seeded into the same stand-in services the end-to-end run
// uses (tests/e2e/services.mjs: Redis, Stripe and the rest answered locally, nothing real), so its store page and a
// product page are measured under the same phone, network and thresholds as the platform's own pages.
// Loaded from the measured app, which has its own node_modules in CI (the stand-ins bundle lib/redis-memory.ts with esbuild).
const {pathToFileURL}=await import("node:url");
const {startServices}=await import(pathToFileURL(join(appRoot,"tests/e2e/services.mjs")).href);
const SERVICES=4478,FAKE="http://127.0.0.1:"+SERVICES;
const services=await startServices(SERVICES);
const storeEnv={
 DEMO_STUDIO_ADMIN:"operator@example.test",STRIPE_DEMO_ACCOUNT_ID:"acct_fixtureDemo",
 UPSTASH_REDIS_REST_URL:FAKE,UPSTASH_REDIS_REST_TOKEN:"local",
 STRIPE_SECRET_KEY:"sk_test_local_only_a_stand_in_0000",STRIPE_CONNECT_API_BASE:FAKE,
 VERCEL_BLOB_API_URL:FAKE+"/blob-api",BLOB_READ_WRITE_TOKEN:"vercel_blob_rw_localstore_standinsecret0000",
};
const app=spawn(process.execPath,[join(appRoot,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{cwd:appRoot,env:{...process.env,...storeEnv,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
let output="";app.stdout.on("data",data=>{output=(output+data).slice(-6000);});app.stderr.on("data",data=>{output=(output+data).slice(-6000);});
let browser;const results=[];let failed=false;
try{
 let ready=false;for(let attempt=0;attempt<120;attempt++){if(app.exitCode!==null)throw Error("Application exited: "+output);try{const reply=await fetch(LOCAL);if(reply.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}if(!ready)throw Error("Application unavailable: "+output);
 browser=await chromium.launch({channel:"chrome",headless:true});
 // The demo store is made on its first visit (lib/demo-seed.ts); asked here, outside any measurement.
 const demo=await fetch(LOCAL+"/demo",{redirect:"follow"});
 if(!demo.ok||!new URL(demo.url).pathname.startsWith("/@"))throw Error("Demo store not seeded: "+demo.status+" "+demo.url);
 const storePath=new URL(demo.url).pathname;
 // The demo's main product (DEMO_PRODUCT in lib/demo-seed.ts, "Weekly Meal Planner"), not whichever product link comes first.
 const productPath=(await demo.text()).match(new RegExp('href="('+storePath.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+'/p/weekly-meal-planner-[a-z0-9]+)"'))?.[1];
 if(!productPath)throw Error("No product link on the demo store page");
 const STORE_PATHS=new Set([storePath,productPath]);
 for(const path of ["/","/pricing","/platform/sales-pages",storePath,productPath])for(let sample=1;sample<=3;sample++){
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  try{
   const page=await context.newPage();const cdp=await context.newCDPSession(page);
   await cdp.send("Emulation.setCPUThrottlingRate",{rate:4});await cdp.send("Network.enable");await cdp.send("Network.setCacheDisabled",{cacheDisabled:true});
   await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:150,downloadThroughput:1600000/8,uploadThroughput:750000/8});
   let writes=0,visitBeacons=0;await page.route("**/*",route=>{const request=route.request(),url=new URL(request.url());if(!["GET","HEAD"].includes(request.method())){/* A creator's page counts its visit (components/store-beacon.tsx): aborted like every write, and said, not failed. */if(STORE_PATHS.has(path)&&request.method()==="POST"&&url.pathname==="/api/store/hit"){visitBeacons++;return route.abort();}writes++;return route.abort();}/* A creator's pictures are read from the store's own API: reads, let through so they count in the page's time. */if(STORE_PATHS.has(path)&&url.origin===LOCAL&&(url.pathname.startsWith("/api/image/")||url.pathname.startsWith("/api/photo/")))return route.continue();if(url.pathname.startsWith("/api/")||url.origin!==LOCAL)return route.abort();return route.continue();});
   await page.addInitScript(()=>{
    window.__renderLab={lcp:null,lcpAttribution:null,cls:0,lastShift:0,windowStart:0,windowScore:0,paint:[],events:[],shifts:[],longTasks:[],animationFrames:[],inputTargets:[]};
    new PerformanceObserver(list=>{for(const entry of list.getEntries()){window.__renderLab.lcp=entry.startTime;window.__renderLab.lcpAttribution={tag:entry.element?.tagName,id:entry.element?.id,text:entry.element?.textContent?.trim().slice(0,120),url:entry.url,size:entry.size,loadTime:entry.loadTime,renderTime:entry.renderTime};}}).observe({type:"largest-contentful-paint",buffered:true});
    new PerformanceObserver(list=>{const state=window.__renderLab;for(const entry of list.getEntries()){if(entry.hadRecentInput)continue;state.shifts.push({value:entry.value,at:entry.startTime,sources:(entry.sources??[]).map(source=>({node:source.node?.outerHTML?.slice(0,220),previous:source.previousRect,current:source.currentRect}))});if(!state.windowStart||entry.startTime-state.lastShift>1000||entry.startTime-state.windowStart>5000){state.windowStart=entry.startTime;state.windowScore=0;}state.lastShift=entry.startTime;state.windowScore+=entry.value;state.cls=Math.max(state.cls,state.windowScore);}}).observe({type:"layout-shift",buffered:true});
    if(PerformanceObserver.supportedEntryTypes.includes("event"))new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.interactionId)window.__renderLab.events.push({id:entry.interactionId,duration:entry.duration,name:entry.name,startTime:entry.startTime,processingStart:entry.processingStart,processingEnd:entry.processingEnd});}).observe({type:"event",buffered:true,durationThreshold:16});
    if(PerformanceObserver.supportedEntryTypes.includes("longtask"))new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__renderLab.longTasks.push({startTime:entry.startTime,duration:entry.duration});}).observe({type:"longtask",buffered:true});
    if(PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"))new PerformanceObserver(list=>{
     for(const frame of list.getEntries())window.__renderLab.animationFrames.push({
      startTime:frame.startTime,duration:frame.duration,blockingDuration:frame.blockingDuration,
      firstUIEventTimestamp:frame.firstUIEventTimestamp,renderStart:frame.renderStart,styleAndLayoutStart:frame.styleAndLayoutStart,
      scripts:frame.scripts.map(script=>({sourceURL:script.sourceURL,sourceFunctionName:script.sourceFunctionName,sourceCharPosition:script.sourceCharPosition,invoker:script.invoker,invokerType:script.invokerType,duration:script.duration,executionStart:script.executionStart,forcedStyleAndLayoutDuration:script.forcedStyleAndLayoutDuration}))
     });
    }).observe({type:"long-animation-frame",buffered:true});
    document.addEventListener("pointerdown",event=>{if(!event.isTrusted)return;window.__renderLab.inputTargets.push({at:performance.now(),target:event.target?.closest?.("summary,button")?.outerHTML?.slice(0,450),scrollY});const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__renderLab.paint.push(performance.now()-start)));},{capture:true});
   });
   const reply=await page.goto(LOCAL+path,{waitUntil:"load",timeout:60000});if(reply.status()!==200)throw Error("HTTP "+reply.status()+" "+path);
   await page.evaluate(()=>document.fonts.ready);
   await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation=>animation.finished.catch(()=>{})));});
   // Two rendering frames, not a claim that this represents a real-user percentile.
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const before=await page.evaluate(()=>({lcp:window.__renderLab.lcp,lcpAttribution:window.__renderLab.lcpAttribution,cls:window.__renderLab.cls,shifts:window.__renderLab.shifts}));
   // Browser counters identify whether a slow native disclosure spent its time
   // in script, layout or style. Read outside the measured pointer-to-paint
   // interval; preserve every cold sample and the existing strict thresholds.
   await cdp.send("Performance.enable");
   const metricNames=["TaskDuration","ScriptDuration","LayoutDuration","RecalcStyleDuration","LayoutCount","RecalcStyleCount","JSHeapUsedSize"];
   const metrics=async()=>Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.filter(metric=>metricNames.includes(metric.name)).map(metric=>[metric.name,metric.value]));
   const browserWork=[];
   const control=page.locator("main summary,main button[aria-expanded]").first();
   if(await control.count())for(let interaction=0;interaction<3;interaction++){
    const start=await metrics();
    await control.click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const end=await metrics();
    browserWork.push({interaction:interaction+1,delta:Object.fromEntries(metricNames.map(name=>[name,(end[name]??0)-(start[name]??0)])),heapBytes:end.JSHeapUsedSize??null});
   }
   const interaction=await page.evaluate(()=>{const state=window.__renderLab;return {paint:state.paint,event:state.events,longTasks:state.longTasks,animationFrames:state.animationFrames,inputTargets:state.inputTargets};});
   const interactionMs=interaction.paint.length?Math.max(...interaction.paint,...interaction.event.map(item=>item.duration)):null;
   const result={label,version,path,sample,viewport:390,cpuSlowdown:4,latencyMs:150,downloadMbps:1.6,cache:"cold",thirdPartyRequests:"blocked",apiWrites:writes,lcpMs:before.lcp,lcpAttribution:before.lcpAttribution,cls:before.cls,interactionToPaintMs:interactionMs,eventTiming:interaction.event,longTasks:interaction.longTasks,longAnimationFrames:interaction.animationFrames,inputTargets:interaction.inputTargets,fieldINP:null,browserWork,layoutShiftSources:before.shifts};
   result.creatorPage=STORE_PATHS.has(path);
   if(result.creatorPage){
    result.visitBeaconsAborted=visitBeacons;
    // Pictures the page drew, and those that did not load: a page measured without its pictures is said so, never hidden.
    Object.assign(result,await page.evaluate(()=>{const pictures=[...document.querySelectorAll("main img")];return {picturesShown:pictures.filter(img=>img.complete&&img.naturalWidth>0).length,picturesMissing:pictures.filter(img=>!(img.complete&&img.naturalWidth>0)).length};}));
   }
   result.targets={lcp:typeof before.lcp==="number"&&before.lcp<2500,cls:before.cls<0.1,interaction:interactionMs!==null&&interactionMs<200};
   console.log("MOBILE_RENDER_MEASUREMENT:"+JSON.stringify(result));results.push(result);
   if(writes||!Number.isFinite(before.lcp)||!Number.isFinite(before.cls)||interactionMs===null)failed=true;
   if(label==="candidate"&&Object.values(result.targets).some(value=>!value))failed=true;
   // After preserving every cold performance measurement, exercise the real
   // cycle slots and native disclosure. No warm-up or threshold changes.
   if(path==="/"&&sample===1){
    // This check is after every cold measurement above; it neither warms
    // the disclosure nor changes timing, thresholds, samples or input events.
    if(!await control.evaluate(node=>node===document.activeElement))throw Error("Native pointer focus was not retained");
    if(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior)!=="auto")throw Error("Native disclosure pointer focus still animates document scrolling");
    // VS1 (owner, 30/10/2026): the home page shows one plan, Store, read from
    // lib/plan.ts, with a link to compare all plans. The three-card monthly/
    // yearly switch it used to carry moved, unchanged, to the pricing page,
    // where the link points and where it is checked below.
    const plan=page.locator("[data-home-plan]");
    if(!(await plan.innerText()).includes("$69 a month"))throw Error("Home plan price mismatch");
    if(await plan.getByRole("link",{name:"Start free",exact:true}).getAttribute("href")!=="/signin")throw Error("Home plan start lost");
    if(await page.getByRole("link",{name:"Compare Store, Studio and Scale",exact:true}).getAttribute("href")!=="/pricing#plans")throw Error("Compare plans link lost");
   }
   if(path==="/pricing"&&sample===1){
    // The plan cards and their monthly/yearly switch, moved here from the old
    // home page (VS1): the same regression that protected them there.
    if(await page.locator("#plans[data-plan-prices]").count()!==1)throw Error("Pricing plans anchor lost");
    const cards=page.locator("[data-plan-prices] [data-pricing-card]");
    if(await cards.count()!==3)throw Error("Expected three canonical plan cards");
    const summaries=cards.locator('details[class~="group/perks"] > summary');
    const disclosures=cards.locator('details[class~="group/perks"]');
    const nativeState=await disclosures.evaluateAll(nodes=>nodes.map(node=>node.open));
    const cycle=page.getByRole("group",{name:"How often you pay"});
    const year=cycle.getByRole("button",{name:/^Yearly/}),month=cycle.getByRole("button",{name:"Monthly",exact:true});
    await year.focus();await page.keyboard.press("Enter");
    if(await year.getAttribute("aria-pressed")!=="true"||await month.getAttribute("aria-pressed")!=="false")throw Error("Yearly keyboard selection not reflected");
    const annual=["$690","$4,490","$9,990"],monthly=["$69","$449","$999"],tiers=["creator","pro","scale"];
    for(let i=0;i<3;i++){
     const card=cards.nth(i);
     if((await card.locator("[data-cycle-text]").first().innerText()).trim()!==annual[i])throw Error("Annual card price mismatch");
     // 243 [CF6]: the terms are said once, under the three cards, with each plan's first charge.
     if(!await page.locator("[data-plan-terms] dl").innerText().then(text=>text.includes(annual[i])&&text.includes("for the year")))throw Error("Annual first-charge terms mismatch");
     if(await card.getByRole("link",{name:/^Start on/}).getAttribute("href")!=="/signin?plan="+tiers[i]+"&billing=year")throw Error("Annual signup choice lost");
    }
    await month.click();
    for(let i=0;i<3;i++){
     const card=cards.nth(i);
     if((await card.locator("[data-cycle-text]").first().innerText()).trim()!==monthly[i])throw Error("Monthly card price mismatch");
     if(!await page.locator("[data-plan-terms] dl").innerText().then(text=>text.includes(monthly[i]+",")||text.includes(monthly[i]+" for the month")))throw Error("Monthly first-charge terms mismatch");
     if(await card.getByRole("link",{name:/^Start on/}).getAttribute("href")!=="/signin?plan="+tiers[i]+"&billing=month")throw Error("Monthly signup choice lost");
     if(!(await card.innerText()).includes(annual[i]))throw Error("Pricing plan annual price missing "+i);
    }
    if(JSON.stringify(await disclosures.evaluateAll(nodes=>nodes.map(node=>node.open)))!==JSON.stringify(nativeState))throw Error("Billing selection replaced native disclosure state");
    const before=await disclosures.first().evaluate(node=>node.open);
    await summaries.first().focus();await page.keyboard.press("Enter");
    if(await disclosures.first().evaluate(node=>node.open)===before)throw Error("Native keyboard disclosure did not toggle");
    console.log("PRICING_CYCLE_REGRESSION: home Store price and start, compare link to #plans, and on pricing three monthly/yearly prices, first-charge terms, signup URLs, pressed state, native state retention and keyboard disclosure passed");
   }
  }finally{await context.close();}
 }
 console.log("MOBILE_RENDER_SUMMARY:"+JSON.stringify({label,version,samples:results.length,scope:"Synthetic cold local Chromium lab. Interaction-to-paint is a lab proxy, not field INP; no p75 Core Web Vitals certification.",results}));
}catch(error){failed=true;console.error(error);console.error(output);}finally{
 // Each step on its own, so a browser that fails to close never leaves the app or the stand-ins running until the job's timeout.
 await browser?.close().catch(error=>console.error("browser close failed",error));
 if(app.exitCode===null){const gone=new Promise(done=>app.once("exit",done));app.kill("SIGTERM");await Promise.race([gone,new Promise(done=>setTimeout(done,15000))]);if(app.exitCode===null)app.kill("SIGKILL");}
 await services?.close?.().catch(error=>console.error("stand-ins close failed",error));
}
process.exitCode=failed?1:0;
