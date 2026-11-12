import {checkContentFocusTarget} from "./skip-content-focus.mjs";
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
const port=3195,origin="http://localhost:"+port;
const here=join(root,"tests/e2e"),FAKE="http://127.0.0.1:4495";
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

const services=await startServices(4495);
const folder=mkdtempSync(join(tmpdir(),"mm-studio-matrix-")),seedFile=join(folder,"seed.cjs");
let fixture;
try{
 await build({entryPoints:[join(here,"store-copy-seed.ts")],bundle:true,platform:"node",format:"cjs",outfile:seedFile,logLevel:"error",alias:{"@":root}});
 const seeded=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[seedFile],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let data="";child.stdout.on("data",chunk=>data+=chunk);child.stderr.on("data",chunk=>data+=chunk);child.on("error",reject);child.on("close",code=>code===0?resolve(data):reject(Error("Synthetic seed failed")));});
 fixture=JSON.parse(seeded.trim().split("\n").at(-1)).homeDemo;
 if(!fixture?.session||!fixture?.sid||!fixture?.product)throw Error("Incomplete synthetic fixture");
}catch(error){await services.close();throw error;}finally{rmSync(folder,{recursive:true,force:true});}
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{env,stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
let browser,failed=0,cases=0;const gaps=[];
try{
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error(output);try{up=(await fetch(origin)).ok;}catch{}if(up)break;await new Promise(resolve=>setTimeout(resolve,500));}if(!up)throw Error("Local app unavailable "+output);
 browser=await driver.launch();console.log("STUDIO_MATRIX_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 for(const path of ["/studio?store="+fixture.sid,"/studio/pages?store="+fixture.sid+"&product="+fixture.product])for(const width of [320,390,768,1280,1920])for(const mode of ["baseline","text-spacing","reduced-motion","forced-colors","reflow-320",...(process.env.AX2_PUBLIC_STANDARD==="true"?["dark"]:[])]){
  const viewportWidth=mode==="reflow-320"?320:width;
  const context=await browser.newContext({...(mode==="dark"?{colorScheme:"dark"}:{}),viewport:{width:viewportWidth,height:900},serviceWorkers:"block",reducedMotion:mode==="reduced-motion"?"reduce":"no-preference",forcedColors:mode==="forced-colors"?"active":"none"});
  await context.addCookies([{name:"nl_session",value:fixture.session,url:origin}]);
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
   if(new URL(page.url()).pathname.startsWith("/signin"))throw Error("Synthetic authenticated journey redirected to sign-in");
   if(!await page.locator("main").count())throw Error("Authenticated main missing");
   if(mode==="text-spacing")await page.addStyleTag({content:"*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}"});
   if(mode==="forced-colors"){
    const active=await page.evaluate(()=>matchMedia("(forced-colors: active)").matches);
    if(!active)gaps.push({path,width,mode,reason:"Engine did not activate forced-colors media after emulation request; real OS/device validation remains open."});
   }
   if(mode==="reduced-motion"&&!await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches))throw Error("Reduced-motion request not honored");
   const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,internalOverflow:[...document.querySelectorAll("body *")].filter(node=>node.clientWidth>0&&node.scrollWidth>node.clientWidth+1).slice(0,16).map(node=>({html:node.outerHTML.slice(0,300),scroll:node.scrollWidth,client:node.clientWidth,overflow:getComputedStyle(node).overflowX})),offenders:[...document.querySelectorAll("body *")].filter(node=>{const b=node.getBoundingClientRect();if(!(b.width>0&&(b.right>document.documentElement.clientWidth+1||b.left< -1)))return false;for(let parent=node.parentElement;parent&&parent!==document.documentElement;parent=parent.parentElement){if(["auto","scroll","hidden","clip"].includes(getComputedStyle(parent).overflowX))return false;}return true;}).slice(0,12).map(node=>({html:node.outerHTML.slice(0,400),left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right}))}));
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
   if(mode==="dark"&&!await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches))throw Error("Dark color-scheme request not honored");
   await page.addScriptTag({content:axe});
   const report=await page.evaluate(async()=>{
    const tags=["wcag2a","wcag2aa","wcag2aaa","wcag21a","wcag21aa","wcag21aaa","wcag22a","wcag22aa","wcag22aaa"];
    const selected=window.axe.getRules().filter(rule=>rule.tags.some(tag=>tags.includes(tag)));
    if(!selected.some(rule=>rule.ruleId==="color-contrast-enhanced"))throw Error("AAA enhanced-contrast rule missing");
    const result=await window.axe.run(document,{runOnly:{type:"tag",values:tags}});
    return {rules:selected.map(rule=>rule.ruleId),violations:result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target),nodes:rule.nodes.map(node=>({target:node.target,html:node.html.slice(0,600),summary:node.failureSummary}))})),incomplete:result.incomplete.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)}))};
   });
   if(report.incomplete.length)gaps.push({path,width,mode,manualReview:report.incomplete});
   console.log("STUDIO_MATRIX_CASE:"+JSON.stringify({engine,path,width,mode,viewportWidth,writes,foreign,...report,errors}));
   if(report.violations.length||errors.length||writes)failed++;
   if(mode==="baseline"&&width===390)await checkContentFocusTarget({context,origin,path});
  }catch(error){failed++;console.error("STUDIO_MATRIX_FAILURE:"+JSON.stringify({engine,path,width,mode,error:String(error)}));}
  finally{cases++;await context.close();}
 }
 console.log("STUDIO_MATRIX_OPEN_GAPS:"+JSON.stringify(gaps));
 console.log("STUDIO_MATRIX_SUMMARY:"+JSON.stringify({engine,cases,failed,gaps:gaps.length,scope:"Two authenticated read-only studio/editor surfaces only; no creation/save/publication action proof. Synthetic emulation; reflow320 is not real browser400% zoom. No real-device, assistive-user or whole-product AAA certification."}));
}finally{if(browser)await browser.close();app.kill("SIGTERM");await services.close();}
process.exitCode=failed?1:0;
