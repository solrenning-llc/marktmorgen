/**
 * "Send it again" on the appeals screen (components/takedown-appeal-form.tsx, TakedownAppealSendAgain; 646 [WG6]) never
 * drops the focus (WCAG 2.2 SC 2.4.3), in local Chromium with the real component and a synthetic answer; nothing
 * leaves the page. Claude 3 cloud P's MEDIUM on #3533 (6872079635), still open at cdb9ee5826 per cloud O (6916715754):
 * the button was `disabled` while it had the focus, so the focus fell to the page, and it was removed on success with
 * nothing taking the focus.
 *  - While sending, the button keeps the focus (aria-disabled, presses ignored), and a second press sends nothing more.
 *  - On a failure, the focus is still on the button, which reads "Send it again" again.
 *  - On success, the focus is on the outcome, and the line saying it was not passed on is gone.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {TakedownAppealSendAgain} from "@/components/takedown-appeal-form";',
 'createRoot(document.getElementById("root")).render(React.createElement(TakedownAppealSendAgain,{decision:"d1",number:"A-1"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
let browser;
try {
 browser=await launch();
 const out={errors:[],outside:0};
 for(const ending of ['failed','sent']){
  const page=await browser.newPage();
  await page.route('**/*',route=>{out.outside++;return route.abort();});
  page.on('pageerror',error=>out.errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  // A synthetic answer the test releases, so the screen can be read while the request is on its way.
  await page.evaluate(()=>{window.__calls=0;window.fetch=()=>{window.__calls++;return new Promise(r=>{window.__answer=r;});};});
  await page.addScriptTag({content:app.outputFiles[0].text});
  const button=page.getByRole('button',{name:'Send it again'});
  await button.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__calls===1);
  const during=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const calls=await page.evaluate(()=>window.__calls);
  await page.evaluate((ok)=>window.__answer(new Response(JSON.stringify(ok?{ok:true,told:true}:{error:'unsent',message:'We could not pass it on just now. Try again in a moment.'}),{status:ok?200:503,headers:{'Content-Type':'application/json'}})),ending==='sent');
  await page.waitForFunction(()=>(document.querySelector('[role=status]')?.textContent??'').length>0);
  await page.waitForTimeout(50);
  const after=await page.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute('role'),text:document.activeElement?.textContent,notPassed:document.body.textContent.includes('We could not pass this request on to our team yet.')}));
  out[ending]={during,calls,after};
  await page.close();
 }
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

type Seen = { tag?: string; role?: string | null; text?: string; notPassed?: boolean };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  failed: { during: Seen; calls: number; after: Seen };
  sent: { during: Seen; calls: number; after: Seen };
  errors: string[];
  outside: number;
};
is("while sending, the button keeps the focus (2.4.3)", [result.failed.during.tag, result.sent.during.tag], ["BUTTON", "BUTTON"]);
is("and a second press while sending sends nothing more", [result.failed.calls, result.sent.calls], [1, 1]);
is("on a failure the focus is still on the button, ready to try again", [result.failed.after.tag, result.failed.after.text], ["BUTTON", "Send it again"]);
is("on success the focus is on the outcome", [result.sent.after.tag, result.sent.after.role, result.sent.after.text], ["P", "status", "Request A-1 is passed on to our team."]);
is("and the line saying it was not passed on is gone", result.sent.after.notPassed, false);
is("nothing left the page", result.outside, 0);
is("no browser error", result.errors, []);
done();
