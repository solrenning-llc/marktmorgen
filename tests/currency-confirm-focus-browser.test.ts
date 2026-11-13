/**
 * The question before a store's currency changes (components/payments-panel.tsx), in local Chromium with the real
 * code and a stand-in for the server; every outside request is refused.
 *
 * It sat under the form as role="alertdialog" while the focus stayed on Save, so a keyboard or screen reader user
 * was not taken to the question, Escape did nothing and nothing gave the focus back. WAI-ARIA Authoring Practices,
 * "Alert and Message Dialogs Pattern" (read November 13, 2026): an alert dialog is modal and takes the focus.
 * The question is not modal, so it is now asked the way every other "are you sure" in the studio is asked
 * (components/confirm-action.tsx): a labelled group whose safe choice takes the focus (WCAG 2.4.3, 3.3.6), Escape
 * keeps the currency (2.1.1), and the focus goes back to the currency list when the question closes (2.4.3):
 * Save is off again once the currency is kept, so it cannot hold the focus.
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
  :'export function useRouter(){return {refresh(){},push(){}}} export function usePathname(){return "/studio"} export function useSearchParams(){return new URLSearchParams()}',
  loader:'js',resolveDir:root}));
}};
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {PaymentsPanel} from "@/components/payments-panel";',
 'window.fetch=async()=>new Response(JSON.stringify({ok:false,error:"confirm",priced:3}),{headers:{"Content-Type":"application/json"}});',
 'createRoot(document.getElementById("root")).render(React.createElement(PaymentsPanel,{ways:{state:"none"},currency:"usd",allowed:null,priced:3}));'
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
 await page.waitForSelector('#store-currency');
 const where=()=>page.evaluate(()=>{const a=document.activeElement;const box=document.getElementById('currency-confirm-title')?.closest('[aria-labelledby]');
  return {open:!!box,role:box?box.getAttribute('role'):null,modal:box?box.getAttribute('aria-modal'):null,text:a?(a.textContent||'').trim():'',tag:a?a.tagName:'',id:a?a.id:'',inside:!!(box&&box.contains(a))};});
 await page.selectOption('#store-currency','eur');
 await page.getByRole('button',{name:'Save',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.waitForSelector('#currency-confirm-title');
 await page.waitForTimeout(50);
 out.asked=await where();
 await page.keyboard.press('Escape');
 await page.waitForTimeout(50);
 out.escaped=await where();
 out.currency=await page.$eval('#store-currency',s=>s.value);
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  asked: { open: boolean; role: string | null; modal: string | null; text: string; tag: string; inside: boolean };
  escaped: { open: boolean; text: string; tag: string; id: string };
  currency: string;
};

is("no page error", result.errors, []);
is("the question opens after Save", result.asked.open, true);
is("it is not an alert dialog unless it is modal", result.asked.role !== "alertdialog" || result.asked.modal === "true", true);
is("the focus is taken into the question, on the safe choice", [result.asked.inside, result.asked.text], [true, "Keep USD"]);
is("Escape closes it", result.escaped.open, false);
is("and keeps the currency", result.currency, "usd");
is("the focus goes back to the currency list", result.escaped.id, "store-currency");
done();
