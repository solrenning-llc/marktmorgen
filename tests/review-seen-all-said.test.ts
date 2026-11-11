/**
 * VR (owner, 25/10/2026, Part A item 2), found by Claude 4 on 11/11/2026 by
 * pressing every studio button with each write refused: "Mark all N as seen"
 * on the studio's reviews (components/review-studio.tsx, SeenAllButton)
 * dropped the problem post() gave back, so a refused or failed press said
 * nothing at all and the button simply came back. In local Chromium with the
 * real component, every request answered here and nothing outside reached:
 *   - refused (the store's answer, and a dropped connection): the reason is
 *     said in an alert beside the button, and the button stays;
 *   - accepted: no alert, and the studio is refreshed as before.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

// Resolve browser/build tools at runtime rather than bundling their internals into this test (as tests/checkout-focus-browser.test.ts).
const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
// next/navigation is the app's; here a router whose refresh is counted.
const shell={name:'router-shell',setup(b){b.onResolve({filter:/^next\/navigation$/},()=>({path:'nav',namespace:'shell'}));b.onLoad({filter:/.*/,namespace:'shell'},()=>({contents:'export function useRouter(){return {refresh(){window.__refreshed=(window.__refreshed||0)+1;},push(){},replace(){}};}',loader:'js'}));}};
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {SeenAllButton} from "@/components/review-studio";',
 'createRoot(document.getElementById("root")).render(React.createElement(SeenAllButton,{count:3}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,plugins:[shell],alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
let browser;
const out={errors:[],outside:0};
try {
 browser=await launch();
 for(const answer of ['refused','dropped','accepted']){
  const page=await browser.newPage();
  page.on('pageerror',error=>out.errors.push(error.message));
  let asked=0;
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://studio.test'){out.outside++;return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
   if(url.pathname==='/api/store/reviews'&&route.request().method()==='POST'){
    asked++;
    if(answer==='dropped')return route.abort('connectionreset');
    if(answer==='refused')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'unavailable'})});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})});
   }
   return route.abort();
  });
  await page.goto('https://studio.test/');
  await page.addScriptTag({content:app.outputFiles[0].text});
  const button=page.getByRole('button',{name:'Mark all 3 as seen'});
  await button.waitFor();
  await button.click();
  await page.waitForFunction(()=>!document.querySelector('button[disabled]'));
  await page.waitForTimeout(100);
  out[answer]={asked,alert:(await page.getByRole('alert').allTextContents()).map(t=>t.trim()).filter(Boolean),button:await button.count(),refreshed:await page.evaluate(()=>window.__refreshed||0)};
  await page.close();
 }
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

type Seen = { asked: number; alert: string[]; button: number; refreshed: number };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as Record<"refused" | "dropped" | "accepted", Seen> & { errors: string[]; outside: number };

is("each press asks the store once", [result.refused.asked, result.dropped.asked, result.accepted.asked], [1, 1, 1]);
is("refused by the store: the reason is said in an alert, and the button stays to try again", [result.refused.alert.length, result.refused.alert.every((t) => t.length > 10), result.refused.button, result.refused.refreshed], [1, true, 1, 0]);
is("the connection dropped: said the same way", [result.dropped.alert.length, result.dropped.button, result.dropped.refreshed], [1, 1, 0]);
is("accepted: nothing to say as an error, and the studio is read again as before", [result.accepted.alert, result.accepted.refreshed], [[], 1]);
is("nothing outside the synthetic page was asked", result.outside, 0);
is("no browser error", result.errors, []);
done();
