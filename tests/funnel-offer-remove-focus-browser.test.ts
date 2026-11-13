/**
 * Removing an offer in the funnel editor (components/funnel-editor.tsx), in local Chromium with the real code;
 * every outside request is refused.
 *
 * The offer's Remove button went with the offer, and the browser dropped the focus to the page body: a keyboard or
 * screen reader user was sent back to the top of a long editor after every removal. WCAG 2.4.3 Focus Order; the
 * page editor already moves it (components/page-editor.tsx, remove). Now the focus goes to the Remove button of
 * the offer that took its place, or, when none is left after it, to the one before, or to the button that adds an
 * offer when none is left at all.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const shims={name:'shims',setup(b){
 b.onResolve({filter:/^next\/(navigation|link|image)$/},a=>({path:a.path,namespace:'shim'}));
 b.onLoad({filter:/.*/,namespace:'shim'},a=>({contents:a.path==='next/navigation'
  ?'export function useRouter(){return {refresh(){},push(){},replace(){}}} export function usePathname(){return "/studio"} export function useSearchParams(){return new URLSearchParams()}'
  :'import React from "react";export default function X({children,...p}){return React.createElement("'+(a.path==='next/image'?'img':'a')+'",p,children)}',
  loader:'js',resolveDir:root}));
}};
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {FunnelEditor} from "@/components/funnel-editor";',
 'const offerable=[{id:"p1",title:"Course",priceCents:4900},{id:"p2",title:"Workbook",priceCents:1900},{id:"p3",title:"Call",priceCents:9900}];',
 'createRoot(document.getElementById("root")).render(React.createElement(FunnelEditor,{owner:{id:"o1",title:"Ebook",priceCents:2900},initial:null,offerable,pictures:[],ownerPrice:"29"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',plugins:[shims]});
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
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?(a.getAttribute('aria-label')||(a.textContent||'').trim()||a.tagName):null;});
 const add=async()=>{await page.locator('button',{hasText:/^Add (the first offer|an offer)/}).click();};
 await add();await add();await add();
 out.count=await page.locator('[aria-label^="Remove offer"]').count();
 await page.getByRole('button',{name:'Remove offer 1',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(100);
 out.first=await focused();
 await page.getByRole('button',{name:'Remove offer 2',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(100);
 out.last=await focused();
 await page.getByRole('button',{name:'Remove offer 1',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.waitForTimeout(100);
 out.none=await focused();
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  count: number;
  first: string | null;
  last: string | null;
  none: string | null;
};

is("no page error", result.errors, []);
is("three offers to remove", result.count, 3);
is("removing the first puts the focus on the offer that took its place", result.first, "Remove offer 1");
is("removing the last puts it on the one before", result.last, "Remove offer 1");
is("removing the only one puts it on the button that adds an offer", result.none, "Add the first offer");
done();
