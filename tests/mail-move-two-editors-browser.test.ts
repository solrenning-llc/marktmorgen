/**
 * Review of #3795, in local Chromium with the real code: a sequence draws one MailBodyEditor per email step on
 * one page (components/email-studio.tsx). Two editors are drawn side by side, both in Design: no id may repeat,
 * and moving a block in the second email keeps the keyboard focus in the second email, on the moved block's
 * button (WCAG 2.2 2.4.3 and 4.1.1's valid ids). Every outside request is refused.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const page_=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {MailBodyEditor} from "@/components/mail-designer";',
 'function Two(){const [a,setA]=React.useState("First line.\\n\\nSecond line.\\n\\nThird line.");const [b,setB]=React.useState("Step two, first.\\n\\nStep two, second.\\n\\nStep two, third.");',
 ' return React.createElement("div",null,React.createElement("section",{id:"s1"},React.createElement(MailBodyEditor,{body:a,onChange:setA,label:"Email 1"})),React.createElement("section",{id:"s2"},React.createElement(MailBodyEditor,{body:b,onChange:setB,label:"Email 2"})));}',
 'createRoot(document.getElementById("root")).render(React.createElement(Two));'
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
 const page=await browser.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.abort());
 await page.setContent('<div id="root"></div>');
 await page.addScriptTag({content:page_.outputFiles[0].text});
 for(const s of ['#s1','#s2']){await page.locator(s).getByRole('button',{name:'Design',exact:true}).click();}
 await page.locator('#s2').getByRole('button',{name:'Move block 1 down'}).waitFor();
 const ids=await page.evaluate(()=>[...document.querySelectorAll('[id]')].map(e=>e.id));
 const dupes=ids.filter((id,i)=>ids.indexOf(id)!==i);
 await page.locator('#s2').getByRole('button',{name:'Move block 1 down'}).focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(150);
 const after=await page.evaluate(()=>{const a=document.activeElement;return {inS2:!!a.closest('#s2'),inS1:!!a.closest('#s1'),name:a.getAttribute('aria-label')||''};});
 console.log(JSON.stringify({dupes,after,errors}));
} finally { await browser?.close(); }
`;

let result: { dupes: string[]; after: { inS2: boolean; inS1: boolean; name: string }; errors: string[] } | null = null;
try {
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120000 }).trim().split("\n").pop() ?? "null");
} catch (error) {
  console.error(String(error).slice(0, 600));
}
is("the two editors drew in Chromium", result !== null && result.errors.length === 0, true);
is("no id repeats across the two editors", result?.dupes.length, 0);
is("a move in the second email keeps the focus in the second email", result?.after.inS2 === true && result.after.inS1 === false, true);
is("the focus is on the moved block's Move down button", result?.after.name, "Move block 2 down");

done();
