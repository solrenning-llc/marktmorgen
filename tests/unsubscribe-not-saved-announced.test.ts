/**
 * WCAG 4.1.3 (status messages) on the unsubscribe page: when the last press
 * was not saved (?done=0), the page comes back with "not saved" and the button
 * again. That line was a role=status already there when the page loaded, which
 * a screen reader does not read out. Like the community's line after sending
 * (components/community-flash.tsx), it now takes the keyboard's focus once
 * when the page opens, is read once, and the next Tab goes on to the button.
 *
 * Part 1 reads app/unsubscribe/page.tsx: each of its three "not saved" lines
 * (the list, review requests, community announcements) is the line that takes
 * focus. Part 2 runs that line in local Chromium with every request refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const source = readFileSync("app/unsubscribe/page.tsx", "utf8");
is("no 'not saved' line is a plain role=status that loads unread", (source.match(/<p role="status"[^>]*>\{notSaved \? a\.reviewsNotSaved/g) ?? []).length, 0);
is("all three are the line that takes focus once", (source.match(/\{notSaved \? <FocusedStatus text=\{a\.reviewsNotSaved\} className="mt-3 font-semibold" \/> : null\}/g) ?? []).length, 3);

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {FocusedStatus} from "@/components/community-flash";',
 'createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement("main",null,React.createElement("h1",null,"Stop emails from Harbor Kitchen?"),React.createElement(FocusedStatus,{text:"That was not saved. Please press the button again.",className:"mt-3 font-semibold"}),React.createElement("button",{type:"submit"},"Unsubscribe"))));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;let out;
try{
 browser=await launch();
 const page=await browser.newPage();
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.evaluate(()=>{window.__focusCount=0;document.addEventListener('focusin',e=>{if(e.target.getAttribute?.('role')==='status')window.__focusCount++;});});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForTimeout(300);
 const first=await page.evaluate(()=>{const a=document.activeElement;return {text:a?.textContent,role:a?.getAttribute('role'),tab:a?.getAttribute('tabindex'),classes:a?.className,count:window.__focusCount};});
 await page.keyboard.press('Tab');
 const next=await page.evaluate(()=>document.activeElement?.textContent);
 out={first,next};
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;
let result: { first: { text: string; role: string; tab: string; classes: string; count: number }; next: string } | null = null;
try {
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 }));
} catch {
  result = null;
}
is("the 'not saved' line runs in a browser", result !== null, true);
if (result) {
  is("when the page opens the keyboard's focus is on the line", result.first.text, "That was not saved. Please press the button again.");
  is("which still says it is a status", result.first.role, "status");
  is("and can take focus without being a Tab stop", result.first.tab, "-1");
  is("it keeps the page's look, not the community's", [/mt-3/.test(result.first.classes) && /font-semibold/.test(result.first.classes), /cm-flash/.test(result.first.classes)], [true, false]);
  is("it takes focus once, also when React runs effects twice", result.first.count, 1);
  is("the next Tab goes on to the button", result.next, "Unsubscribe");
}
done();
