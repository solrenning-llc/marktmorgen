/**
 * WCAG 2.2.3 (no timing) on the confirmation toast (components/toast.tsx):
 * it stays until the person dismisses it, so nobody has to read it in time.
 * A new toast replaces the one showing (never a pile), the live region still
 * says each message once, and Dismiss (or Escape) closes it. The real Toaster
 * runs in local Chromium with every request refused.
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
 'import {Toaster, toast} from "@/components/toast";',
 'window.__toast=toast;',
 'createRoot(document.getElementById("root")).render(React.createElement(React.Fragment,null,React.createElement("button",{type:"button",id:"save"},"Save"),React.createElement(Toaster)));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out={};
try{
 browser=await launch();
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForTimeout(100);
 await page.evaluate(()=>window.__toast('Saved.'));
 await page.waitForTimeout(300);
 out.shown=await page.evaluate(()=>({boxes:document.querySelectorAll('.nb-toast').length,said:document.querySelector('[role=status][aria-live]')?.textContent}));
 await page.waitForTimeout(6500);
 out.later=await page.evaluate(()=>document.querySelectorAll('.nb-toast').length);
 await page.evaluate(()=>window.__toast('The link is copied.'));
 await page.waitForTimeout(300);
 out.replaced=await page.evaluate(()=>({boxes:document.querySelectorAll('.nb-toast').length,text:document.querySelector('.nb-toast')?.textContent,said:document.querySelector('[role=status][aria-live]')?.textContent}));
 await page.click('.nb-toast-close');
 await page.waitForTimeout(400);
 out.dismissed=await page.evaluate(()=>document.querySelectorAll('.nb-toast').length);
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 8_000_000 })) as { shown: { boxes: number; said: string }; later: number; replaced: { boxes: number; text: string; said: string }; dismissed: number };
is("a confirmation shows", result.shown.boxes, 1);
is("and the live region says it", result.shown.said, "Saved.");
is("it is still there after more than six seconds: it waits for the person", result.later, 1);
is("a new one replaces it, never a pile", result.replaced.boxes, 1);
is("showing the new words", result.replaced.text?.includes("The link is copied."), true);
is("which the live region says too", result.replaced.said, "The link is copied.");
is("Dismiss closes it", result.dismissed, 0);
done();
