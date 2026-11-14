/**
 * The shared "are you sure" (components/confirm-action.tsx), in local Chromium with the real code.
 *
 * While "Yes, …" waited on its answer it was disabled, and a disabled button cannot keep the focus: the browser
 * dropped it to the page body, so a keyboard or screen reader user pressing Yes was sent back to the top of the
 * page, with nothing said, during every save. WCAG 2.4.3 Focus Order; WAI-ARIA Authoring Practices, "Developing a
 * Keyboard Interface" (read November 13, 2026): keep focusable a control that is temporarily unavailable, marked
 * aria-disabled. Here Yes stays focusable and busy (aria-disabled and aria-busy), a second press while it waits
 * does nothing, and when the question closes the focus goes back to the button that opened it.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const app=await build({stdin:{contents:[
 'import React, {useState} from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {ConfirmAction} from "@/components/confirm-action";',
 'window.__calls=0;window.__release=null;',
 'function Host(){',
 ' const [busy,setBusy]=useState(false);',
 ' return React.createElement(ConfirmAction,{busy,disabled:busy,question:"Remove the thing?",yes:"Yes, remove",onConfirm:async()=>{window.__calls++;setBusy(true);await new Promise(r=>{window.__release=r;});setBusy(false);}},"Remove");',
 '}',
 'createRoot(document.getElementById("root")).render(React.createElement(Host));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}
}
let browser;
try{
 browser=await launch();
 const page=await browser.newPage();
 const out={errors:[]};
 page.on('pageerror',e=>out.errors.push(e.message));
 await page.route('**/*',r=>r.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.addScriptTag({content:app.outputFiles[0].text});
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?{tag:a.tagName,text:(a.textContent||'').trim(),busy:a.getAttribute('aria-busy'),off:a.getAttribute('aria-disabled')}:null;});
 await page.getByRole('button',{name:'Remove',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.waitForSelector('[data-confirm-action]');
 out.asked=await focused();
 await page.keyboard.press('Shift+Tab');
 out.onYes=await focused();
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__calls===1&&window.__release);
 await page.waitForTimeout(50);
 out.waiting=await focused();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(50);
 out.calls=await page.evaluate(()=>window.__calls);
 await page.evaluate(()=>window.__release());
 await page.waitForFunction(()=>!document.querySelector('[data-confirm-action]'));
 await page.waitForTimeout(50);
 out.after=await focused();
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

type Focus = { tag: string; text: string; busy: string | null; off: string | null } | null;
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  asked: Focus;
  onYes: Focus;
  waiting: Focus;
  calls: number;
  after: Focus;
};

is("no page error", result.errors, []);
is("the question puts the focus on Keep it", result.asked?.text, "Keep it");
is("Shift+Tab reaches Yes", result.onYes?.text, "Yes, remove");
is("while it waits, the focus stays on Yes, said to be busy and unavailable", [result.waiting?.tag, result.waiting?.text, result.waiting?.busy, result.waiting?.off], ["BUTTON", "Yes, remove", "true", "true"]);
is("a second press while it waits does nothing", result.calls, 1);
is("when it is done, the focus is back on the button that opened it", [result.after?.tag, result.after?.text], ["BUTTON", "Remove"]);
done();
