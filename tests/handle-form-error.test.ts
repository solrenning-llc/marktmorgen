/**
 * WCAG 3.3.1 (error identification) and 2.4.3 on the form that makes a store:
 * when the server refuses the address (taken, reserved or the wrong shape),
 * the address field is marked invalid and points to the words that say why
 * and what to do (aria-invalid, aria-describedby), and the keyboard goes back
 * to that field, instead of being left on nothing while the button was busy.
 * A refusal that is not about the address puts the keyboard back on the
 * button. The real form runs in local Chromium; the claim is answered by a
 * stand-in, and every other request is refused.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const form=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {HandleForm} from "@/components/handle-form";',
 'createRoot(document.getElementById("root")).render(React.createElement(HandleForm,{}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out={};
try{
 browser=await launch();
 for(const answer of ['taken','unavailable']){
  const page=await browser.newPage();
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://synthetic.test')return route.abort();if(u.pathname==='/studio/new')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="en"><body><main id="root"></main></body></html>'});if(u.pathname==='/api/store/claim')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:answer})});return route.abort();});
  await page.goto('http://synthetic.test/studio/new');
  await page.addScriptTag({content:form.outputFiles[0].text});
  await page.locator('#store-handle').waitFor();
  await page.fill('#store-handle','synthetic-shop');
  await page.fill('#store-name','Synthetic Shop');
  await page.click('button[type=submit]');
  await page.locator('[role=alert]').waitFor();
  await page.waitForTimeout(100);
  out[answer]=await page.evaluate(()=>{const f=document.getElementById('store-handle'),a=document.activeElement;const ids=(f.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);return {alert:document.querySelector('[role=alert]').textContent.trim(),invalid:f.getAttribute('aria-invalid'),described:ids.map(id=>document.getElementById(id)?.textContent?.trim()||''),focus:a===f?'field':a?.tagName==='BUTTON'?'button':a?.tagName||'none'};});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000 })) as Record<string, { alert: string; invalid: string | null; described: string[]; focus: string }>;
const taken = result.taken;
is("a taken address is said in words", taken.alert, "Someone already has that address. Pick another one.");
is("the address field is marked invalid", taken.invalid, "true");
is("the field points to those words", taken.described.includes(taken.alert), true);
is("the keyboard goes back to the address field", taken.focus, "field");
const other = result.unavailable;
is("a refusal not about the address leaves the field unmarked", other.invalid, null);
is("and puts the keyboard back on the button", other.focus, "button");
done();
