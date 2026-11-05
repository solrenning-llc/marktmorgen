import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {createServer} from "node:https";
import {request as httpRequest} from "node:http";
import {resolve,join} from "node:path";
import {startServices} from "./services.mjs";
import {prepareReviewedMailApp} from "./reviewed-mail-app.mjs";
const root=resolve("."),require=createRequire(join(root,"package.json"));
const engine=process.env.E2E_BROWSER??"chromium";
if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unsupported browser");
const driver=require("playwright-core")[engine],axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const port=3198,upstream="http://localhost:"+port,origin="https://localhost:3199",here=join(root,"tests/e2e"),FAKE="http://127.0.0.1:4498";
const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  VERCEL:"0",
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
if(!process.env.SIGNUP_TLS_KEY||!process.env.SIGNUP_TLS_CERT)throw Error("Disposable local TLS certificate required");
let proxyTrace=[];
const proxy=createServer({key:readFileSync(process.env.SIGNUP_TLS_KEY),cert:readFileSync(process.env.SIGNUP_TLS_CERT)},(incoming,outgoing)=>{
 const trace={method:incoming.method,path:new URL(incoming.url??"/",origin).pathname,received:true,response:false,finished:false};
 proxyTrace.push(trace);
 outgoing.once("finish",()=>{trace.finished=true;});
 const forwarded=httpRequest(upstream+incoming.url,{method:incoming.method,agent:false,headers:{...incoming.headers,connection:"close",host:"localhost:3199","x-forwarded-host":"localhost:3199","x-forwarded-proto":"https"}},response=>{
  trace.response=true;trace.status=response.statusCode??502;
  // Each synthetic case replaces its backing services. Do not retain a
  // fixture socket across that boundary or replay a mutating request.
  outgoing.writeHead(response.statusCode??502,{...response.headers,connection:"close"});response.pipe(outgoing);
 });
 forwarded.on("error",error=>{trace.error=error.code??error.name;if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
 incoming.on("aborted",()=>forwarded.destroy());
 incoming.pipe(forwarded);
});
let services=await startServices(4498);
let reviewedApp,app,output="";
let browser,cases=0,failed=0,audits=0;const gaps=[];
try{
 reviewedApp=await prepareReviewedMailApp(root,env);
 app=spawn(process.execPath,[join(reviewedApp.root,"node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(port)],{cwd:reviewedApp.root,env,stdio:["ignore","pipe","pipe"]});
 for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>output=(output+chunk).slice(-6000));
 await new Promise((resolve,reject)=>{proxy.once("error",reject);proxy.listen(3199,"localhost",resolve);});
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error("Local app exited");try{up=(await fetch(upstream,{signal:AbortSignal.timeout(5_000)})).ok;}catch{}if(up)break;await new Promise(r=>setTimeout(r,500));}
 if(!up)throw Error("Local app did not start");
 browser=await driver.launch();console.log("SIGNUP_MATRIX_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 for(const width of [320,390,768,1280,1920])for(const mode of ["baseline","text-spacing","reduced-motion","forced-colors","reflow-320",...(process.env.AX2_PUBLIC_STANDARD==="true"?["dark"]:[])]){
  // Each viewport/mode is a separate fresh deployment fixture. Reusing the
  // fake database would exhaust the real ten-store company-funded pool.
  // Keep that production ceiling intact; never seed paying stores or enlarge it.
  if(cases>0){await services.close();services=await startServices(4498);}
  proxyTrace=[];
  const index=cases+1,viewportWidth=mode==="reflow-320"?320:width;
  const context=await browser.newContext({...(mode==="dark"?{colorScheme:"dark"}:{}),ignoreHTTPSErrors:true,viewport:{width:viewportWidth,height:900},serviceWorkers:"block",reducedMotion:mode==="reduced-motion"?"reduce":"no-preference",forcedColors:mode==="forced-colors"?"active":"none",extraHTTPHeaders:{"x-forwarded-for":"192.0.2."+index,"Sec-GPC":"1"}});
  let page;let phase="open",foreign=0,interceptedVisits=0,localChallenges=0;const mutations=[],errors=[],network=[];const handle="matrix-"+engine[0]+"-"+index,storeName="Matrix "+engine+" "+index;const inbox="matrix-"+engine+"-"+index+"@example.test",before=services.emails().length;
  try{
   await context.addInitScript(()=>Object.defineProperty(navigator,"globalPrivacyControl",{configurable:true,get:()=>true}));
   if(mode==="text-spacing")await context.addInitScript(()=>document.addEventListener("DOMContentLoaded",()=>{const style=document.createElement("style");style.textContent="*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";document.head.append(style);},{once:true}));
   page=await context.newPage();
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
   page.on("request",request=>{network.push({event:"request",method:request.method(),path:new URL(request.url()).pathname});});
   page.on("response",response=>{network.push({event:"response",method:response.request().method(),path:new URL(response.url()).pathname,status:response.status()});});
   page.on("requestfailed",request=>{network.push({event:"failed",method:request.method(),path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
   page.on("pageerror",error=>errors.push(String(error).replace(/token=[^&\s"']+/g,"token=redacted")));
   let capturedClaim=null;
   await context.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){foreign++;return route.abort();}
    // withBotId rewrites this same-origin script to Vercel. Supply the
    // disposable provider locally before that rewrite can contact a service.
    // This is no production BotID verdict: the server already uses VERCEL=0.
    if(url.pathname==="/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js"){
     if(request.method()!=="GET"){mutations.push({method:request.method(),path:"unexpected-local-challenge"});return route.abort();}
     localChallenges++;
     return route.fulfill({status:200,contentType:"application/javascript",body:"window.V_C.push({b:0,d:0});"});
    }
    if(url.pathname==="/api/store/hit"&&request.method()==="POST"){
     const raw=request.postData(),input=raw?request.postDataJSON():null;
     const missingWebkit=engine==="webkit"&&!raw&&new URL(request.frame().url()).pathname==="/@"+handle;
     if(missingWebkit)gaps.push({width,mode,reason:"WebKit exposes no beacon body; only exact synthetic storefront stats are fulfilled204 without executing writes. Payload proof remains manual."});
     if(!missingWebkit&&(input?.h!==handle||input?.k!=="v")){mutations.push({method:request.method(),path:"unexpected-store-hit"});return route.abort();}
     interceptedVisits++;return route.fulfill({status:204});
    }
    if(!["GET","HEAD"].includes(request.method())){
     mutations.push({method:request.method(),path:url.pathname});
     if(request.method()!=="POST"||!["/api/auth/request","/api/auth/callback","/api/store/claim"].includes(url.pathname))return route.abort();
     if(url.pathname==="/api/store/claim"){
      // Capture the actual local server response before a native navigation
      // destroys Chromium's renderer-owned response-body handle.
      const response=await route.fetch({maxRedirects:0});
      capturedClaim={ok:response.ok(),body:await response.json(),requestBody:request.postDataJSON()};
      return route.fulfill({response});
     }
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
     return {scroll:root.scrollWidth,client:root.clientWidth,rules:result.passes.map(r=>r.id),
      violations:result.violations.map(r=>({id:r.id,targets:r.nodes.map(n=>n.target)})),
      incomplete:result.incomplete.map(r=>({id:r.id,targets:r.nodes.map(n=>n.target)}))};
    });
    audits++;console.log("SIGNUP_MATRIX_AUDIT:"+JSON.stringify({engine,width,mode,state,...result}));
    if(result.scroll>result.client||result.violations.length)throw Error("Accessibility/overflow failure at "+state);
    if(result.incomplete.length)gaps.push({width,mode,state,manualReview:result.incomplete});
   }
   const response=await page.goto(origin+"/signin",{waitUntil:"networkidle"});await restoreDarkAfterNavigation();if(response.status()!==200)throw Error("Signup document failed");
   if(await page.locator('input[type="password"],input[autocomplete^="cc-"]').count())throw Error("Unexpected password/card field");
   await audit("signup-form");
   if(mode==="baseline"){
    await page.keyboard.press("Tab");
    if(!await page.evaluate(()=>document.activeElement!==document.body))throw Error("Native keyboard focus missing");
   }
   const field=page.getByLabel("Your email",{exact:true});await field.fill(inbox);
   const reply=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/request"&&r.request().method()==="POST");
   phase="submit-access";await page.getByRole("button",{name:"Email me a link",exact:true}).focus();await page.keyboard.press("Enter");
   const requested=await reply;if(!requested.ok()||(await requested.json()).ok!==true)throw Error("Real local access request refused");
   await page.getByText("Check that inbox",{exact:true}).waitFor();
   const mail=services.emails().slice(before).filter(m=>[m.to].flat().includes(inbox));
   if(mail.length!==1)throw Error("Expected exactly one captured local sign-in email");
   const match=String(mail[0].text??"").match(/https?:\/\/[^\s<>"]+\/signin\/confirm\?token=[0-9a-f]{64}/);
   if(!match)throw Error("Captured confirmation link missing");
   const confirmation=new URL(match[0]);if(confirmation.origin!==origin)throw Error("Confirmation escaped synthetic origin");
   phase="confirmation";await page.goto(confirmation.href,{waitUntil:"networkidle"});await restoreDarkAfterNavigation();
   if((await context.cookies()).some(c=>c.name==="nl_session"))throw Error("Reading confirmation spent token or opened session");
   await audit("confirmation-before-tap");
   const signed=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/callback"&&r.request().method()==="POST");
   await page.getByRole("button",{name:"Log me in",exact:true}).focus();await page.keyboard.press("Enter");
   const callback=await signed;if(callback.status()!==303)throw Error("Confirmation did not redirect safely");
   await page.waitForURL(url=>url.pathname==="/studio");await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   if(!(await context.cookies()).some(c=>c.name==="nl_session"&&c.secure&&c.httpOnly&&c.sameSite==="Lax"))throw Error("Local authenticated session missing");
   phase="empty-studio";await audit("authenticated-first-setup");
   phase="claim-first-store";
   await page.getByLabel("Your address",{exact:true}).fill(handle);
   await page.getByLabel("Store name",{exact:true}).fill(storeName);
   await page.getByLabel("One line about it",{exact:false}).fill("Disposable local accessibility fixture.");
   const claim=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/store/claim"&&r.request().method()==="POST");
   await page.getByRole("button",{name:"Create my store",exact:true}).focus();await page.keyboard.press("Enter");
   const claimed=await claim;
   if(!capturedClaim)throw Error("Actual local claim response was not captured");
   const claimBody=capturedClaim.requestBody,created=capturedClaim.body;
   if(!claimed.ok()||!capturedClaim.ok||created.ok!==true||created.handle!==handle||typeof created.store!=="string"||!/^[0-9a-f]{32}$/.test(created.store)||claimBody.handle!==handle||claimBody.name!==storeName||claimBody.another!==false)throw Error("Initial local store claim refused or mismatched");
   await page.getByRole("heading",{name:"Your store",exact:true}).waitFor();
   if(await page.getByLabel("Your address",{exact:true}).count())throw Error("Initial setup did not refresh into created store");
   phase="created-studio";
   if(new URL(page.url()).searchParams.get("store")!==created.store)throw Error("Created studio must pin the returned persistent store ID");
   if((await page.title())!=="Your account — Marktmorgen")throw Error("Created studio must immediately have its document title");
   await audit("created-first-store-studio");
   const publicLink=page.locator('header a[href="/@'+handle+'"]');
   if(await publicLink.count()!==1)throw Error("Actual first-store link missing or ambiguous");
   await publicLink.focus();await page.keyboard.press("Enter");
   await page.waitForURL(url=>url.pathname==="/@"+handle);await page.waitForLoadState("networkidle");await restoreDarkAfterNavigation();
   // An owner-only preview is insufficient: discard the browser session and
   // reload the actual newly claimed address as an anonymous visitor.
   await context.clearCookies();
   phase="anonymous-first-store";const anonymousNetworkStart=network.length;const publicReply=await page.reload({waitUntil:"networkidle"});
   if(publicReply?.status()!==200)throw Error("New store is not publicly available");
   if((await context.cookies()).some(c=>c.name==="nl_session"))throw Error("Public proof retained creator session");
   await page.getByRole("heading",{name:storeName,exact:true}).waitFor();
   await audit("anonymous-first-store-after-reload");
   const badge=page.locator('a.st-footer-link[href="/"]');
   if(await badge.count()!==1)throw Error("New store must preserve its Marktmorgen badge link");
   const unsolicited=network.slice(anonymousNetworkStart).filter(entry=>entry.event==="request"&&entry.method==="GET"&&["/","/demo"].includes(entry.path));
   console.log("SIGNUP_STORE_BADGE_REQUESTS:"+JSON.stringify({engine,width,mode,unsolicited}));
   if(unsolicited.length)throw Error("Anonymous store must not fetch the platform home or demo before the badge is chosen");
   const unchosenDemo=network.filter(entry=>entry.event==="request"&&entry.method==="GET"&&entry.path==="/demo");
   console.log("SIGNUP_UNCHOSEN_DEMO_REQUESTS:"+JSON.stringify({engine,width,mode,requests:unchosenDemo}));
   if(unchosenDemo.length)throw Error("Signup and initial setup must not fetch the demo before it is chosen");
   if(localChallenges<1||foreign||errors.length||mutations.length!==3||mutations[0].path!=="/api/auth/request"||mutations[1].path!=="/api/auth/callback"||mutations[2].path!=="/api/store/claim")throw Error("Unexpected operation or page error "+JSON.stringify({foreign,errors,mutations}));
   gaps.push({width,mode,reason:"Synthetic disposable local inbox/session/store claim only; no real email/account/store, physical device, assistive user or actual browser400% zoom. Production BotID behavior and manual sticky-scroll review remain open."});
   console.log("SIGNUP_ACTION_PROOF:"+JSON.stringify({engine,width,mode,actualLocalRequest:true,capturedEmails:mail.length,confirmationGetDidNotSignIn:true,explicitConfirmation:true,authenticatedFirstSetup:true,actualFirstStoreClaim:true,anonymousPublicStoreAfterReload:true,interceptedVisits,localChallenges,foreign,mutations}));
  }catch(error){failed++;const diagnostic=page?await page.evaluate(()=>({path:location.pathname,headings:[...document.querySelectorAll("h1,h2")].map(n=>n.textContent),body:document.body.innerText.slice(0,4000)})).catch(()=>null):null;console.error("SIGNUP_MATRIX_FAILURE:"+JSON.stringify({engine,width,mode,phase,diagnostic,errors,network:network.slice(-80),proxyTrace:proxyTrace.slice(-80),capturedLocalEmails:services.emails().length-before,error:String(error).replace(/token=[^&\s"']+/g,"token=redacted")}));console.error("SIGNUP_SERVER_DIAGNOSTIC:"+output.replace(/token=[^&\s"']+/g,"token=redacted"));}
  finally{cases++;await context.close();}
 }
 console.log("SIGNUP_MATRIX_OPEN_GAPS:"+JSON.stringify(gaps));
 console.log("SIGNUP_MATRIX_SUMMARY:"+JSON.stringify({engine,cases,audits,failed,scope:"Real local request/captured fake email/explicit confirmation/new empty studio/actual initial claim/anonymous public store after session removal and reload. Synthetic services only; no production signup/store/payment/message/checkout or buyer proof."}));
}finally{if(browser)await browser.close();if(app&&app.exitCode===null){const closed=new Promise(resolve=>app.once("exit",resolve));const forced=setTimeout(()=>app.kill("SIGKILL"),5_000);app.kill("SIGTERM");await closed;clearTimeout(forced);}if(proxy.listening){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await services.close();if(reviewedApp)await reviewedApp.cleanup();}
process.exitCode=failed?1:0;
