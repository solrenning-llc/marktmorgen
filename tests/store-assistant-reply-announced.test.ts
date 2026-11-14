/**
 * The Store assistant's chat (components/store-assistant.tsx), with a screen
 * reader and a keyboard (AX274 item 5, the AI assistant's answers):
 * - WCAG 4.1.3: the reply is said once, under its "AI assistant" label, and
 *   nothing else: not the buyer's own question again, nor the earlier
 *   conversation when a kept one comes back. The whole thread was the live
 *   region, so every turn put in it was read out.
 * - WCAG 2.4.3: asking from the keyboard keeps the focus on Ask while the
 *   reply is on its way. The button was disabled while it waited, which drops
 *   the focus to the page.
 * The real component in local Chromium; the server is a synthetic answer.
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
 'import {StoreAssistant} from "@/components/store-assistant";',
 'createRoot(document.getElementById("root")).render(React.createElement(StoreAssistant,{handle:"harbor",storeName:"Harbor Kitchen",language:"en"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
const TOKEN='a'.repeat(32);
const earlier=[{at:1,from:'buyer',text:'Do you ship to Canada?'},{at:2,from:'ai',text:'Yes, the store ships to Canada.',status:'answer'}];
let browser;const out={};
try{
 browser=await launch();
 const page=await browser.newPage();
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.endsWith('/api/store/assistant')){
   const body=JSON.parse(route.request().postData()||'{}');
   if(body.action==='read') return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,thread:{token:TOKEN,turns:earlier}})});
   await new Promise(r=>setTimeout(r,600));
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,thread:{token:TOKEN,turns:[...earlier,{at:3,from:'buyer',text:body.text},{at:4,from:'ai',text:'The course has 12 lessons.',status:'answer'}]}})});
  }
  if(url==='http://shop.test/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
  return route.abort();
 });
 await page.goto('http://shop.test/');
 await page.evaluate((t)=>localStorage.setItem('mm-assist:harbor',t),TOKEN);
 await page.evaluate(()=>{
  window.__said=[];
  new MutationObserver(list=>{for(const m of list){const nodes=m.type==='characterData'?[m.target]:[...m.addedNodes];for(const n of nodes){const el=n.nodeType===1?n:n.parentElement;const region=el?.closest('[aria-live]:not([aria-live=off]),[role=status],[role=log],[role=alert]');if(region){const t=(n.textContent||'').trim();if(t)window.__said.push(t);}}}}).observe(document,{subtree:true,childList:true,characterData:true});
 });
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForTimeout(200);
 await page.click('button[aria-expanded]');
 await page.waitForTimeout(500);
 out.onOpen=await page.evaluate(()=>window.__said.join(' | '));
 await page.evaluate(()=>{window.__said=[];});
 await page.fill('textarea','How many lessons does the course have?');
 await page.focus('form button[type=submit]');
 await page.keyboard.press('Enter');
 await page.waitForTimeout(250);
 out.waiting=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
 await page.waitForTimeout(900);
 out.after=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
 out.said=await page.evaluate(()=>window.__said.join(' | '));
 out.shown=await page.evaluate(()=>document.querySelector('[data-assistant-thread]')?.textContent);
 await page.getByRole('button',{name:'Delete this chat'}).click();
 await page.waitForTimeout(300);
 out.afterDelete=await page.evaluate(()=>document.querySelector('[data-assistant-said]')?.textContent??'');
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;
type Result = { afterDelete: string; onOpen: string; waiting: { tag: string; text: string }; after: { tag: string; text: string }; said: string; shown: string };
let result: Result | null = null;
try {
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 8_000_000 })) as Result;
} catch {
  result = null;
}
is("the chat runs in a browser", result !== null, true);
if (result) {
  is("the conversation is still shown whole", ["Do you ship to Canada?", "How many lessons does the course have?", "The course has 12 lessons."].every((t) => result!.shown.includes(t)), true);
  is("a kept conversation coming back is not read out again", /Canada/.test(result.onOpen), false);
  is("the reply is said, under its label", /AI assistant\W+The course has 12 lessons\./.test(result.said), true);
  is("and said once", result.said.split("The course has 12 lessons.").length - 1, 1);
  is("the buyer's own question is not read back", /How many lessons/.test(result.said), false);
  is("while the reply is on its way the focus stays on Ask (2.4.3)", [result.waiting.tag, result.waiting.text], ["BUTTON", "Ask"]);
  is("and is still on Ask once it has come", [result.after.tag, result.after.text], ["BUTTON", "Ask"]);
  is("once the chat is deleted, the last reply is no longer in the status region", result.afterDelete, "");
}
done();
