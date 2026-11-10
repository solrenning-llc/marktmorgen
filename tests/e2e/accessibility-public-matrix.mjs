import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {checkHelpSearchAvailability} from "./help-search-availability.mjs";
const root=resolve(".");
const require=createRequire(join(root,"package.json"));
const engine=process.env.E2E_BROWSER??"chromium";
if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unsupported engine "+engine);
const driver=require("playwright-core")[engine];
const axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const port=3193,origin="http://127.0.0.1:"+port;
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{env:{...process.env,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
let browser,failed=0,cases=0;const gaps=[];
try{
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error(output);try{up=(await fetch(origin)).ok;}catch{}if(up)break;await new Promise(resolve=>setTimeout(resolve,500));}if(!up)throw Error("Local app unavailable "+output);
 browser=await driver.launch();console.log("PUBLIC_MATRIX_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 if(process.env.AX2_PUBLIC_STANDARD==="true")await checkHelpSearchAvailability({browser,origin});
 for(const path of ["/","/pricing","/signin"])for(const width of [320,390,768,1280,1920])for(const mode of ["baseline","text-spacing","reduced-motion","forced-colors","reflow-320",...(process.env.AX2_PUBLIC_STANDARD==="true"?["dark"]:[])]){
  const viewportWidth=mode==="reflow-320"?320:width;
  const context=await browser.newContext({...(mode==="dark"?{colorScheme:"dark"}:{}),viewport:{width:viewportWidth,height:900},serviceWorkers:"block",reducedMotion:mode==="reduced-motion"?"reduce":"no-preference",forcedColors:mode==="forced-colors"?"active":"none"});
  let writes=0,foreign=0;const errors=[];
  try{
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
   page.on("pageerror",error=>errors.push(String(error)));
   await context.route("**/*",route=>{const r=route.request(),url=new URL(r.url());if(!["GET","HEAD"].includes(r.method())){writes++;return route.abort();}if(url.origin!==origin){foreign++;return route.abort();}return route.continue();});
   const response=await page.goto(origin+path,{waitUntil:"networkidle",timeout:60000});await restoreDarkAfterNavigation();if(response.status()!==200)throw Error("HTTP "+response.status());
   if(mode==="text-spacing")await page.addStyleTag({content:"*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}"});
   if(mode==="forced-colors"){
    const active=await page.evaluate(()=>matchMedia("(forced-colors: active)").matches);
    if(!active)gaps.push({path,width,mode,reason:"Engine did not activate forced-colors media after emulation request; real OS/device validation remains open."});
   }
   if(mode==="reduced-motion"&&!await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches))throw Error("Reduced-motion request not honored");
   const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,offenders:[...document.querySelectorAll("main *")].filter(node=>{const b=node.getBoundingClientRect();return b.width>0&&(b.right>document.documentElement.clientWidth+1||b.left< -1);}).slice(0,8).map(node=>({html:node.outerHTML.slice(0,220),left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right}))}));
   if(overflow.scroll>overflow.client)throw Error("Horizontal overflow "+JSON.stringify(overflow));
   // Actual keyboard events; no scripted focus or focus-style suppression.
   if(mode==="baseline"){
    let focused=0;
    for(let n=0;n<10;n++){
     await page.keyboard.press("Tab");
     const state=await page.evaluate(()=>{const node=document.activeElement;if(!node||node===document.body)return null;const b=node.getBoundingClientRect();return {tag:node.tagName,visible:node.matches(":focus-visible"),width:b.width,height:b.height};});
     if(state){
      focused++;if(!state.visible||state.width<=0||state.height<=0)throw Error("Keyboard focus not visible "+JSON.stringify(state));
      try{
       await page.waitForFunction(()=>{
        const node=document.activeElement;if(!node||node===document.body)return false;
        // An inline link can occupy several lines: the center of its union
        // box may be empty space. Check every actual rendered fragment.
        const rects=[...node.getClientRects()].filter(r=>r.width>0&&r.height>0);
        return rects.length>0&&rects.every(r=>{
         const x=r.left+r.width/2,y=r.top+r.height/2;
         if(x<0||x>=innerWidth||y<0||y>=innerHeight)return false;
         const hit=document.elementFromPoint(x,y);return Boolean(hit&&(hit===node||node.contains(hit)));
        });
       },undefined,{timeout:5000});
      }catch(error){
       console.error("PUBLIC_FOCUS_DIAGNOSTIC:"+JSON.stringify({engine,path,width,tab:n+1,...await page.evaluate(()=>{
        const node=document.activeElement;if(!node)return {};
        return {tag:node.tagName,classes:typeof node.className==="string"?node.className:"",scrollY,
         fragments:[...node.getClientRects()].map(r=>{const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {left:r.left,top:r.top,width:r.width,height:r.height,hitTag:hit?.tagName,hitClasses:typeof hit?.className==="string"?hit.className:"",inside:Boolean(hit&&(hit===node||node.contains(hit)))};})};
       })}));throw error;
      }
     }
    }
    if(!focused)throw Error("No keyboard target reached");
   }
   // Keyboard proof above retains its real scrolled positions. Whole-document
   // target geometry is evaluated at a stable origin, like the Studio/action matrices.
   // Native focus may still be animating a smooth scroll in Chromium.
   // Wait for the real keyboard scroll to finish before requesting audit origin.
   await page.evaluate(()=>{document.activeElement?.blur?.();});
   try{await page.waitForFunction(()=>{
    const key=scrollX+","+scrollY,previous=window.__publicKeyboardScroll;
    if(!previous||previous.key!==key){window.__publicKeyboardScroll={key,since:performance.now()};return false;}
    return performance.now()-previous.since>=200;
   },undefined,{timeout:10000});}catch(error){console.error("PUBLIC_SCROLL_DIAGNOSTIC:"+JSON.stringify({engine,path,width,stage:"keyboard-settlement",...await page.evaluate(()=>({x:scrollX,y:scrollY,state:window.__publicKeyboardScroll,active:document.activeElement?.tagName}))}));throw error;}
   await page.evaluate(()=>{
    delete window.__publicKeyboardScroll;
    const root=document.documentElement;
    window.__publicScrollStyle={value:root.style.getPropertyValue("scroll-behavior"),priority:root.style.getPropertyPriority("scroll-behavior")};
    // Firefox may retain CSS smooth scrolling despite an "instant" request.
    // Keyboard proof is already complete; only normalize whole-document audit geometry.
    root.style.setProperty("scroll-behavior","auto","important");
    window.scrollTo({top:0,left:0,behavior:"auto"});
   });
   try{await page.waitForFunction(()=>{
    if(scrollX!==0||scrollY!==0){delete window.__publicOriginSince;return false;}
    window.__publicOriginSince??=performance.now();return performance.now()-window.__publicOriginSince>=200;
   },undefined,{timeout:10000});}catch(error){console.error("PUBLIC_SCROLL_DIAGNOSTIC:"+JSON.stringify({engine,path,width,stage:"audit-origin",...await page.evaluate(()=>({x:scrollX,y:scrollY,originSince:window.__publicOriginSince,active:document.activeElement?.tagName,scrollBehavior:getComputedStyle(document.documentElement).scrollBehavior}))}));throw error;}
   await page.evaluate(()=>{delete window.__publicOriginSince;});
   if(mode==="dark"&&!await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches))throw Error("Dark color-scheme request not honored");
   await page.addScriptTag({content:axe});
   const report=await page.evaluate(async()=>{
    const tags=["wcag2a","wcag2aa","wcag2aaa","wcag21a","wcag21aa","wcag21aaa","wcag22a","wcag22aa","wcag22aaa"];
    const selected=window.axe.getRules().filter(rule=>rule.tags.some(tag=>tags.includes(tag)));
    if(!selected.some(rule=>rule.ruleId==="color-contrast-enhanced"))throw Error("AAA enhanced-contrast rule missing");
    const result=await window.axe.run(document,{runOnly:{type:"tag",values:tags}});
    return {rules:selected.map(rule=>rule.ruleId),violations:result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)})),incomplete:result.incomplete.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)}))};
   });
   await page.evaluate(()=>{
    const previous=window.__publicScrollStyle,root=document.documentElement;
    if(previous?.value)root.style.setProperty("scroll-behavior",previous.value,previous.priority);
    else root.style.removeProperty("scroll-behavior");
    delete window.__publicScrollStyle;
   });
   if(report.incomplete.length)gaps.push({path,width,mode,manualReview:report.incomplete});
   console.log("PUBLIC_MATRIX_CASE:"+JSON.stringify({engine,path,width,mode,viewportWidth,writes,foreign,...report,errors}));
   if(report.violations.length||errors.length||writes)failed++;
   // After preserving the baseline audit, exercise a real mobile-to-desktop
   // change. A CSS-hidden drawer must not retain its scroll lock or focus.
   if(path==="/pricing"&&width===390&&mode==="baseline"){ // VS1: the shared drawer is on every page but the home page and /pricing, which share the home page's short menu; it is exercised on a feature page, after the /pricing audit above.
    await page.goto(origin+"/platform",{waitUntil:"networkidle",timeout:60000});
    const toggle=page.locator('button[aria-controls="mobile-drawer"]');
    await toggle.focus();await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.body.style.overflow==="hidden"&&document.querySelector("#mobile-drawer")?.contains(document.activeElement));
    await page.setViewportSize({width:1280,height:900});
    await page.waitForFunction(()=>{
     const drawer=document.querySelector("#mobile-drawer"),button=document.querySelector('button[aria-controls="mobile-drawer"]');
     return document.body.style.overflow!=="hidden"&&button?.getAttribute("aria-expanded")==="false"
      &&getComputedStyle(drawer).display==="none"
      &&document.activeElement?.getAttribute("aria-label")==="Marktmorgen, home";
    });
    await page.setViewportSize({width:390,height:900});
    if(await toggle.getAttribute("aria-expanded")!=="false")throw Error("Mobile drawer reopened on return");
    await toggle.focus();await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector("#mobile-drawer")?.contains(document.activeElement));
    await page.keyboard.press("Escape");
    await page.waitForFunction(()=>document.body.style.overflow!=="hidden"&&document.activeElement===document.querySelector('button[aria-controls="mobile-drawer"]'));
    console.log("PUBLIC_NAV_RESIZE_REGRESSION:"+JSON.stringify({engine,from:390,to:1280,back:390,scrollUnlocked:true,visibleFocusRestored:true,reopenedAndEscaped:true}));
   }

   // Keep the measured public case above intact. Exercise only a disposable,
   // intercepted recovery request: no account lookup, email or server mutation.
   if(path==="/signin"&&width===390&&mode==="baseline"){
    let recoveryPosts=0;
    await page.route("**/api/auth/lost",route=>{
     if(route.request().method()!=="POST")return route.abort();
     recoveryPosts++;
     return route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Synthetic recovery response</title><p>Intercepted locally</p>"});
    });
    await page.goto(origin+"/signin/lost",{waitUntil:"networkidle"});
    const recoveryEmail=page.getByLabel("The address you log in with",{exact:true});
    const recoveryButton=page.getByRole("button",{name:"Email my recovery address",exact:true});
    for(const invalid of ["","not-an-email"]){
     await recoveryEmail.fill(invalid);
     await recoveryButton.focus();await page.keyboard.press("Enter");
     // The old click handler schedules its lock for the next event-loop turn.
     await page.waitForTimeout(100);
     if(await recoveryButton.getAttribute("aria-busy")!=="false"||recoveryPosts!==0)throw Error("Invalid recovery input locked or submitted the form");
    }
    await recoveryEmail.fill("recovery-fixture@example.test");
    const posted=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/lost"&&r.request().method()==="POST");
    await recoveryButton.focus();await page.keyboard.press("Enter");
    await posted;
    if(recoveryPosts!==1)throw Error("Corrected recovery input did not submit exactly once");
    console.log("PENDING_SUBMIT_VALIDATION_REGRESSION:"+JSON.stringify({engine,emptyRetry:true,malformedRetry:true,validKeyboardPost:1,intercepted:true}));

    // The actual help page and its hydrated search: no account, API or test-only UI.
    // Preserve the entry-page audit above; these are bounded navigation regressions.
    await page.waitForURL(origin+"/api/auth/lost",{waitUntil:"load"});
    for(const helpWidth of [390,1280]){
     await page.setViewportSize({width:helpWidth,height:900});
     await page.goto(origin+"/help#%",{waitUntil:"networkidle"});
     const search=page.getByRole("searchbox",{name:"Search the help center",exact:true});
     const sectionLink=page.getByRole("navigation",{name:"Help sections",exact:true}).locator("a").first();
     const sectionId=(await sectionLink.getAttribute("href")).slice(1);
     const answerId=await page.locator("details[data-help-item]").last().getAttribute("id");
     if(!sectionId||!answerId)throw Error("Help navigation fixture is incomplete");
     await search.fill("zzzz-no-answer-fixture");
     await page.waitForFunction(()=>document.querySelectorAll("details[data-help-item]:not([hidden])").length===0);
     await sectionLink.focus();await page.keyboard.press("Enter");
     await page.waitForFunction(id=>{
      const field=document.querySelector("#help-search"),section=document.getElementById(id);
      return field?.value===""&&section&&!section.hidden&&section.getBoundingClientRect().height>0;
     },sectionId);
     // The current fragment has not changed: following it again emits no hashchange.
     await search.fill("zzzz-no-answer-fixture");
     await page.waitForFunction(()=>document.querySelectorAll("details[data-help-item]:not([hidden])").length===0);
     await sectionLink.focus();await page.keyboard.press("Enter");
     await page.waitForFunction(id=>document.querySelector("#help-search")?.value===""&&!document.getElementById(id)?.hidden,sectionId);
     await search.fill("zzzz-no-answer-fixture");
     await page.waitForFunction(()=>document.querySelectorAll("details[data-help-item]:not([hidden])").length===0);
     await page.goto(origin+"/help#"+encodeURIComponent(answerId));
     await page.waitForFunction(id=>{
      const answer=document.getElementById(id),section=answer?.closest("section[data-help-section]");
      return document.querySelector("#help-search")?.value===""&&answer?.open&&!answer.hidden&&section&&!section.hidden;
     },answerId);
     if(!await page.locator("details[data-help-item]").last().isVisible())throw Error("Help answer is still hidden after its link");
     await search.fill("Stripe");
     await page.waitForFunction(()=>document.querySelector("#help-search")?.value==="Stripe"&&document.querySelector("#help-search")?.getAttribute("aria-describedby")&&document.querySelectorAll("details[data-help-item][hidden]").length>0);
     for(const fragment of ["missing-help-answer-fixture","%E0%A4%A"]){
      await page.goto(origin+"/help#"+fragment);
      // Let the real hashchange handler run before checking that it kept the search.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(await search.inputValue()!=="Stripe")throw Error("Unrelated or malformed help fragment cleared the search");
     }
     if(errors.length||writes)throw Error("Help navigation raised an error or attempted a write: "+errors.join("; "));
     console.log("HELP_FRAGMENT_NAVIGATION_REGRESSION:"+JSON.stringify({engine,width:helpWidth,malformedEntry:true,keyboardSection:true,repeatedSection:true,hiddenAnswer:true,queryPreserved:true,writes,foreign}));
    }
   }

  }catch(error){failed++;console.error("PUBLIC_MATRIX_FAILURE:"+JSON.stringify({engine,path,width,mode,error:String(error)}));}
  finally{cases++;await context.close();}
 }
 console.log("PUBLIC_MATRIX_OPEN_GAPS:"+JSON.stringify(gaps));
 console.log("PUBLIC_MATRIX_SUMMARY:"+JSON.stringify({engine,cases,failed,gaps:gaps.length,scope:"Three public entry journeys and help fragment navigation regressions. Synthetic emulation; reflow320 is not real browser400% zoom. No real-device, assistive-user or whole-product AAA certification."}));
}finally{if(browser)await browser.close();app.kill("SIGTERM");}
process.exitCode=failed?1:0;
