/**
 * The studio's buttons that wait on the server were disabled while they waited, and a disabled button cannot keep
 * the focus: the browser dropped it to the page body on every save, so a keyboard or screen reader user was sent
 * back to the top of the page each time (WCAG 2.4.3). 442 such buttons in 151 files on 13 November 2026
 * (docs/busy-button-migration-2026-11-13.md).
 *
 * BusyButton (components/busy-button.tsx) is the one way to wait: aria-disabled and aria-busy instead of disabled,
 * so the focus stays on it; a click or Enter while it waits does nothing (no second save); and what it says while
 * it waits is said once in a status region (4.1.3), in the button's own words. WAI-ARIA Authoring Practices,
 * "Developing a Keyboard Interface" (read November 13, 2026): keep focusable a control that is temporarily
 * unavailable. Checked here in local Chromium with the real code.
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
 'import {BusyButton} from "@/components/busy-button";',
 'window.__calls=0;window.__submits=0;window.__release=null;',
 'function Host(){',
 ' const [busy,setBusy]=useState(false);',
 ' const [sending,setSending]=useState(false);',
 ' return React.createElement("div",null,',
 '  React.createElement(BusyButton,{busy,className:"btn",onClick:async()=>{window.__calls++;setBusy(true);await new Promise(r=>{window.__release=r;});setBusy(false);}},busy?"Saving…":"Save"),',
 '  React.createElement("form",{onSubmit:(e)=>{e.preventDefault();window.__submits++;setSending(true);}},',
 '   React.createElement("input",{"aria-label":"Name"}),',
 '   React.createElement(BusyButton,{type:"submit",busy:sending,announce:false,className:"btn"},sending?"Sending…":"Send")));',
 '}',
 'createRoot(document.getElementById("root")).render(React.createElement(Host));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env':JSON.stringify({NODE_ENV:'production'})},logLevel:'error'});
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
 await page.waitForSelector('button');
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?{tag:a.tagName,text:(a.textContent||'').trim(),busy:a.getAttribute('aria-busy'),off:a.getAttribute('aria-disabled'),disabled:a.disabled===true}:null;});
 await page.getByRole('button',{name:'Save'}).focus();
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__release);
 await page.waitForTimeout(50);
 out.waiting=await focused();
 out.status=await page.evaluate(()=>[...document.querySelectorAll('[role=status]')].map(s=>(s.textContent||'').trim()).filter(Boolean));
 await page.keyboard.press('Enter');
 await page.mouse.click(...await page.evaluate(()=>{const r=document.activeElement.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];}));
 await page.waitForTimeout(50);
 out.calls=await page.evaluate(()=>window.__calls);
 await page.evaluate(()=>window.__release());
 await page.waitForTimeout(50);
 out.after=await focused();
 await page.getByRole('button',{name:'Send'}).focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(50);
 out.sendWaiting=await focused();
 out.quiet=await page.evaluate(()=>[...document.querySelectorAll('[role=status]')].map(s=>(s.textContent||'').trim()).filter(Boolean));
 await page.keyboard.press('Enter');
 await page.getByLabel('Name').focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(50);
 out.submits=await page.evaluate(()=>window.__submits);
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

type Focus = { tag: string; text: string; busy: string | null; off: string | null; disabled: boolean } | null;
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  waiting: Focus;
  status: string[];
  calls: number;
  after: Focus;
  sendWaiting: Focus;
  quiet: string[];
  submits: number;
};

is("no page error", result.errors, []);
is("while it waits, the focus stays on it, busy and unavailable but not disabled", result.waiting, { tag: "BUTTON", text: "Saving…", busy: "true", off: "true", disabled: false });
is("what it says while it waits is said in a status region", result.status, ["Saving…"]);
is("Enter and a click while it waits do nothing more", result.calls, 1);
is("when it is done, it is back as it was, with the focus", result.after, { tag: "BUTTON", text: "Save", busy: null, off: null, disabled: false });
is("a submit button keeps the focus while its form is sent", [result.sendWaiting?.text, result.sendWaiting?.disabled], ["Sending…", false]);
is("and the form is not sent again by Enter on the button or in a field", result.submits, 1);
is("announce={false}: a page that says it already is not said twice", result.quiet, []);
done();
