/**
 * Claude 3's review proof for PR #3138 (654 [WG14] b1; evidence branch 86bb10c1,
 * tests/c3-review-proofs/r3138-proof.test.ts.txt, SHA-256 5d673b04...ef2a), kept as this unit's browser test. Real
 * component bundled for the browser, real localStorage in local Chromium, every outside request refused.
 *
 * One change to it: in F3, a browser that can read but not write never shows the card at all (the write is tested
 * when reading, the fix Claude 3 suggested), as with blocked storage, since it could not be shown only once; so the
 * first visit's control expects no card instead of the card.
 */
import { execFileSync } from "node:child_process";
import { done, is, part } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {PathMilestone} from "@/components/path-milestone";',
 'const done=JSON.parse(document.body.dataset.done);',
 'createRoot(document.getElementById("root")).render(React.createElement(PathMilestone,{sid:"0123456789abcdef0123456789abcdef",done,shareHref:null}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
const js=bundle.outputFiles[0].text;
const T={id:'title',title:'Publish your title'},P={id:'product',title:'Add a product'},S={id:'sale',title:'Make your first real sale'};
const html=(list)=>'<!doctype html><html lang="en"><body data-done=\''+JSON.stringify(list)+'\'><button id="before">Before</button><div id="root"></div><button id="after">After</button><script>'+js.replace(/<\/script/g,'<\\/script')+'</script></body></html>';
async function launch(){const o={headless:true,args:['--no-sandbox']};try{return await chromium.launch(o);}catch(e){return chromium.launch({...o,channel:'chrome'});}}
const browser=await launch();
const out={errors:[]};
try{
 const open=async(ctx,list)=>{const page=await ctx.newPage();page.on('pageerror',e=>out.errors.push(e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin==='https://marktmorgen.test')return r.fulfill({contentType:'text/html',body:html(list)});return r.abort();});await page.goto('https://marktmorgen.test/studio/path');return page;};
 const title=(page)=>page.evaluate(()=>{const s=document.querySelector('[data-path-milestone]');return s?s.querySelector('p').textContent:null;});
 // 1. Focus after the last Dismiss, and what a screen reader is told after a Dismiss that shows the next step.
 {const ctx=await browser.newContext();const page=await open(ctx,[T,S]);await page.waitForSelector('[data-path-milestone]');
  await page.focus('[data-path-milestone] button');await page.keyboard.press('Enter');await page.waitForTimeout(50);
  out.afterFirst=await page.evaluate(()=>({title:document.querySelector('[data-path-milestone] p')?.textContent??null,focusIsDismiss:document.activeElement?.textContent==='Dismiss',live:document.querySelectorAll('[data-path-milestone] [role=status],[data-path-milestone] [aria-live],[data-path-milestone][aria-live]').length}));
  await page.keyboard.press('Enter');await page.waitForTimeout(50);
  out.afterLast=await page.evaluate(()=>({card:Boolean(document.querySelector('[data-path-milestone]')),active:document.activeElement===document.body?'body':(document.activeElement?.id||document.activeElement?.tagName)}));
  await page.keyboard.press('Tab');out.tabAfterLast=await page.evaluate(()=>document.activeElement?.id||document.activeElement?.tagName);
  await ctx.close();}
 // 2. Two tabs of the same store: a Dismiss in a tab read earlier overwrites the other tab's marks.
 {const ctx=await browser.newContext();const a=await open(ctx,[T,P,S]);const b=await open(ctx,[T,P,S]);await a.waitForSelector('[data-path-milestone]');await b.waitForSelector('[data-path-milestone]');
  await a.click('[data-path-milestone] button');await a.waitForTimeout(30);await a.click('[data-path-milestone] button');await a.waitForTimeout(30);
  out.tabsA=await a.evaluate(()=>localStorage.getItem('mm:pm:0123456789abcdef0123456789abcdef'));
  await b.click('[data-path-milestone] button');await b.waitForTimeout(30);
  out.tabsAfterB=await b.evaluate(()=>localStorage.getItem('mm:pm:0123456789abcdef0123456789abcdef'));
  await a.reload();await a.waitForTimeout(100);out.tabsReloadA=await title(a);
  await ctx.close();}
 // 3. Reading works, writing does not (a full localStorage): the same card on every visit.
 {const ctx=await browser.newContext();await ctx.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};});
  const page=await open(ctx,[T,S]);await page.waitForTimeout(100);out.quotaFirst=await title(page);
  if(out.quotaFirst){await page.click('[data-path-milestone] button');await page.waitForTimeout(30);}
  await page.reload();await page.waitForTimeout(100);out.quotaSecond=await title(page);
  await page.reload();await page.waitForTimeout(100);out.quotaThird=await title(page);
  await ctx.close();}
}finally{await browser.close();}
console.log(JSON.stringify(out));
`;

const r = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 4_000_000 })) as {
  errors: string[];
  afterFirst: { title: string | null; focusIsDismiss: boolean; live: number };
  afterLast: { card: boolean; active: string };
  tabAfterLast: string;
  tabsA: string | null;
  tabsAfterB: string | null;
  tabsReloadA: string | null;
  quotaFirst: string | null;
  quotaSecond: string | null;
  quotaThird: string | null;
};
console.log(JSON.stringify(r));

part("Control: the harness draws the real card");
is("no page errors", r.errors, []);
is("Dismiss shows the next step and keeps the focus on Dismiss", [r.afterFirst.title, r.afterFirst.focusIsDismiss], ["Make your first real sale", true]);

part("F1 (2.4.3, 4.1.3): focus and announcement after Dismiss");
is("after the last Dismiss the focus is not dropped to the page body", r.afterLast.active !== "body", true);
is("a Dismiss that shows the next step tells a screen reader (status or live region)", r.afterFirst.live > 0, true);

part("F2: Dismiss writes from what the page last read: each step once, and nothing another tab kept is lost");
is("one tab, two Dismiss: each step written once", r.tabsA, JSON.stringify(["title", "product"]));
is("a Dismiss in tab B keeps tab A's marks", JSON.parse(r.tabsAfterB ?? "[]").includes("product"), true);
is("so tab A, reloaded, does not show a step it dismissed", r.tabsReloadA !== "Add a product", true);

part("F3: when the browser cannot keep the mark, the card is not shown again and again");
is("not shown when the mark could not be kept, so never again and again", [r.quotaFirst, r.quotaSecond, r.quotaThird], [null, null, null]);

done();
