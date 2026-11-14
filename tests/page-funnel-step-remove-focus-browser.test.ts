/**
 * Removing a step of a funnel of pages (components/page-funnel-editor.tsx), in local Chromium with the real code;
 * every outside request is refused.
 *
 * The step's Remove button went with it and the browser dropped the focus to the page body (WCAG 2.4.3), as
 * removing a funnel offer or a bundle's product did. Now the focus goes to the Remove button of the step now in
 * its place, or the one before, and to "Add a step" once none is left, by the page editor's rule
 * (lib/block-insert.ts focusAfterRemoval).
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const shims={name:'shims',setup(b){
 b.onResolve({filter:/^next\/(navigation|link)$/},a=>({path:a.path,namespace:'shim'}));
 b.onLoad({filter:/.*/,namespace:'shim'},a=>({contents:a.path==='next/link'
  ?'import React from "react";export default function Link({children,...p}){return React.createElement("a",p,children)}'
  :'export function useRouter(){return {refresh(){},push(){},replace(){}}} export function usePathname(){return "/studio"} export function useSearchParams(){return new URLSearchParams()}',
  loader:'js',resolveDir:root}));
}};
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {PageFunnelEditor} from "@/components/page-funnel-editor";',
 'window.fetch=async()=>new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json"}});',
 'const c=(id,title)=>({kind:"product",id,title,note:""});',
 'createRoot(document.getElementById("root")).render(React.createElement(PageFunnelEditor,{saved:[],choices:[c("a","Alpha"),c("b","Beta"),c("c","Gamma")],base:"https://marktmorgen.com/@chef/go/"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env':JSON.stringify({NODE_ENV:'production'})},logLevel:'error',plugins:[shims]});
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
 await page.getByRole('button',{name:'New funnel'}).click();
 const addStep=()=>page.locator('button',{hasText:/^Add a step/}).click();
 await addStep();await addStep();
 out.count=await page.locator('[aria-label^="Remove step"]').count();
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?(a.getAttribute('aria-label')||(a.textContent||'').trim()||a.tagName).slice(0,40):null;});
 const remove=async(n)=>{await page.getByRole('button',{name:'Remove step '+n,exact:true}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);return focused();};
 out.first=await remove(1);
 out.last=await remove(2);
 out.none=await remove(1);
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
is("three steps to remove", result.count, 3);
is("removing the first puts the focus on the step now in its place", result.first, "Remove step 1");
is("removing the last puts it on the one before", result.last, "Remove step 1");
is("removing the only one puts it on Add a step", result.none?.startsWith("Add a step"), true);
done();
