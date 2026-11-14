/**
 * WCAG 4.1.3 (status messages) on the community: what a person just did is
 * answered by a line at the top of the page they come back to ("Write
 * something first.", "Posted.", ...), drawn by the server after the form was
 * sent. A role=status that is already there when a page loads is not read
 * out, so the line takes the keyboard's focus once when the page opens: a
 * screen reader reads it, once, and the next Tab goes on from there.
 *
 * Part 1 reads every community page that draws that line from the address
 * (?n=) and checks it uses the line that takes focus. Part 2 runs that line in
 * local Chromium with every request refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const PAGES = [
  "app/[handle]/community/page.tsx",
  "app/[handle]/community/post/[post]/page.tsx",
  "app/[handle]/community/you/page.tsx",
  "app/[handle]/community/search/page.tsx",
  "app/[handle]/community/events/page.tsx",
  "app/[handle]/community/events/[event]/page.tsx",
  "app/[handle]/community/messages/page.tsx",
  "app/[handle]/community/messages/[pair]/page.tsx",
];
for (const file of PAGES) {
  const source = readFileSync(file, "utf8");
  is(`${file}: the line after sending is not a plain role=status that loads unread`, /\{notice \? \(?\s*<p className=\{`cm-flash/.test(source), false);
  is(`${file}: it is the line that takes focus once`, /\{notice \? \(?\s*<CommunityFlash text=\{notice\.text\} warn=\{notice\.tone === "warn"\}/.test(source), true);
}

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {CommunityFlash} from "@/components/community-flash";',
 'createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement("nav",null,React.createElement("a",{href:"#x"},"Feed")),React.createElement("main",null,React.createElement(CommunityFlash,{text:"Write something first.",warn:true,className:"mb-5"}),React.createElement("button",{type:"button"},"Post"))));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;let out;
try{
 browser=await launch();
 const page=await browser.newPage();
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.evaluate(()=>{window.__focusCount=0;document.addEventListener('focusin',e=>{if(e.target.classList?.contains('cm-flash'))window.__focusCount++;});});
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
is("the line after sending runs in a browser", result !== null, true);
if (result) {
  is("when the page opens the keyboard's focus is on the line", result.first.text, "Write something first.");
  is("which still says it is a status", result.first.role, "status");
  is("and can take focus without being a Tab stop", result.first.tab, "-1");
  is("it keeps its look (warning, spacing)", /cm-flash/.test(result.first.classes) && /cm-flash-warn/.test(result.first.classes) && /mb-5/.test(result.first.classes), true);
  is("it takes focus once, also when React runs effects twice", result.first.count, 1);
  is("the next Tab goes on from there, to the page's next control", result.next, "Post");
}
done();
