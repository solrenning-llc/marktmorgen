import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {build} from "esbuild";
import {startServices} from "./services.mjs";
import {resolve,join} from "node:path";
const root=resolve(".");
const require=createRequire(join(root,"package.json"));
const engine=process.env.E2E_BROWSER??"chromium";
if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unsupported engine "+engine);
const driver=require("playwright-core")[engine];
const axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const port=3197,origin="http://localhost:"+port;
const here=join(root,"tests/e2e"),FAKE="http://127.0.0.1:4497";
const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_"+"x".repeat(30),
  ANTHROPIC_API_BASE: FAKE,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
  STRIPE_CONNECT_API_BASE: FAKE,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};

async function completedResponse(page,response){
 await page.waitForFunction(url=>window.__mmRscBodies?.some(entry=>entry.url===url&&entry.done),response.url(),{timeout:60000});
 const body=await page.evaluate(url=>window.__mmRscBodies.findLast(entry=>entry.url===url&&entry.done),response.url());
 if(body.error||!body.bytes)throw Error("Browser RSC body failed "+JSON.stringify(body));
 return body;
}
const services=await startServices(4497);
const folder=mkdtempSync(join(tmpdir(),"mm-studio-matrix-")),seedFile=join(folder,"seed.cjs");
let fixture;
try{
 await build({entryPoints:[join(here,"store-copy-seed.ts")],bundle:true,platform:"node",format:"cjs",outfile:seedFile,logLevel:"error",alias:{"@":root}});
 const seeded=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[seedFile],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let data="";child.stdout.on("data",chunk=>data+=chunk);child.stderr.on("data",chunk=>data+=chunk);child.on("error",reject);child.on("close",code=>code===0?resolve(data):reject(Error("Synthetic seed failed")));});
 fixture=JSON.parse(seeded.trim().split("\n").at(-1)).activationFixture;
 if(!fixture?.session||!fixture?.sid)throw Error("Incomplete synthetic fixture");
}catch(error){await services.close();throw error;}finally{rmSync(folder,{recursive:true,force:true});}
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{env,stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
let browser,failed=0,cases=0;const gaps=[];
try{
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error(output);try{up=(await fetch(origin)).ok;}catch{}if(up)break;await new Promise(resolve=>setTimeout(resolve,500));}if(!up)throw Error("Local app unavailable "+output);
 browser=await driver.launch();console.log("PRODUCT_MATRIX_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 for(const path of ["/studio?store="+fixture.sid])for(const width of [320,390,768,1280,1920])for(const mode of ["baseline","text-spacing","reduced-motion","forced-colors","reflow-320",...(process.env.AX2_PUBLIC_STANDARD==="true"?["dark"]:[])]){
  const viewportWidth=mode==="reflow-320"?320:width;
  const context=await browser.newContext({...(mode==="dark"?{colorScheme:"dark"}:{}),viewport:{width:viewportWidth,height:900},serviceWorkers:"block",reducedMotion:mode==="reduced-motion"?"reduce":"no-preference",forcedColors:mode==="forced-colors"?"active":"none"});
  if(mode==="text-spacing")await context.addInitScript(()=>document.addEventListener("DOMContentLoaded",()=>{const style=document.createElement("style");style.textContent="*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";document.head.append(style);},{once:true}));
  await context.addInitScript(()=>{
   window.__mmRscBodies=[];
   const original=window.fetch;
   window.fetch=async function(...args){
    const response=await original.apply(this,args);
    if(new URL(response.url).searchParams.has("_rsc")){
     const entry={url:response.url,done:false,bytes:0,error:null,text:""};window.__mmRscBodies.push(entry);
     response.clone().text().then(text=>{entry.bytes=text.length;entry.text=text;entry.done=true;},error=>{entry.error=String(error);entry.done=true;});
    }
    return response;
   };
  });
  await context.addCookies([{name:"nl_session",value:fixture.session,url:origin}]);
  let writes=0,foreign=0,localProductWrites=0,interceptedVisits=0,expectedVisits=1;const errors=[],blockedWrites=[];
  try{
   const page=await context.newPage();
   // Capture native delivery without re-clicking, forcing focus or changing actionability.
   await page.addInitScript(()=>{
    window.__mmProductPointerEvents=[];
    for(const type of ["pointerdown","pointerup","mousedown","mouseup","click"]){
     document.addEventListener(type,event=>{
      const element=event.target instanceof Element?event.target:null;
      const button=element?.closest("button"),rect=button?.getBoundingClientRect();
      window.__mmProductPointerEvents.push({
       type,trusted:event.isTrusted,target:element?.tagName,id:element?.id??"",
       button:button?.textContent?.trim().slice(0,100)??null,
       disabled:button?.disabled??null,x:event.clientX,y:event.clientY,scrollX,scrollY,
       time:performance.now(),fonts:document.fonts.status,
       opener:(()=>{const node=[...document.querySelectorAll("[data-product-editor] button")].find(node=>node.textContent.trim()==="Add something to sell");if(!node)return null;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,transform:style.transform,font:style.font,lineHeight:style.lineHeight};})(),
       editor:(()=>{const node=document.querySelector("[data-product-editor]");if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,children:node.children.length,expanded:node.querySelectorAll('button[aria-expanded="true"]').length};})(),
       rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null
      });
      if(window.__mmProductPointerEvents.length>30)window.__mmProductPointerEvents.shift();
      if(type==="pointerdown"&&button?.textContent.trim()==="Add something to sell"){
       window.__mmProductMutations=[];
       window.__mmProductMutationObserver?.disconnect();
       window.__mmProductMutationObserver=new MutationObserver(records=>{
        for(const record of records){if(window.__mmProductMutations.length>=20)break;const node=record.target instanceof Element?record.target:record.target.parentElement;window.__mmProductMutations.push({time:performance.now(),type:record.type,attribute:record.attributeName,tag:node?.tagName,id:node?.id,className:node?.className?.toString().slice(0,200),added:record.addedNodes.length,removed:record.removedNodes.length});}
       });
       const root=document.querySelector("[data-product-editor]");
       if(root)window.__mmProductMutationObserver.observe(root,{subtree:true,attributes:true,childList:true,characterData:true});
       setTimeout(()=>window.__mmProductMutationObserver?.disconnect(),1000);
      }
     },true);
    }
   });

   const restoreDarkAfterNavigation=async()=>{
    if(mode!=="dark")return;
    const before=await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches);
    await page.emulateMedia({colorScheme:"dark"});
    const after=await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches);
    console.log("AX2_DARK_NAVIGATION:"+JSON.stringify({engine,path:page.url(),before,after}));
    if(!after)throw Error("Dark color-scheme request not honored after navigation");
   };

   // Explicit page emulation avoids a Firefox page override masking context media.
   if(mode==="dark")await page.emulateMedia({colorScheme:"dark"});
   page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(60000);page.on("pageerror",error=>errors.push(String(error)));
   // Observe frame lifecycles without changing browser execution or swallowing failures.
   const frameIds=new WeakMap();let frameSequence=0,frameEvents=0;
   const describeFrame=frame=>{try{if(!frameIds.has(frame))frameIds.set(frame,++frameSequence);const u=new URL(frame.url()||"about:blank"),parent=frame.parentFrame();if(parent&&!frameIds.has(parent))frameIds.set(parent,++frameSequence);return {id:frameIds.get(frame),parent:parent?frameIds.get(parent):null,origin:u.origin,path:u.pathname};}catch{return {unavailable:true};}};
   if(engine==="firefox")for(const event of ["frameattached","framedetached","framenavigated"])page.on(event,frame=>{if(frameEvents++<40)console.log("PRODUCT_FRAME_EVENT:"+JSON.stringify({engine,width,mode,event,frame:describeFrame(frame)}));});
   await context.route("**/*",route=>{const r=route.request(),url=new URL(r.url());if(url.origin===origin&&url.pathname==="/api/store/hit"&&r.method()==="POST"){const raw=r.postData(),input=raw?r.postDataJSON():null;const missingWebkit=engine==="webkit"&&!raw&&new URL(r.frame().url()).pathname==="/@activationonboarding";if(missingWebkit)gaps.push({path,width,mode,reason:"WebKit exposes no beacon body to routing. Only same-origin store-hit POST from the exact synthetic storefront is fulfilled204 without executing stats; payload validation remains unverified."});if(!missingWebkit&&(input?.h!=="activationonboarding"||input?.k!=="v")){writes++;blockedWrites.push({method:r.method(),path:url.pathname,handle:input?.h,kind:input?.k,bodyBytes:r.postData()?.length??0});return route.abort();}interceptedVisits++;return route.fulfill({status:204});}if(!["GET","HEAD"].includes(r.method())){if(url.origin===origin&&url.pathname==="/api/store/product"&&r.method()==="POST"&&["add","visibility"].includes(r.postDataJSON()?.action)){localProductWrites++;return route.continue();}writes++;blockedWrites.push({method:r.method(),path:url.pathname});return route.abort();}if(url.origin!==origin){foreign++;return route.abort();}return route.continue();});
   const response=await page.goto(origin+path,{waitUntil:"networkidle",timeout:60000});await restoreDarkAfterNavigation();if(response.status()!==200)throw Error("HTTP "+response.status());
   if(new URL(page.url()).pathname.startsWith("/signin"))throw Error("Synthetic authenticated journey redirected to sign-in");
   if(!await page.locator("main").count())throw Error("Authenticated main missing");
   await page.getByRole("button",{name:"Add something to sell",exact:true}).click();
   const title="Synthetic matrix "+engine+" "+width+" "+mode;
   const form=page.locator("form").filter({has:page.locator("#product-title-new")});
   try {
    await page.locator("#product-title-new").fill(title);
   } catch (error) {
    const opener = page.getByRole("button",{name:"Add something to sell",exact:true});
    console.error("PRODUCT_OPENER_DIAGNOSTIC:"+JSON.stringify({
     engine,width,mode,url:page.url(),errors:errors.slice(-8),
     titleFields:await page.locator("#product-title-new").count(),
     nativeDelivery:await page.evaluate(()=>({
      events:window.__mmProductPointerEvents,
      mutations:window.__mmProductMutations,
      active:document.activeElement?.outerHTML.slice(0,600),
      scroll:{x:scrollX,y:scrollY}
     })),

     openerCount:await opener.count(),
     opener:await opener.evaluateAll(nodes=>nodes.slice(0,3).map(node=>({
      disabled:node.disabled,html:node.outerHTML.slice(0,1200),
      rect:{x:node.getBoundingClientRect().x,y:node.getBoundingClientRect().y,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}
     }))),
     mainText:(await page.locator("main").innerText()).slice(-5000),
     pendingRsc:await page.evaluate(()=>window.__mmRscBodies.slice(-5).map(({url,done,bytes,error})=>({url,done,bytes,error})))
    }));
    throw error;
   }
   await page.locator("#product-summary-new").fill("Disposable local product; no real payment, email or delivery.");
   await page.locator("#product-price-new").fill("0");
   if(mode==="forced-colors"){
    const active=await page.evaluate(()=>matchMedia("(forced-colors: active)").matches);
    if(!active)gaps.push({path,width,mode,reason:"Engine did not activate forced-colors media after emulation request; real OS/device validation remains open."});
   }
   if(mode==="reduced-motion"&&!await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches))throw Error("Reduced-motion request not honored");
   const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,internalOverflow:[...document.querySelectorAll("body *")].filter(node=>node.clientWidth>1&&node.scrollWidth>node.clientWidth+1&&getComputedStyle(node).overflowX==="visible").slice(0,30).map(node=>({html:node.outerHTML.slice(0,500),scroll:node.scrollWidth,client:node.clientWidth,overflow:getComputedStyle(node).overflowX})),offenders:[...document.querySelectorAll("body *")].filter(node=>{const b=node.getBoundingClientRect();if(!(b.width>0&&(b.right>document.documentElement.clientWidth+1||b.left< -1)))return false;for(let parent=node.parentElement;parent&&parent!==document.documentElement;parent=parent.parentElement){if(["auto","scroll","hidden","clip"].includes(getComputedStyle(parent).overflowX))return false;}return true;}).slice(0,12).map(node=>({html:node.outerHTML.slice(0,400),left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right}))}));
   if(overflow.scroll>overflow.client)throw Error("Horizontal overflow "+JSON.stringify(overflow));
   // Actual keyboard events; no scripted focus or focus-style suppression.
   if(mode==="baseline"){
    let focused=0;
    for(let n=0;n<10;n++){
     await page.keyboard.press("Tab");
     const state=await page.evaluate(()=>{const node=document.activeElement;if(!node||node===document.body)return null;const b=node.getBoundingClientRect();return {tag:node.tagName,visible:node.matches(":focus-visible"),width:b.width,height:b.height};});
     if(state){focused++;if(!state.visible||state.width<=0||state.height<=0)throw Error("Keyboard focus not visible "+JSON.stringify(state));}
    }
    if(!focused)throw Error("No keyboard target reached");
   }
   // Audit at a repeatable document origin, rather than a different product row under the sticky navigation after each fill.
   await page.evaluate(()=>{document.activeElement?.blur?.();delete window.__mmAuditOriginSince;});
   await page.waitForFunction(()=>{if(scrollX!==0||scrollY!==0){window.scrollTo({top:0,left:0,behavior:"instant"});delete window.__mmAuditOriginSince;return false;}window.__mmAuditOriginSince??=performance.now();return performance.now()-window.__mmAuditOriginSince>=200;});
   await page.evaluate(()=>{delete window.__mmAuditOriginSince;if(scrollX!==0||scrollY!==0)throw Error("Audit viewport origin changed after settlement");});
   gaps.push({path,width,mode,reason:"Whole-document axe is anchored at scroll0. Intermediate scroll positions under sticky navigation still require manual occlusion review; this run does not close that gap."});
   if(mode==="dark"&&!await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches))throw Error("Dark color-scheme request not honored");
   await page.addScriptTag({content:axe});
   const report=await page.evaluate(async()=>{
    const tags=["wcag2a","wcag2aa","wcag2aaa","wcag21a","wcag21aa","wcag21aaa","wcag22a","wcag22aa","wcag22aaa"];
    const selected=window.axe.getRules().filter(rule=>rule.tags.some(tag=>tags.includes(tag)));
    if(!selected.some(rule=>rule.ruleId==="color-contrast-enhanced"))throw Error("AAA enhanced-contrast rule missing");
    const result=await window.axe.run(document,{runOnly:{type:"tag",values:tags}});
    return {auditScroll:{x:scrollX,y:scrollY},rules:selected.map(rule=>rule.ruleId),violations:result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target),nodes:rule.nodes.map(node=>({target:node.target,html:node.html.slice(0,600),summary:node.failureSummary,geometry:(()=>{const element=document.querySelector(node.target[0]);if(!element)return null;const b=element.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,viewport:{width:innerWidth,height:innerHeight},hits:[b.top+2,b.top+b.height/2,b.bottom-2].map(y=>{const hit=document.elementFromPoint(b.left+b.width/2,y);return {y,inside:!!hit&&element.contains(hit),html:hit?.outerHTML.slice(0,250)??null};})};})()}))})),incomplete:result.incomplete.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)}))};
   });
   if(report.incomplete.length)gaps.push({path,width,mode,manualReview:report.incomplete});
   console.log("PRODUCT_MATRIX_CASE:"+JSON.stringify({engine,path,width,mode,viewportWidth,writes,foreign,...report,errors}));
   if(report.violations.length||errors.length||writes)failed++;
   // Only the real disposable local product API is allowed to mutate.
   let expectedWrites=1;
   console.log("PRODUCT_ACTION_PHASE:"+JSON.stringify({engine,width,mode,phase:"focus-add"}));
   await form.getByRole("button",{name:"Add it",exact:true}).focus();
   const creationRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==="/studio"&&response.request().headers()["rsc"]==="1"&&!response.request().headers()["next-router-prefetch"]);creationRefresh.catch(()=>{});
   const creation=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/store/product"&&response.request().method()==="POST");
   if(engine==="firefox")console.log("PRODUCT_FRAME_BEFORE_CREATE:"+JSON.stringify({width,mode,frames:page.frames().map(describeFrame),iframes:await page.locator("iframe").evaluateAll(nodes=>nodes.slice(0,20).map(node=>({id:node.id,title:node.title,srcdoc:node.hasAttribute("srcdoc"),hidden:node.hidden})))}));
   await page.keyboard.press("Enter");
   console.log("PRODUCT_ACTION_PHASE:"+JSON.stringify({engine,width,mode,phase:"await-create"}));
   const created=await creation,creationData=await created.json();if(!created.ok()||creationData.ok!==true||!creationData.product||creationData.product.title!==title||!/^[a-z0-9]+$/.test(creationData.product.id))throw Error("Local product creation refused");
   const createdId=creationData.product.id;
   await page.locator(".nb-toast-region [role=status]").getByText("Product added.",{exact:true}).waitFor({state:"attached"});
   const createdRefresh=await creationRefresh;if(!createdRefresh.ok()||(await completedResponse(page,createdRefresh)).error)throw Error("Create RSC refresh failed");
   await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   await page.reload({waitUntil:"networkidle"});
   const row=page.locator("#products li").filter({has:page.locator('button[aria-controls="product-panel-'+createdId+'"]')});
   if(await row.count()!==1)throw Error("Created product row is not unique");
   await row.waitFor();
   const embedPreview=page.locator('#buy-button iframe');
   if(await embedPreview.count())throw Error("Card preview loaded before explicit request");
   await page.getByRole("button",{name:"Show card preview",exact:true}).click();
   await embedPreview.waitFor();
   await page.waitForFunction(()=>document.querySelector('#buy-button iframe')?.contentDocument?.querySelector("[data-card-height]"));

   async function visibility(button,hidden){
    const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==="/studio"&&response.request().headers()["rsc"]==="1"&&!response.request().headers()["next-router-prefetch"]);refreshed.catch(()=>{});
    const reply=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/store/product"&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="visibility");
    await button.focus();await page.keyboard.press("Enter");
    const response=await reply,data=await response.json();
    if(response.request().postDataJSON()?.id!==createdId||!response.ok()||data.ok!==true||!data.product||data.product.id!==createdId||Boolean(data.product.hidden)!==hidden)throw Error("Local visibility refused "+JSON.stringify({status:response.status(),data}));
    const refresh=await refreshed;if(!refresh.ok()||(await completedResponse(page,refresh)).error)throw Error("Visibility RSC refresh failed");
    const flight=(await completedResponse(page,refresh)).text;const savedAt=flight.indexOf('"id":"'+data.product.id+'"');console.log("PRODUCT_VISIBILITY_RESPONSE:"+JSON.stringify({engine,width,mode,hidden,url:refresh.url(),productFragment:savedAt<0?"not found":flight.slice(savedAt,savedAt+1600)}));
    await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
    console.log("PRODUCT_VISIBILITY_RENDER:"+JSON.stringify({engine,width,mode,hidden,buttons:await row.getByRole("button").allTextContents()}));
   }
   if(await row.getByRole("button",{name:"Unpublish",exact:true}).count()){
    await visibility(row.getByRole("button",{name:"Unpublish",exact:true}),true);expectedWrites++;
    await row.getByRole("button",{name:"Publish it",exact:true}).waitFor();
    await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   }
   await visibility(row.getByRole("button",{name:"Publish it",exact:true}),false);expectedWrites++;
   await row.getByRole("button",{name:"Unpublish",exact:true}).waitFor();
   await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   await page.goto(origin+"/@activationonboarding",{waitUntil:"networkidle"});await restoreDarkAfterNavigation();
   if(!await page.getByText(title,{exact:true}).count()){
    const next=page.locator('a[rel="next"]');if(await next.count()!==1)throw Error("Published product absent and no unique next storefront page");
    await next.click();await page.waitForURL(url=>url.searchParams.get("page")==="2");await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   }
   try{await page.getByText(title,{exact:true}).waitFor({state:"attached"});}catch(error){console.error("PRODUCT_STOREFRONT_DIAGNOSTIC:"+JSON.stringify({engine,width,mode,createdId,url:page.url(),titleCount:await page.getByText(title,{exact:true}).count(),pager:await page.locator(".st-pager").allTextContents()}));throw error;}
   // The visit waits for a pause in the buyer's input before its check runs (lib/quiet-moment.ts): waited for here, never assumed.
   for(let wait=0;wait<100&&interceptedVisits<expectedVisits;wait++)await page.waitForTimeout(100);
   if(writes||foreign||localProductWrites!==expectedWrites||interceptedVisits!==expectedVisits)throw Error("Unexpected operation count "+JSON.stringify({writes,foreign,localProductWrites,expectedWrites,interceptedVisits,expectedVisits,blockedWrites}));
   console.log("PRODUCT_ACTION_PROOF:"+JSON.stringify({engine,width,mode,title,localProductWrites,expectedWrites,interceptedVisits,createdAndReloaded:true,explicitPublication:true,storefrontVisible:true,scope:"Disposable local fixture only; no checkout, email, delivery or real account."}));
  }catch(error){failed++;console.error("PRODUCT_MATRIX_FAILURE:"+JSON.stringify({engine,path,width,mode,error:String(error)}));}
  finally{cases++;await context.close();}
 }
 console.log("PRODUCT_MATRIX_OPEN_GAPS:"+JSON.stringify(gaps));
 console.log("PRODUCT_MATRIX_SUMMARY:"+JSON.stringify({engine,cases,failed,gaps:gaps.length,scope:"Product form and actual disposable local creation/reload/manual visibility/storefront proof only; no checkout or buyer-area action proof. Synthetic emulation; reflow320 is not real browser400% zoom. No real-device, assistive-user or whole-product AAA certification."}));
}finally{if(browser)await browser.close();app.kill("SIGTERM");await services.close();}
process.exitCode=failed?1:0;
