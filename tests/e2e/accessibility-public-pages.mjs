/**
 * The public pages the Public AAA matrix (accessibility-public-matrix.mjs) does
 * not open: the help center, the legal pages, the trust pages and the error page
 * (AX274 Part A, item 5). Each is opened at 320 px (what 400% zoom of a
 * 1280 px window leaves, WCAG 1.4.10) and at 1280 px, in light, dark and
 * forced colors, and audited with axe-core's WCAG 2.2 A/AA/AAA rules
 * (1.4.6 enhanced contrast included), then checked for:
 *  - no horizontal scroll (1.4.10);
 *  - a document language, a title, one h1 and headings that never skip a level (3.1.1, 2.4.2, 2.4.10);
 *  - a skip link to the content (2.4.1);
 *  - every link and button inside main at least 44 by 44 px, a link inside a sentence excepted (2.5.5);
 *  - no link whose whole text is a vague "here", "more" or "click here" (2.4.9).
 * Real assistive technology is not used: that stays a gap.
 */
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve,join} from "node:path";
const root=resolve(".");
const require=createRequire(join(root,"package.json"));
const engine=process.env.E2E_BROWSER??"chromium";
if(!["chromium","firefox","webkit"].includes(engine))throw Error("Unsupported engine "+engine);
const driver=require("playwright-core")[engine];
const axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const port=3194,origin="http://127.0.0.1:"+port;
export const PUBLIC_PAGES=["/help","/terms","/privacy","/refunds","/accessibility","/copyright","/transparency","/mission","/status","/no-such-page-here"];
const VAGUE=/^(here|click here|more|read more|learn more|this|link|details)$/i;
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{env:{...process.env,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
let browser,failed=0,cases=0;
try{
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error(output);try{up=(await fetch(origin)).ok;}catch{}if(up)break;await new Promise(r=>setTimeout(r,500));}if(!up)throw Error("Local app unavailable "+output);
 browser=await driver.launch(engine==="chromium"&&process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
 for(const path of PUBLIC_PAGES)for(const width of [320,1280])for(const mode of ["light","dark","forced-colors"]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:"block",colorScheme:mode==="dark"?"dark":"light",forcedColors:mode==="forced-colors"?"active":"none"});
  try{
   const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(String(e)));
   await context.route("**/*",route=>{const r=route.request(),url=new URL(r.url());if(!["GET","HEAD"].includes(r.method())||url.origin!==origin)return route.abort();return route.continue();});
   const response=await page.goto(origin+path,{waitUntil:"networkidle",timeout:60000});
   const expected=path==="/no-such-page-here"?404:200;
   if(response.status()!==expected)throw Error("HTTP "+response.status());
   await page.addScriptTag({content:axe});
   const report=await page.evaluate(async()=>{
    const tags=["wcag2a","wcag2aa","wcag2aaa","wcag21a","wcag21aa","wcag21aaa","wcag22a","wcag22aa","wcag22aaa"];
    const result=await window.axe.run(document,{runOnly:{type:"tag",values:tags}});
    return result.violations.map(rule=>({id:rule.id,targets:rule.nodes.slice(0,6).map(node=>node.target.join(" "))}));
   });
   const shape=await page.evaluate(VAGUE_SOURCE=>{
    const vague=new RegExp(VAGUE_SOURCE,"i"),root=document.documentElement,out=[];
    if(root.scrollWidth>root.clientWidth)out.push({check:"1.4.10 horizontal scroll",scroll:root.scrollWidth,client:root.clientWidth});
    if(!(root.getAttribute("lang")||"").trim())out.push({check:"3.1.1 no lang"});
    if(!document.title.trim())out.push({check:"2.4.2 no title"});
    const levels=[...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(h=>h.getClientRects().length).map(h=>Number(h.tagName[1]));
    if(levels.filter(l=>l===1).length!==1)out.push({check:"2.4.10 one h1",levels});
    levels.forEach((l,i)=>{if(i&&l>levels[i-1]+1)out.push({check:"2.4.10 skipped heading level",from:levels[i-1],to:l});});
    const skip=[...document.querySelectorAll("a[href^='#']")].find(a=>{const id=decodeURIComponent(a.getAttribute("href").slice(1));return id&&document.getElementById(id)?.matches("main,[role=main]");});
    if(!skip)out.push({check:"2.4.1 no skip link to main"});
    for(const n of document.querySelectorAll("main a[href],main button,main summary,main [role=button],main input:not([type=hidden]),main select")){
     const r=n.getBoundingClientRect(),s=getComputedStyle(n);if(!r.width||!r.height||s.visibility==="hidden"||n.closest(".sr-only,[hidden],[inert]"))continue;
     if(n.tagName==="A"&&s.display==="inline"){const p=n.parentElement;if(p&&(p.textContent||"").trim().length>(n.textContent||"").trim().length+3)continue;}
     const label=n.matches("input")?(n.labels?.[0]??n.closest("label")):null,l=label?label.getBoundingClientRect():r;
     if(Math.max(r.width,l.width)<43.5||Math.max(r.height,l.height)<43.5)out.push({check:"2.5.5 target under 44px",tag:n.tagName,name:(n.getAttribute("aria-label")||n.textContent||"").trim().slice(0,50),width:Math.round(r.width),height:Math.round(r.height)});
    }
    for(const a of document.querySelectorAll("a[href]")){const name=(a.getAttribute("aria-label")||a.textContent||"").trim();if(vague.test(name))out.push({check:"2.4.9 vague link",name});}
    return out;
   },VAGUE.source);
   cases++;
   const bad=report.length||shape.length||errors.length;
   console.log("PUBLIC_PAGES_CASE:"+JSON.stringify({engine,path,width,mode,violations:report,shape,errors}));
   if(bad)failed++;
  }catch(error){failed++;console.error("PUBLIC_PAGES_ERROR:"+JSON.stringify({engine,path,width,mode,error:String(error)}));}
  finally{await context.close();}
 }
}finally{await browser?.close();app.kill("SIGTERM");}
console.log("PUBLIC_PAGES_SUMMARY:"+JSON.stringify({engine,cases,failed,gap:"Real screen readers, voice control and switch access were not used; automated checks are not conformance."}));
if(failed||!cases)process.exit(1);
