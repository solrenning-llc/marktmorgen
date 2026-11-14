/**
 * When "Yes, remove" (components/confirm-action.tsx) takes away the very item it sat in, the question and its
 * button go with it, and the browser dropped the focus to the page body (WCAG 2.4.3): every confirmed removal from
 * a list of the studio (saved replies, payment requests, outreach drafts, …) sent a keyboard or screen reader user
 * back to the top of the page. Now, once the item is gone, the focus goes to the first control of the item now
 * after it, or of the one before it when it was the last; nothing moves when the item stays (the focus goes back
 * to the button that opened the question, as before) or when the focus is already somewhere else.
 * Checked in local Chromium with the real code.
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
 'function Host(){',
 ' const [items,setItems]=useState(["Alpha","Beta","Gamma"]);',
 ' const [kept,setKept]=useState(0);',
 ' return React.createElement("div",null,',
 '  React.createElement("ul",null,items.map(name=>React.createElement("li",{key:name},React.createElement("span",null,name),',
 '   React.createElement(ConfirmAction,{label:"Remove "+name,question:"Remove "+name+"?",yes:"Yes, remove",onConfirm:async()=>{await new Promise(r=>setTimeout(r,20));setItems(all=>all.filter(x=>x!==name));}},"Remove")))),',
 '  React.createElement("p",null,React.createElement(ConfirmAction,{label:"Archive",question:"Archive it?",yes:"Yes, archive",onConfirm:async()=>{setKept(k=>k+1);}},"Archive")));',
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
 await page.waitForSelector('li');
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?(a.getAttribute('aria-label')||(a.textContent||'').trim()||a.tagName):null;});
 const confirm=async(name)=>{
  await page.getByRole('button',{name,exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  return focused();
 };
 out.first=await confirm('Remove Alpha');
 out.last=await confirm('Remove Gamma');
 out.stays=await confirm('Archive');
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  first: string | null;
  last: string | null;
  stays: string | null;
};

is("no page error", result.errors, []);
is("removing the first item puts the focus on the item now after it", result.first, "Remove Beta");
is("removing the last item puts it on the one before", result.last, "Remove Beta");
is("an action that keeps its item gives the focus back to the button that opened the question", result.stays, "Archive");
done();
