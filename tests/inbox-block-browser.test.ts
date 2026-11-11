/**
 * 567 [GD1] (f), unit 2: blocking a person from the studio's inbox
 * (components/inbox-block.tsx), in local Chromium with the real component and
 * a stand-in for the inbox route; every outside request is refused.
 *
 * - It first checks whether the person of the conversation is blocked, and
 *   says it is checking; what it cannot read is said as not known, with
 *   "Check again", never as "not blocked".
 * - Not blocked: "Block this person" opens a short form with the creator's own
 *   note (only they see it) and says what still reaches them; Block sends the
 *   conversation and the note, and the result is said in a live region.
 * - Blocked: it says so, shows the note, and "Let them write again" undoes it.
 * - Every button and the summary carry min-h-11 (44 px, 2.5.5); the page's
 *   CSS is not loaded here, so the class is what is checked.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {InboxBlock} from "@/components/inbox-block";',
 'window.__calls=[];',
 'const post=async (body)=>{window.__calls.push(body);const answer=window.__answers.shift();return answer??{ok:false,error:"network"};};',
 'createRoot(document.getElementById("root")).render(React.createElement(InboxBlock,{id:"abcdefabcdef",post}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
const out={errors:[],outside:0};
let browser;
try {
 browser=await launch();
 const open=async (answers)=>{
  const page=await browser.newPage();
  await page.route('**/*',r=>{out.outside++;return r.abort();});
  page.on('pageerror',e=>out.errors.push(e.message));
  await page.setContent('<main><div id="root"></div></main>');
  await page.evaluate((a)=>{window.__answers=a;},answers);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  return page;
 };
 const until=(page,fn)=>page.waitForFunction(fn,null,{timeout:5000}).then(()=>true,()=>false);
 const press=(page,selector)=>page.click(selector,{timeout:5000}).then(()=>true,()=>false);
 const text=(page)=>page.evaluate(()=>document.querySelector('[data-inbox-block]')?.textContent??'');
 const tall=(page)=>page.evaluate(()=>[...document.querySelectorAll('[data-inbox-block] button, [data-inbox-block] summary')].map(x=>x.className.split(/\s+/).includes('min-h-11')));

 // Not blocked, then blocked with a note, then let write again.
 {
  const page=await open([{ok:true,blocked:false},{ok:true,blocked:true},{ok:true,blocked:false}]);
  await until(page,()=>Boolean(document.querySelector('summary')));
  out.openText=await text(page);
  await press(page,'summary');
  out.heights=await tall(page);
  await page.fill('[data-inbox-block] input','Insults in every message',{timeout:5000}).catch(()=>null);
  await press(page,'[data-inbox-block] button[type=submit]');
  await until(page,()=>document.querySelector('[data-inbox-block]')?.textContent.includes('You blocked this person'));
  out.blockedText=await text(page);
  out.blockedHeights=await tall(page);
  out.live=await page.evaluate(()=>document.querySelector('[data-inbox-block] [role=status]')?.textContent??'');
  await press(page,'text=Let them write again');
  await until(page,()=>Boolean(document.querySelector('summary')));
  out.afterText=await text(page);
  out.calls=await page.evaluate(()=>window.__calls);
  await page.close();
 }
 // Not known: said so, and checked again on request.
 {
  const page=await open([{ok:false,error:'unknown'},{ok:true,blocked:true,reason:'Spam',at:1}]);
  await until(page,()=>document.querySelector('[data-inbox-block]')?.textContent.includes('could not check'));
  out.unknownText=await text(page);
  await press(page,'text=Check again');
  await until(page,()=>document.querySelector('[data-inbox-block]')?.textContent.includes('You blocked this person'));
  out.secondText=await text(page);
  out.secondCalls=await page.evaluate(()=>window.__calls);
  await page.close();
 }
 // A refused block is said, and the person stays as they were.
 {
  const page=await open([{ok:true,blocked:false},{ok:false,error:'many'}]);
  await until(page,()=>Boolean(document.querySelector('summary')));
  await press(page,'summary');
  await press(page,'[data-inbox-block] button[type=submit]');
  await until(page,()=>document.querySelector('[data-inbox-block] [role=status]')?.textContent.length>0);
  out.refused=await page.evaluate(()=>document.querySelector('[data-inbox-block] [role=status]')?.textContent??'');
  out.refusedText=await text(page);
  await page.close();
 }
} finally { await browser?.close(); }
console.log(JSON.stringify(out));
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  outside: number;
  openText: string;
  heights: boolean[];
  blockedText: string;
  blockedHeights: boolean[];
  live: string;
  afterText: string;
  calls: Record<string, unknown>[];
  unknownText: string;
  secondText: string;
  secondCalls: Record<string, unknown>[];
  refused: string;
  refusedText: string;
};

is("no page error and nothing reached outside", [result.errors, result.outside], [[], 0]);
is("not blocked: the summary offers to block", result.openText.includes("Block this person"), true);
is("and says what still reaches the creator", /order they paid for/.test(result.openText), true);
is("every control at least 44 px tall (min-h-11, as tests/tap-targets.test.ts reads it)", result.heights.length > 0 && result.heights.every(Boolean), true);
is("blocked: said, with the creator's note", [result.blockedText.includes("You blocked this person"), result.blockedText.includes("Insults in every message")], [true, true]);
is("blocked: its controls at least 44 px tall", result.blockedHeights.length > 0 && result.blockedHeights.every(Boolean), true);
is("the result said in the live region", result.live.length > 0, true);
is("undone: offered again", result.afterText.includes("Block this person"), true);
is("the route was asked: check, block with the note, unblock", result.calls, [
  { action: "blocked", id: "abcdefabcdef" },
  { action: "block", id: "abcdefabcdef", reason: "Insults in every message" },
  { action: "unblock", id: "abcdefabcdef" },
]);
is("not known: said so, never as not blocked", [result.unknownText.includes("could not check"), result.unknownText.includes("Block this person")], [true, false]);
is("checked again on request", [result.secondText.includes("Spam"), result.secondCalls.length], [true, 2]);
is("a refused block is said", result.refused.length > 0, true);
is("and the person stays not blocked", [result.refusedText.includes("You blocked this person"), result.refusedText.includes("Block this person")], [false, true]);

done();
