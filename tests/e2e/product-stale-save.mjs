// Two tabs of the studio open on the same product, the one opened first saving last (tests/product-stale-save.test.ts
// holds the route; this holds the screen). Synthetic store and stand-in services only (tests/e2e/services.mjs).
// What fails here: the stale tab's save going through over the other tab's words; the creator's typed words leaving the
// form; the notice not taking the focus, not being announced or not reachable and usable by keyboard alone; an axe
// violation in the notice; and keeping one's own changes, chosen with both shown, not being saved.
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
const port=3191,origin="http://localhost:"+port;
const here=join(root,"tests/e2e"),FAKE="http://127.0.0.1:4491";
const env={
 ...process.env,
 DEMO_STUDIO_ADMIN:"operator@example.test",
 STRIPE_DEMO_ACCOUNT_ID:"acct_fixtureDemo",
 UPSTASH_REDIS_REST_URL:FAKE,
 UPSTASH_REDIS_REST_TOKEN:"local",
 RESEND_API_KEY:"re_local_only_a_stand_in",
 RESEND_API_BASE:FAKE,
 ANTHROPIC_API_KEY:"sk-ant-local_only_"+"x".repeat(30),
 ANTHROPIC_API_BASE:FAKE,
 STRIPE_DEMO_SECRET_KEY:"sk_test_local_only_a_stand_in",
 STRIPE_CONNECT_API_BASE:FAKE,
 NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(here,"google-fonts-mock.cjs"),
 E2E_FONT_ORIGIN:FAKE,
 NEXT_TELEMETRY_DISABLED:"1",
};
const services=await startServices(4491);
const folder=mkdtempSync(join(tmpdir(),"mm-stale-save-")),seedFile=join(folder,"seed.cjs");
let fixture;
try{
 await build({entryPoints:[join(here,"store-copy-seed.ts")],bundle:true,platform:"node",format:"cjs",outfile:seedFile,logLevel:"error",alias:{"@":root}});
 const seeded=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[seedFile],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let data="";child.stdout.on("data",chunk=>data+=chunk);child.stderr.on("data",chunk=>data+=chunk);child.on("error",reject);child.on("close",code=>code===0?resolve(data):reject(Error("Synthetic seed failed")));});
 fixture=JSON.parse(seeded.trim().split("\n").at(-1)).homeDemo;
 if(!fixture?.session||!fixture?.sid||!fixture?.product)throw Error("Incomplete synthetic fixture");
}catch(error){await services.close();throw error;}finally{rmSync(folder,{recursive:true,force:true});}
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port)],{env,stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
let browser,failed=0,checks=0;
const check=(name,actual,expected)=>{checks++;const ok=JSON.stringify(actual)===JSON.stringify(expected);if(!ok)failed++;console.log(`${ok?"ok  ":"FAIL"} ${name}${ok?"":` expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`}`);};
try{
 let up=false;for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error(output);try{up=(await fetch(origin)).ok;}catch{}if(up)break;await new Promise(resolve=>setTimeout(resolve,500));}if(!up)throw Error("Local app unavailable "+output);
 browser=await driver.launch();console.log("STALE_SAVE_ENGINE:"+JSON.stringify({requested:engine,actual:driver.name(),version:browser.version()}));
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:"block"});
 await context.addCookies([{name:"nl_session",value:fixture.session,url:origin}]);
 const id=fixture.product,studio="/studio?store="+fixture.sid;
 const open=async()=>{
  const page=await context.newPage();
  await page.goto(origin+studio,{waitUntil:"networkidle"});
  await page.locator("[data-product-editor] li",{has:page.locator(`text="Weekly Meal Planner"`)}).first().getByRole("button",{name:"Edit",exact:true}).click();
  await page.locator(`#product-form-${id}`).waitFor();
  return page;
 };
 const tabA=await open(),tabB=await open();
 const originalSummary=await tabB.locator(`#product-summary-${id}`).inputValue();

 // Tab A saves a new summary.
 await tabA.locator(`#product-summary-${id}`).fill("Saved in tab A.");
 await tabA.locator(`#product-form-${id}`).getByRole("button",{name:"Save",exact:true}).click();
 await tabA.locator(`#product-form-${id}`).waitFor({state:"detached",timeout:30000});
 check("tab A's save from the revision it opened is taken",await tabA.locator(`#product-form-${id}`).count(),0);

 // Tab B, opened before it, saves a new name.
 await tabB.locator(`#product-title-${id}`).fill("Weekly Meal Planner, renamed in tab B");
 await tabB.locator(`#product-form-${id}`).getByRole("button",{name:"Save",exact:true}).click();
 const notice=tabB.locator("[data-stale-notice]");
 await notice.waitFor({timeout:30000});
 await tabB.waitForFunction(id=>document.activeElement?.id===`product-${id}-stale-title`,id,{timeout:5000}).catch(()=>{});
 check("the focus goes to the notice's heading",await tabB.evaluate(()=>document.activeElement?.id),`product-${id}-stale-title`);
 check("the notice says nothing was saved, in a live region",await notice.locator('[role="alert"]').innerText().then(text=>/nothing was saved here/.test(text)),true);
 check("tab B's typed name is still in the form",await tabB.locator(`#product-title-${id}`).inputValue(),"Weekly Meal Planner, renamed in tab B");
 const text=await notice.innerText();
 check("what is saved now is shown beside what was typed",[text.includes("Saved now: Saved in tab A."),text.includes("Yours: "+originalSummary),text.includes("Saved now: Weekly Meal Planner"),text.includes("Yours: Weekly Meal Planner, renamed in tab B")],[true,true,true,true]);
 await tabB.addScriptTag({content:axe});
 const violations=await tabB.evaluate(async()=>(await window.axe.run(document.querySelector("[data-stale-notice]"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag2aaa","wcag21a","wcag21aa","wcag22aa","best-practice"]}})).violations.map(v=>v.id));
 check("no axe violation in the notice (WCAG A, AA, AAA tags and best practice)",violations,[]);
 const targets=await notice.getByRole("button").evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44;}));
 check("both choices are targets of at least 44 by 44 px",targets,[true,true]);

 // Nothing of tab B's was written: tab A, reloaded, still shows its own summary and the old name.
 await tabA.reload({waitUntil:"networkidle"});
 check("tab A's summary is still saved",await tabA.getByText("Saved in tab A.").count()>0,true);
 check("tab B's name was not saved by the refused save",await tabA.getByText("Weekly Meal Planner, renamed in tab B").count(),0);

 // By keyboard only: from the heading, Tab to "Keep my changes and save" and press Enter.
 let reached=false;
 for(let n=0;n<6&&!reached;n++){await tabB.keyboard.press("Tab");reached=await tabB.evaluate(()=>document.activeElement?.textContent?.trim()==="Keep my changes and save");}
 check("the first choice is reached by Tab from the heading",reached,true);
 await tabB.keyboard.press("Enter");
 await tabB.locator(`#product-form-${id}`).waitFor({state:"detached",timeout:30000});
 await tabA.reload({waitUntil:"networkidle"});
 check("keeping one's own changes, chosen with both shown, saves them",await tabA.getByText("Weekly Meal Planner, renamed in tab B").count()>0,true);

 // The other way: a third tab saves, the stale one takes what is saved now, and its form shows it.
 const tabC=await context.newPage();
 await tabC.goto(origin+studio,{waitUntil:"networkidle"});
 await tabA.locator("[data-product-editor] li",{has:tabA.locator(`text="Weekly Meal Planner, renamed in tab B"`)}).first().getByRole("button",{name:"Edit",exact:true}).click();
 await tabC.locator("[data-product-editor] li",{has:tabC.locator(`text="Weekly Meal Planner, renamed in tab B"`)}).first().getByRole("button",{name:"Edit",exact:true}).click();
 await tabC.locator(`#product-summary-${id}`).fill("Saved in tab C.");
 await tabC.locator(`#product-form-${id}`).getByRole("button",{name:"Save",exact:true}).click();
 await tabC.locator(`#product-form-${id}`).waitFor({state:"detached",timeout:30000});
 await tabA.locator(`#product-title-${id}`).fill("A name typed in tab A");
 await tabA.locator(`#product-form-${id}`).getByRole("button",{name:"Save",exact:true}).click();
 await tabA.locator("[data-stale-notice]").waitFor({timeout:30000});
 await tabA.getByRole("button",{name:"Use the saved version"}).focus();
 await tabA.keyboard.press("Enter");
 await tabA.waitForFunction(id=>document.activeElement?.id===`product-title-${id}`,id,{timeout:5000}).catch(()=>{});
 check("using the saved version fills the form with it",[await tabA.locator(`#product-title-${id}`).inputValue(),await tabA.locator(`#product-summary-${id}`).inputValue()],["Weekly Meal Planner, renamed in tab B","Saved in tab C."]);
 check("the notice goes and the focus is on the name",[await tabA.locator("[data-stale-notice]").count(),await tabA.evaluate(()=>document.activeElement?.id)],[0,`product-title-${id}`]);
 await tabA.locator(`#product-form-${id}`).getByRole("button",{name:"Save",exact:true}).click();
 await tabA.locator(`#product-form-${id}`).waitFor({state:"detached",timeout:30000});
 check("a save after taking the saved version is taken",await tabA.locator("[data-stale-notice]").count(),0);
 await context.close();
}finally{
 await browser?.close();app.kill();await services.close();
}
console.log(`${checks} checks, ${failed} failing.`);
process.exitCode=failed?1:0;
