import "./orders-list-actions.mjs";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {build} from "esbuild";
import {startServices} from "./services.mjs";
import {prepareReviewedMailApp} from "./reviewed-mail-app.mjs";
import {resolve,join} from "node:path";
import {createServer} from "node:http";
const root=resolve(".");
const require=createRequire(join(root,"package.json"));
const engine=process.env.E2E_BROWSER??"chromium";
if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unsupported engine "+engine);
const driver=require("playwright-core")[engine];
const axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const port=3196,origin="http://localhost:"+port;
const here=join(root,"tests/e2e"),FAKE="http://127.0.0.1:4496";
const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  STRIPE_SECRET_KEY:"sk_test_local_only_a_stand_in_0000",
  ADS_API_BASE:FAKE,
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_READ_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_"+"x".repeat(30),
  ANTHROPIC_API_BASE: FAKE,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
  STRIPE_CONNECT_API_BASE: FAKE,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};


const services=await startServices(4496);
const folder=mkdtempSync(join(tmpdir(),"mm-buyer-matrix-")),seedFile=join(folder,"seed.cjs");
let ids;
try{
 await build({entryPoints:[join(here,"seed.ts")],bundle:true,platform:"node",format:"cjs",outfile:seedFile,logLevel:"error",alias:{"@":root}});
 const seeded=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[seedFile],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let data="";child.stdout.on("data",chunk=>data+=chunk);child.on("error",reject);child.on("close",code=>code===0?resolve(data):reject(Error("Synthetic buyer seed failed")));});
 ids=JSON.parse(seeded.trim().split("\n").at(-1)).ids;
 if(!ids?.["Weeknight Dinners"])throw Error("Synthetic product missing");
}catch(error){await services.close();throw error;}finally{rmSync(folder,{recursive:true,force:true});}
let app,reviewedApp,output="";
let browser,cases=0,audits=0,failed=0,libraryLink=null;const gaps=[];
const redact=value=>String(value).replace(/token=[^&\s"']+/g,"token=redacted");
// 2.5.5 Target Size (Enhanced, AAA): every control a buyer presses on the checkout's own pages is at least 44 by 44 CSS px.
// A link inside a sentence is the criterion's inline exception; a box counts with its label, which presses it too.
const targetsUnder44=(page,scope="body")=>page.evaluate(scope=>{
 const out=[],shown=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&!n.closest("[hidden],[inert],.sr-only");};
 for(const n of document.querySelector(scope)?.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button]")??[]){
  const label=n.matches("input")?(n.labels?.[0]??n.closest("label")):null;
  if(!shown(n)&&!(label&&shown(label)))continue;
  if(n.tagName==="A"&&getComputedStyle(n).display==="inline"){const p=n.parentElement;if(p&&(p.textContent||"").trim().length>(n.textContent||"").trim().length+3)continue;}
  const r=n.getBoundingClientRect(),l=label?label.getBoundingClientRect():r,width=Math.max(r.width,l.width),height=Math.max(r.height,l.height);
  if(width<43.5||height<43.5)out.push({tag:n.tagName,name:(n.getAttribute("aria-label")||n.textContent||"").trim().slice(0,60),width:Math.round(width),height:Math.round(height)});
 }
 return out;
},scope);
const localLink=value=>String(value).replace("https://marktmorgen.com",origin);
try{
 reviewedApp=await prepareReviewedMailApp(root,env);
 app=spawn(process.execPath,[join(reviewedApp.root,"node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(port)],{cwd:reviewedApp.root,env,stdio:["ignore","pipe","pipe"]});
 for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>output=(output+chunk).slice(-6000));
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error("Local app exited");try{up=(await fetch(origin,{signal:AbortSignal.timeout(5_000)})).ok;}catch{}if(up)break;await new Promise(r=>setTimeout(r,500));}
 if(!up)throw Error("Local app did not start");
 browser=await driver.launch();console.log("BUYER_MATRIX_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 for(const width of [320,390,768,1280,1920])for(const mode of ["baseline","text-spacing","reduced-motion","forced-colors","reflow-320",...(process.env.AX2_PUBLIC_STANDARD==="true"?["dark"]:[])]){
  const index=cases+1,viewportWidth=mode==="reflow-320"?320:width;
  const context=await browser.newContext({...(mode==="dark"?{colorScheme:"dark"}:{}),viewport:{width:viewportWidth,height:900},serviceWorkers:"block",reducedMotion:mode==="reduced-motion"?"reduce":"no-preference",forcedColors:mode==="forced-colors"?"active":"none",extraHTTPHeaders:{"x-forwarded-for":"192.0.2."+index,"sec-gpc":"1"}});
  let phase="open",foreign=0,storeRouteReads=0;const storeRouteReadPages={},mutations=[],errors=[],beforeEmails=services.emails().length,beforeCheckouts=services.checkouts().length;let libraryRequested=false;
  try{
   await context.addInitScript(()=>{Object.defineProperty(navigator,"globalPrivacyControl",{value:true,configurable:true});});
   if(mode==="text-spacing")await context.addInitScript(()=>document.addEventListener("DOMContentLoaded",()=>{const style=document.createElement("style");style.textContent="*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";document.head.append(style);},{once:true}));
   const page=await context.newPage();
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
   page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(60000);
   page.on("pageerror",error=>errors.push(redact(error)));
   await context.route("**/*",route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin&&url.origin!==FAKE){foreign++;return route.abort();}
    if(request.method()==="GET"&&url.origin===origin&&url.pathname==="/@localshop"&&url.searchParams.has("_rsc")){
     storeRouteReads++;const source=new URL(request.headers()["referer"]??page.url()).pathname;
     storeRouteReadPages[source]=(storeRouteReadPages[source]??0)+1;
    }
    if(url.origin===origin&&request.method()==="POST"&&url.pathname==="/api/store/hit")return route.fulfill({status:204,body:""});
    if(!["GET","HEAD"].includes(request.method())){
     mutations.push({method:request.method(),path:url.pathname});
     if(url.origin!==origin||request.method()!=="POST"||!["/api/store/checkout","/api/library"].includes(url.pathname))return route.abort();
    }
    return route.continue();
   });
   async function audit(state){
    await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
    await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo({top:0,left:0,behavior:"instant"});});
    await page.waitForFunction(()=>scrollX===0&&scrollY===0);
    if(mode==="dark"&&!await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches))throw Error("Dark color-scheme request not honored");
   await page.addScriptTag({content:axe});
    const result=await page.evaluate(async()=>{
     const root=document.documentElement,result=await window.axe.run(document,{rules:{"color-contrast-enhanced":{enabled:true}}});
     return {scroll:root.scrollWidth,client:root.clientWidth,overflow:root.scrollWidth>root.clientWidth?[...document.querySelectorAll("main *")].filter(n=>{const r=n.getBoundingClientRect();return r.width>1&&r.height>1&&r.right>root.clientWidth+1;}).slice(0,12).map(n=>({tag:n.tagName,classes:typeof n.className==="string"?n.className:"",width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right,client:n.clientWidth,scroll:n.scrollWidth})):[],violations:result.violations.map(r=>({id:r.id,targets:r.nodes.map(n=>n.target)})),incomplete:result.incomplete.map(r=>({id:r.id,targets:r.nodes.map(n=>n.target)}))};
    });
    audits++;console.log("BUYER_MATRIX_AUDIT:"+JSON.stringify({engine,width,mode,state,...result}));
    if(result.scroll>result.client||result.violations.length)throw Error("Accessibility/overflow failure at "+state);
    if(["product-checkout-form","simulated-paid-receipt"].includes(state)){const small=await targetsUnder44(page);if(small.length)throw Error("Target under 44 by 44 px at "+state+" "+JSON.stringify(small));}
    if(result.incomplete.length)gaps.push({width,mode,state,manualReview:result.incomplete});
   }
   // Sent back without the box (app/api/store/checkout, consent=needed): the reason is written beside it and tied to it, the box is
   // marked invalid and takes the focus, the reason is announced from a live region filled after the page is drawn (never an alert
   // present from the start), and checking the box by its label clears the mark and the reason.
   await page.goto(origin+"/@localshop/p/"+ids["Weeknight Dinners"]+"?consent=needed#buy",{waitUntil:"networkidle"});await restoreDarkAfterNavigation();
   const refusedBox=page.locator('#buy form[data-checkout] input[name="dc"]').first();
   await page.waitForTimeout(400);
   const refusedState=await refusedBox.evaluate(n=>{const ids=(n.getAttribute("aria-describedby")||"").split(" ");const error=document.getElementById(ids[0]);const wrap=n.closest("[data-digital-consent]");const live=wrap&&wrap.querySelector('[aria-live="assertive"]');return {invalid:n.getAttribute("aria-invalid"),error:error?error.textContent.trim():"",focused:document.activeElement===n,live:live?live.textContent.trim():"",alertAtLoad:Boolean(wrap&&wrap.querySelector('[role="alert"]'))};});
   if(refusedState.invalid!=="true"||!refusedState.error||!refusedState.focused||refusedState.live!==refusedState.error||refusedState.alertAtLoad)throw Error("Refused consent box state wrong "+JSON.stringify(refusedState));
   await page.locator('#buy form[data-checkout] label:has(> input[name="dc"])').first().click();
   const cleared=await refusedBox.evaluate(n=>({checked:n.checked,invalid:n.getAttribute("aria-invalid"),described:n.getAttribute("aria-describedby")}));
   if(!cleared.checked||cleared.invalid!==null||/-error/.test(cleared.described||""))throw Error("Checking the box did not clear the error "+JSON.stringify(cleared));
   const response=await page.goto(origin+"/@localshop/p/"+ids["Weeknight Dinners"],{waitUntil:"networkidle"});await restoreDarkAfterNavigation();
   if(response.status()!==200)throw Error("Synthetic product page failed");
   await audit("product-checkout-form");
   const buyForm=page.locator('#buy form[data-checkout]').first();
   const extras=buyForm.locator('input[name="bump"]');
   if(await extras.evaluateAll(nodes=>nodes.some(n=>n.checked)))throw Error("An extra was selected for the buyer");
   if(mode==="baseline"){await page.keyboard.press("Tab");if(!await page.evaluate(()=>document.activeElement!==document.body))throw Error("Native keyboard focus missing");}
   // The box to start during the cancellation period (lib/digital-consent.ts): a real, labelled, required checkbox, never checked for the buyer.
   const consent=buyForm.locator('input[name="dc"]');
   if(await consent.count()!==1)throw Error("Immediate-access consent box missing");
   const box=await consent.evaluate(n=>({checked:n.checked,required:n.required,type:n.type,labelled:Boolean(n.labels&&n.labels.length&&n.labels[0].innerText.trim()),described:Boolean(n.getAttribute("aria-describedby")&&document.getElementById(n.getAttribute("aria-describedby").split(" ")[0])),height:n.labels&&n.labels[0]?n.labels[0].getBoundingClientRect().height:0}));
   if(box.checked||!box.required||box.type!=="checkbox"||!box.labelled||!box.described||box.height<44)throw Error("Consent box is not an unchecked, required, labelled, described 44px target "+JSON.stringify(box));
   // Unchecked, the browser itself stops the form: nothing is sent.
   phase="consent-missing";await buyForm.locator('button[type="submit"]').focus();await page.keyboard.press("Enter");await page.waitForTimeout(400);
   if(mutations.some(m=>m.path==="/api/store/checkout"))throw Error("Checkout was sent without the consent box");
   if(!await consent.evaluate(n=>!n.validity.valid))throw Error("The unchecked box is not reported invalid");
   await consent.focus();await page.keyboard.press("Space");
   if(!await consent.isChecked())throw Error("The consent box cannot be checked with the keyboard");
   phase="checkout";const checkout=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/store/checkout"&&r.request().method()==="POST");
   await buyForm.locator('button[type="submit"]').focus();await page.keyboard.press("Enter");await checkout;
   await page.waitForURL(url=>url.pathname==="/@localshop/thanks"&&url.searchParams.has("session_id"));await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   const created=services.checkouts().slice(beforeCheckouts);
   if(created.length!==1||created[0].amount_total!==1900||created[0].metadata.product!==ids["Weeknight Dinners"])throw Error("Simulated checkout amount/product mismatch");
   if(!/^yes:\d{4}-\d{2}-\d{2}\.\d{1,3}:d:\d{10}$/.test(String(created[0].metadata.dc??"")))throw Error("The checked box was not kept on the simulated order");
   phase="receipt";await audit("simulated-paid-receipt");
   if(!(await page.locator("main").innerText()).includes("Weeknight Dinners"))throw Error("Receipt did not hand over selected product");
   phase="library-request";await page.goto(origin+"/library",{waitUntil:"networkidle"});await restoreDarkAfterNavigation();await audit("buyer-library-request");
   if(!libraryLink){
    const beforeLibrary=services.emails().length;
    await page.locator("#library-email").fill("buyer@example.com");
    await page.locator('form[action="/api/library"] button[type="submit"]').focus();
    await page.keyboard.press("Enter");await page.waitForURL(url=>url.pathname==="/library"&&url.searchParams.get("status")==="sent");
    const mail=services.emails().slice(beforeLibrary).filter(m=>[m.to].flat().includes("buyer@example.com")&&m.subject==="Your purchases on Marktmorgen");
    if(mail.length!==1)throw Error("Captured synthetic library email missing");
    const match=String(mail[0].text??"").match(/https?:\/\/\S+\/library\?token=[0-9a-f]{64}/);
    if(!match)throw Error("Captured library link missing");
    libraryLink=localLink(match[0]);if(new URL(libraryLink).origin!==origin)throw Error("Library link escaped local origin");
    libraryRequested=true;
   }
   phase="library-shelf";await page.goto(libraryLink,{waitUntil:"networkidle"});await restoreDarkAfterNavigation();await audit("authenticated-buyer-library");
   const shelf=page.locator("[data-library-store='localshop']");if(await shelf.count()!==1)throw Error("Purchased store missing from buyer library");
   const purchases=await shelf.getByRole("link",{name:"Open your purchases",exact:true}).getAttribute("href");
   const orderLink=localLink(purchases??"");if(new URL(orderLink,origin).origin!==origin)throw Error("Orders escaped synthetic origin");
   phase="buyer-orders";await page.goto(new URL(orderLink,origin).href,{waitUntil:"networkidle"});await restoreDarkAfterNavigation();await audit("buyer-orders");
   if(!(await page.locator("main").innerText()).includes("Weeknight Dinners"))throw Error("Purchased product missing in buyer area");
   if(storeRouteReads!==0)throw Error("Store-home route was fetched before a buyer chose to visit it: "+JSON.stringify({count:storeRouteReads,pages:storeRouteReadPages}));
   const expected=libraryRequested?2:1;
   if(foreign||errors.length||mutations.length!==expected||mutations.filter(m=>m.path==="/api/store/checkout").length!==1)throw Error("Unexpected operation/page error "+JSON.stringify({foreign,errors,mutations}));
   gaps.push({width,mode,reason:"Local simulated paid return only; Stripe-hosted UI, real card/wallet, external delivery, actual400%zoom, physical devices/AT and manual sticky-scroll not proven. Library token from one real local fake-inbox request per engine is reused for remaining viewport cases."});
   console.log("BUYER_ACTION_PROOF:"+JSON.stringify({engine,width,mode,simulatedCheckout:true,amountCents:created[0].amount_total,productMatched:true,extrasOptedIn:false,capturedLocalEmails:services.emails().length-beforeEmails,libraryRequestThisCase:libraryRequested,buyerLibrary:true,buyerOrders:true,storeRouteReads,foreign,mutations}));
  }catch(error){failed++;console.error("BUYER_MATRIX_FAILURE:"+JSON.stringify({engine,width,mode,phase,error:redact(error)}));}
  finally{cases++;await context.close();}
 }
 // 656 [WG16]: a store with nothing on it (tests/e2e/seed.ts, freshshop) shows the empty state: a heading and one
 // sentence, no dead button, nothing blank, axe AAA. Its blog, with no posts, has no page at all (404), never a blank one.
 // Baseline at 320 and 1280 px only; its time is printed so the cost it adds to this job is measured, never taken as zero.
 const emptyStarted=Date.now();let emptyCases=0;
 for(const width of [320,1280]){
  const blog=await fetch(origin+"/@freshshop/blog",{headers:{"x-forwarded-for":"198.51.100."+(40+width%7)},signal:AbortSignal.timeout(30_000)});
  if(blog.status!==404){failed++;console.error("EMPTY_STATE_FAILURE:"+JSON.stringify({engine,width,path:"/@freshshop/blog",error:"A store with no posts has a blog page: HTTP "+blog.status}));}
 }
 for(const width of [320,1280])for(const path of ["/@freshshop"]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:"block",extraHTTPHeaders:{"x-forwarded-for":"198.51.100."+(10+emptyCases)}});
  try{
   const page=await context.newPage();const errors=[];page.on("pageerror",error=>errors.push(redact(error)));
   await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin!==origin&&url.origin!==FAKE)return route.abort();if(url.pathname==="/api/store/hit")return route.fulfill({status:204,body:""});if(!["GET","HEAD"].includes(route.request().method()))return route.abort();return route.continue();});
   const response=await page.goto(origin+path,{waitUntil:"networkidle",timeout:60000});
   if(response?.status()!==200)throw Error("HTTP "+response?.status());
   const empty=await page.evaluate(()=>[...document.querySelectorAll("[data-empty-state]")].map(node=>({heading:node.querySelector("h2")?.textContent?.trim()??"",sentence:node.querySelector("p")?.textContent?.trim()??"",actions:[...node.querySelectorAll("a,button")].map(a=>({tag:a.tagName,href:a.getAttribute("href")})),visible:node.getBoundingClientRect().height>0})));
   if(empty.length!==1||!empty[0].heading||!empty[0].sentence||!empty[0].visible)throw Error("Empty state missing or blank "+JSON.stringify(empty));
   if(empty[0].actions.some(a=>a.tag!=="A"||!/^\/(?!\/)/.test(a.href??"")))throw Error("Dead or foreign action in the empty state "+JSON.stringify(empty[0].actions));
   await page.addScriptTag({content:axe});
   const result=await page.evaluate(async()=>{const root=document.documentElement,run=await window.axe.run(document,{rules:{"color-contrast-enhanced":{enabled:true}}});return {scroll:root.scrollWidth,client:root.clientWidth,violations:run.violations.map(v=>({id:v.id,nodes:v.nodes.length})),incomplete:run.incomplete.map(v=>v.id)};});
   audits++;console.log("EMPTY_STATE_AUDIT:"+JSON.stringify({engine,width,path,empty:empty[0],...result}));
   if(result.scroll>result.client||result.violations.length||errors.length)throw Error("Empty state accessibility/overflow/page failure "+JSON.stringify({violations:result.violations,errors}));
   if(result.incomplete.length)gaps.push({width,mode:"baseline",state:"empty "+path,manualReview:result.incomplete});
  }catch(error){failed++;console.error("EMPTY_STATE_FAILURE:"+JSON.stringify({engine,width,path,error:redact(error)}));}
  finally{emptyCases++;cases++;await context.close();}
 }
 console.log("EMPTY_STATE_COST:"+JSON.stringify({engine,cases:emptyCases,milliseconds:Date.now()-emptyStarted}));
 // The cart (components/store-cart.tsx), the checkout for several products at once, by keyboard only: every control in it
 // 44 by 44 px (2.5.5); removing a product keeps the focus in the cart (2.4.3); Escape and Close shut it and give the focus
 // back to its button (2.4.3, 2.1.1); and moving the focus out of it shuts it, so the open panel never covers the control
 // that has the focus (2.4.11, 2.4.12). Nothing is written: the cart lives in this browser and its reads are GET requests.
 // Baseline at 320 and 1280 px only; its time is printed so the cost it adds to this job is measured, never taken as zero.
 const cartStarted=Date.now();let cartCases=0;
 for(const width of [320,1280]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:"block",extraHTTPHeaders:{"x-forwarded-for":"198.51.100."+(60+cartCases)}});
  try{
   const page=await context.newPage();const errors=[];page.on("pageerror",error=>errors.push(redact(error)));
   await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin!==origin&&url.origin!==FAKE)return route.abort();if(url.pathname==="/api/store/hit")return route.fulfill({status:204,body:""});if(!["GET","HEAD"].includes(route.request().method()))return route.abort();return route.continue();});
   const response=await page.goto(origin+"/@localshop",{waitUntil:"networkidle",timeout:60000});
   if(response?.status()!==200)throw Error("HTTP "+response?.status());
   const adds=page.locator("main button[aria-pressed]");
   for(const n of [0,1]){await adds.nth(n).focus();await page.keyboard.press("Enter");}
   const opener=page.locator("#cart .st-cart-open"),panel=page.locator("#cart .st-cart-panel"),lines=panel.locator("li");
   const openByKeyboard=async()=>{await opener.focus();await page.keyboard.press("Enter");await panel.waitFor();};
   const focus=()=>page.evaluate(()=>{const a=document.activeElement;return {inCart:Boolean(a?.closest("#cart")),inPanel:Boolean(a?.closest(".st-cart-panel")),opener:Boolean(a?.matches(".st-cart-open")),tag:a?.tagName??"",name:(a?.getAttribute("aria-label")||a?.textContent||"").trim().slice(0,60)};});
   await openByKeyboard();await lines.nth(1).waitFor({timeout:15_000});await panel.locator("form[data-checkout]").waitFor({timeout:15_000});
   const small=await targetsUnder44(page,"#cart .st-cart-panel");
   if(small.length)throw Error("Cart target under 44 by 44 px "+JSON.stringify(small));
   await page.addScriptTag({content:axe});
   const result=await page.evaluate(async()=>{const run=await window.axe.run(document.querySelector("#cart"),{rules:{"color-contrast-enhanced":{enabled:true}}});return run.violations.map(v=>({id:v.id,nodes:v.nodes.length}));});
   if(result.length)throw Error("Cart axe violations "+JSON.stringify(result));
   // Removing the first product by keyboard: the focus stays in the cart, on the next product's button.
   await lines.first().locator("button").focus();await page.keyboard.press("Enter");
   await page.waitForFunction(()=>document.querySelectorAll("#cart .st-cart-panel li").length===1);
   const afterRemove=await focus();
   if(!afterRemove.inPanel)throw Error("Removing a product lost the focus "+JSON.stringify(afterRemove));
   // Escape shuts it, and the focus is on its button again.
   await page.keyboard.press("Escape");
   if(await panel.count()!==0)throw Error("Escape did not shut the cart");
   const afterEscape=await focus();if(!afterEscape.opener)throw Error("Escape did not give the focus back to the cart's button "+JSON.stringify(afterEscape));
   // Close, pressed by keyboard, does the same.
   await openByKeyboard();await panel.getByRole("button",{name:"Close",exact:true}).focus();await page.keyboard.press("Enter");
   if(await panel.count()!==0)throw Error("Close did not shut the cart");
   const afterClose=await focus();if(!afterClose.opener)throw Error("Close did not give the focus back to the cart's button "+JSON.stringify(afterClose));
   // Shift+Tab from its button moves the focus to the page: the panel shuts, so nothing covers what has the focus.
   await openByKeyboard();await opener.focus();await page.keyboard.press("Shift+Tab");
   const behind=await focus();
   if(behind.inCart||await panel.count()!==0)throw Error("The open cart stayed over the page while the focus left it "+JSON.stringify(behind));
   // Opened, a click on an empty part of the page (the focus leaves for the page itself), then Tab or a screen reader's own
   // move puts it on a link under the panel: the panel shuts as well.
   await openByKeyboard();await page.evaluate(()=>document.activeElement?.blur?.());await page.locator("main a[href]").first().focus();
   if(await panel.count()!==0)throw Error("The open cart stayed over the page while the focus was put under it");
   // The last product removed: the cart says it is empty and keeps the focus; Close gives it back to the cart's button.
   await openByKeyboard();await lines.first().waitFor({timeout:15_000});await lines.first().locator("button").focus();await page.keyboard.press("Enter");
   await page.waitForFunction(()=>document.querySelectorAll("#cart .st-cart-panel li").length===0);
   const emptied=await focus();if(!emptied.inPanel)throw Error("Emptying the cart lost the focus "+JSON.stringify(emptied));
   await page.keyboard.press("Escape");const afterEmpty=await focus();
   if(!afterEmpty.opener)throw Error("An emptied cart lost the focus on closing "+JSON.stringify(afterEmpty));
   if(errors.length)throw Error("Page errors "+JSON.stringify(errors));
   audits++;console.log("CART_KEYBOARD_PROOF:"+JSON.stringify({engine,width,afterRemove,afterEscape,afterClose,behind,emptied,afterEmpty}));
  }catch(error){failed++;console.error("CART_KEYBOARD_FAILURE:"+JSON.stringify({engine,width,error:redact(error)}));}
  finally{cartCases++;cases++;await context.close();}
 }
 console.log("CART_KEYBOARD_COST:"+JSON.stringify({engine,cases:cartCases,milliseconds:Date.now()-cartStarted}));
 // The card a creator puts on their own site (app/embed/[handle]/[product]), framed as it is pasted and as the checkout
 // script's overlay opens it: one main landmark around it (1.3.1, AX274), axe AAA. Then the overlay itself, opened by the
 // script (lib/embed-sdk.ts) from a page on another local origin: the focus goes into the card, Tab never reaches the page
 // under the dialog (2.4.3, 2.4.11), its close button shows a ring of its own (2.4.13), and closing gives the focus back to
 // the link. The overlay's focus moves are checked in Chromium only: what Tab does around a cross-origin frame differs by
 // engine, and Firefox and WebKit were not run where this was written; that gap is printed, never counted as a pass.
 const embedStarted=Date.now();let embedCases=0;
 const sdkFolder=mkdtempSync(join(tmpdir(),"mm-buyer-sdk-")),sdkFile=join(sdkFolder,"sdk.cjs");
 await build({entryPoints:[join(root,"lib/embed-sdk.ts")],bundle:true,platform:"node",format:"cjs",outfile:sdkFile,logLevel:"error",alias:{"@":root}});
 const sdk=require(sdkFile);rmSync(sdkFolder,{recursive:true,force:true});
 const hostPort=4598,host="http://127.0.0.1:"+hostPort,card=origin+"/embed/localshop/"+ids["Weeknight Dinners"];
 const hostPage=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A creator's own site</title></head><body><main><h1>Dinners at home</h1><p><a id="buy" data-mm="overlay" href="${card}">Buy Weeknight Dinners</a></p><p><a id="under" href="#more">More recipes</a></p></main>${sdk.loaderTag(origin)}</body></html>`;
 const hostServer=createServer((req,res)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(hostPage);});
 await new Promise(resolve=>hostServer.listen(hostPort,"127.0.0.1",resolve));
 try{
  for(const width of [390,1280]){
   const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:"block",extraHTTPHeaders:{"x-forwarded-for":"198.51.100."+(80+embedCases)}});
   try{
    const page=await context.newPage();const errors=[];page.on("pageerror",error=>errors.push(redact(error)));
    await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin!==origin&&url.origin!==FAKE&&url.origin!==host)return route.abort();if(url.pathname==="/api/store/hit")return route.fulfill({status:204,body:""});if(!["GET","HEAD"].includes(route.request().method()))return route.abort();return route.continue();});
    for(const query of ["","?mm=overlay"]){
     const response=await page.goto(card+query,{waitUntil:"networkidle",timeout:60000});
     if(response?.status()!==200)throw Error("Card HTTP "+response?.status());
     await page.addScriptTag({content:axe});
     const result=await page.evaluate(async()=>{const run=await window.axe.run(document,{rules:{"color-contrast-enhanced":{enabled:true}}});return {mains:[...document.querySelectorAll("main")].map(m=>m.id),violations:run.violations.map(v=>({id:v.id,nodes:v.nodes.length}))};});
     if(result.mains.length!==1||result.mains[0]!=="content"||result.violations.length)throw Error("Card "+(query||"pasted")+" landmark/axe failure "+JSON.stringify(result));
    }
    if(engine==="chromium"){
     await page.goto(host+"/",{waitUntil:"networkidle",timeout:60000});
     await page.locator("#buy").focus();await page.keyboard.press("Enter");
     const frameNode=await page.waitForSelector("[role=dialog] iframe");const frame=await frameNode.contentFrame();
     await frame.waitForLoadState("networkidle");
     await frame.waitForFunction(()=>document.hasFocus(),null,{timeout:10_000}).catch(()=>{});
     const inCard=await frame.evaluate(()=>document.hasFocus());
     if(!inCard)throw Error("The overlay did not put the focus in the card");
     const trail=[];
     for(let n=0;n<10;n++){await page.keyboard.press("Tab");trail.push(await page.evaluate(()=>{const a=document.activeElement;return a===document.body?"page edge":a?.closest("[role=dialog]")?"dialog "+a.tagName:"UNDER "+(a?.id||a?.tagName);}));}
     if(trail.some(step=>step.startsWith("UNDER")))throw Error("Tab reached the page under the dialog "+JSON.stringify(trail));
     const close=page.locator("[role=dialog] > button");await close.focus();
     const ring=await close.evaluate(n=>getComputedStyle(n).boxShadow);
     if(!/3px.*6px/.test(ring))throw Error("The close button shows no ring of its own "+ring);
     await page.keyboard.press("Enter");
     if(await page.locator("[role=dialog]").count()!==0)throw Error("Close did not shut the overlay");
     if(await page.evaluate(()=>document.activeElement?.id)!=="buy")throw Error("Closing did not give the focus back to the link");
     console.log("OVERLAY_KEYBOARD_PROOF:"+JSON.stringify({engine,width,inCard,trail,ring}));
    }else gaps.push({width,mode:"baseline",state:"embed overlay",reason:"Overlay focus moves around a cross-origin frame checked in Chromium only."});
    if(errors.length)throw Error("Page errors "+JSON.stringify(errors));
    audits++;
   }catch(error){failed++;console.error("EMBED_FAILURE:"+JSON.stringify({engine,width,error:redact(error)}));}
   finally{embedCases++;cases++;await context.close();}
  }
 }finally{await new Promise(resolve=>hostServer.close(resolve));}
 console.log("EMBED_COST:"+JSON.stringify({engine,cases:embedCases,milliseconds:Date.now()-embedStarted}));
 console.log("BUYER_MATRIX_OPEN_GAPS:"+JSON.stringify(gaps));
 console.log("BUYER_MATRIX_SUMMARY:"+JSON.stringify({engine,cases,audits,failed,scope:"Real local app checkout against fake Stripe paid return; local captured inbox/library/orders. No real checkout/payment/provider/message/account or external download."}));
}finally{await browser?.close();if(app&&app.exitCode===null){const closed=new Promise(resolve=>app.once("exit",resolve));const forced=setTimeout(()=>app.kill("SIGKILL"),5_000);app.kill("SIGTERM");await closed;clearTimeout(forced);}await services.close();if(reviewedApp)await reviewedApp.cleanup();}
process.exitCode=failed?1:0;
