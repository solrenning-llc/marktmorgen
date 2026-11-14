/**
 * handFocusOnAfterRemoval (lib/focus-when-drawn.ts) in local Chromium with the real code, on the funnel form's
 * questions (components/funnel-form-setup.tsx), one of the six lists of tests/list-removal-focus.test.ts: removing
 * a question puts the focus on the question now in its place, or the one before, and when the one left cannot be
 * removed (a form keeps one question), on "Add a question". Never on the page body (WCAG 2.4.3).
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
 'import {FunnelFormSetup} from "@/components/funnel-form-setup";',
 'const q=(label)=>({type:"short",label,required:false});',
 'function Host(){const [v,setV]=useState({fields:[q("One"),q("Two"),q("Three")],offerList:false});return React.createElement(FunnelFormSetup,{value:v,onChange:setV});}',
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
 await page.waitForSelector('[aria-label="Remove question 1"]');
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?(a.getAttribute('aria-label')||a.id||a.tagName):null;});
 const remove=async(n)=>{await page.getByRole('button',{name:'Remove question '+n,exact:true}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);return focused();};
 out.first=await remove(1);
 out.last=await remove(2);
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  first: string | null;
  last: string | null;
};

is("no page error", result.errors, []);
is("removing the first puts the focus on the question now in its place", result.first, "Remove question 1");
is("removing the last of two, the one left cannot go: the focus is on the button that adds one", result.last, "funnel-form-question-add");
done();
