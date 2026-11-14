/**
 * The chat with the creator on a store's pages (components/store-chat.tsx),
 * with a screen reader and a keyboard (AX274 item 5):
 * - WCAG 4.1.3: an answer from the store is said once, with the store's name,
 *   when it comes; the visitor's own message is not read back to them, and a
 *   conversation coming back when the chat opens is not read out whole. The
 *   whole thread was the live region, so every message put in it was read.
 * - WCAG 2.4.3: sending from the keyboard keeps the focus on Send while it
 *   goes. The button was disabled while it waited, which drops the focus to
 *   the page.
 * The real component in local Chromium, its 20-second check for an answer run
 * on a fake clock; the server is a synthetic answer.
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
 'import {StoreChat} from "@/components/store-chat";',
 'createRoot(document.getElementById("root")).render(React.createElement(StoreChat,{handle:"harbor",storeName:"Harbor Kitchen",language:"en"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
const TOKEN='b'.repeat(32);
let messages=[{at:1,from:'visitor',text:'Is the knife course good for beginners?'},{at:2,from:'store',text:'Yes, it starts from the very first cut.'}];
let browser;const out={};
try{
 browser=await launch();
 const page=await browser.newPage();
 await page.clock.install();
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.endsWith('/api/store/chat')){
   const body=JSON.parse(route.request().postData()||'{}');
   if(body.action==='send'){await new Promise(r=>setTimeout(r,600));messages=[...messages,{at:3,from:'visitor',text:body.text}];}
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,thread:{token:TOKEN,status:'open',messages}})});
  }
  if(url==='http://shop.test/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
  return route.abort();
 });
 await page.goto('http://shop.test/');
 await page.evaluate((t)=>{try{localStorage.setItem('mm-chat:harbor',t);}catch{}},TOKEN);
 const key=await page.evaluate(()=>Object.keys(localStorage));
 await page.evaluate(()=>{
  window.__said=[];
  new MutationObserver(list=>{for(const m of list){const nodes=m.type==='characterData'?[m.target]:[...m.addedNodes];for(const n of nodes){const el=n.nodeType===1?n:n.parentElement;const region=el?.closest('[aria-live]:not([aria-live=off]),[role=status],[role=log],[role=alert]');if(region){const t=(n.textContent||'').trim();if(t)window.__said.push(t);}}}}).observe(document,{subtree:true,childList:true,characterData:true});
 });
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.clock.runFor(200);
 await page.click('button[aria-expanded]');
 await page.clock.runFor(100);
 await page.waitForTimeout(300);
 await page.clock.runFor(100);
 out.storageKeys=key;
 out.onOpen=await page.evaluate(()=>window.__said.join(' | '));
 out.shownOnOpen=await page.evaluate(()=>document.querySelector('[data-chat-thread]')?.textContent||'');
 await page.evaluate(()=>{window.__said=[];});
 await page.fill('textarea','Does it come with a certificate?');
 await page.focus('form button[type=submit]');
 await page.keyboard.press('Enter');
 await page.waitForTimeout(250);
 out.waiting=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
 await page.waitForTimeout(900);
 await page.clock.runFor(100);
 out.afterSend=await page.evaluate(()=>window.__said.join(' | '));
 out.after=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
 await page.evaluate(()=>{window.__said=[];});
 messages=[...messages,{at:4,from:'store',text:'It does, once every lesson is done.'}];
 await page.clock.runFor(21000);
 await page.waitForTimeout(400);
 await page.clock.runFor(100);
 out.answer=await page.evaluate(()=>window.__said.join(' | '));
 await page.evaluate(()=>{window.__said=[];});
 await page.clock.runFor(21000);
 await page.waitForTimeout(400);
 await page.clock.runFor(100);
 out.again=await page.evaluate(()=>window.__said.join(' | '));
 out.shown=await page.evaluate(()=>document.querySelector('[data-chat-thread]')?.textContent||'');
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;
type Focus = { tag: string; text: string };
type Result = { onOpen: string; shownOnOpen: string; waiting: Focus; afterSend: string; after: Focus; answer: string; again: string; shown: string };
let result: Result | null = null;
try {
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000 })) as Result;
} catch (error) {
  console.log(String(error).slice(0, 2000));
  result = null;
}
is("the chat runs in a browser", result !== null, true);
if (result) {
  is("the kept conversation is shown when the chat opens", result.shownOnOpen.includes("Yes, it starts from the very first cut."), true);
  is("but not read out whole", /beginners|very first cut/.test(result.onOpen), false);
  is("the visitor's own message is not read back", /certificate\?/.test(result.afterSend), false);
  is("while it goes, the focus stays on Send (2.4.3)", [result.waiting.tag, result.waiting.text], ["BUTTON", "Send"]);
  is("and is still on Send once it has gone", [result.after.tag, result.after.text], ["BUTTON", "Send"]);
  is("the store's answer is said when it comes, with the store's name", /Harbor Kitchen\W+It does, once every lesson is done\./.test(result.answer), true);
  is("once: the next check says nothing again", result.again, "");
  is("and the conversation shows all of it", ["beginners", "certificate?", "It does, once every lesson is done."].every((t) => result!.shown.includes(t)), true);
}
done();
