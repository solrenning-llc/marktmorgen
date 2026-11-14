/**
 * Taking a product out of a bundle (components/bundle-editor.tsx), in local Chromium with the real code; every
 * outside request is refused.
 *
 * The product's "Take … out" button went with it and the browser dropped the focus to the page body (WCAG 2.4.3),
 * as removing a funnel offer did (tests/funnel-offer-remove-focus-browser.test.ts). Now the focus goes to the
 * product that took its place, or the one before, and to "Add your products" when the bundle is empty, by the
 * page editor's rule (lib/block-insert.ts focusAfterRemoval).
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
 'import {BundleEditor} from "@/components/bundle-editor";',
 'window.fetch=async()=>new Response(JSON.stringify({ok:true,products:[],next:null}),{headers:{"Content-Type":"application/json"}});',
 'const p=(id,title)=>({id,title,priceCents:1900,what:"Download",hidden:false,why:null});',
 'createRoot(document.getElementById("root")).render(React.createElement(BundleEditor,{mode:"edit",owner:{id:"b1",title:"Kit",priceCents:4900},initial:[p("a","Alpha"),p("b","Beta"),p("c","Gamma")],currency:"usd"}));'
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
 await page.waitForSelector('[aria-label="Take Alpha out"]');
 const focused=()=>page.evaluate(()=>{const a=document.activeElement;return a?(a.getAttribute('aria-label')||a.id||a.tagName):null;});
 const take=async(name)=>{await page.getByRole('button',{name:'Take '+name+' out',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);return focused();};
 out.first=await take('Alpha');
 out.last=await take('Gamma');
 out.none=await take('Beta');
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  first: string | null;
  last: string | null;
  none: string | null;
};

is("no page error", result.errors, []);
is("taking out the first puts the focus on the product that took its place", result.first, "Take Beta out");
is("taking out the last puts it on the one before", result.last, "Take Beta out");
is("taking out the only one puts it on Add your products", result.none, "bundle-find");
done();
