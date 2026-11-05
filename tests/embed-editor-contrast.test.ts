/** Real React editors in local Chromium; all network requests are refused. */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

// Resolve browser/build tools at runtime rather than bundling their internals into this test.
const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const entry=[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {BuyButtonEditor} from "@/components/buy-button-editor";',
 'import {CheckoutScriptEditor} from "@/components/checkout-script-editor";',
 'const root=createRoot(document.getElementById("root"));',
 'window.renderEditors=(fill,onFill)=>{const common={handle:"synthetic-store",products:[{id:"abc123",title:"Synthetic course"}],fill,onFill};root.render(React.createElement("div",null,React.createElement(BuyButtonEditor,common),React.createElement(CheckoutScriptEditor,{...common,sites:[],signup:false})));};'
].join('\n');
const bundle=await build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',plugins:[{name:'review-link-shell',setup(b){b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'review'}));b.onLoad({filter:/.*/,namespace:'review'},()=>({contents:'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}',loader:'js',resolveDir:root}));}}]});
let browser;
try {
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();let requests=0;const errors=[];
 await page.route('**/*',route=>{requests++;return route.abort();});
 page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<div id="root"></div>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>window.renderEditors('#ffffff','#ffffff'));
 await page.locator('#buy-button').waitFor();
 await page.locator('#buy-button input[value="button"]').check();
 const unsafe=await page.evaluate(()=>{
  const plain=document.querySelector('#buy-button'), script=document.querySelector('#checkout-script');
  const pair=html=>{const a=new DOMParser().parseFromString(html,'text/html').querySelector('a');return [a.style.backgroundColor,a.style.color];};
  const preview=plain.querySelector('a[style]'), css=getComputedStyle(preview);
  return {plain:pair(plain.querySelector('textarea[readonly]').value),script:pair(script.querySelector('textarea[readonly]').value),preview:[css.backgroundColor,css.color],plainNotice:plain.textContent.includes('These colors are hard to read.'),scriptNotice:script.textContent.includes('These colors are hard to read.'),choices:document.querySelectorAll('a[href="/studio#look"]').length};
 });
 await page.evaluate(()=>window.renderEditors('#4f2acc','#ffffff'));
 await page.waitForFunction(()=>document.querySelector('#checkout-script textarea[readonly]').value.includes('#4f2acc'));
 const valid=await page.evaluate(()=>{
  const plain=document.querySelector('#buy-button'),script=document.querySelector('#checkout-script');
  return {plain:plain.querySelector('textarea[readonly]').value,script:script.querySelector('textarea[readonly]').value,notice:document.body.textContent.includes('These colors are hard to read.'),choices:document.querySelectorAll('a[href="/studio#look"]').length};
 });
 console.log(JSON.stringify({unsafe,valid,requests,errors}));
} finally {if(browser)await browser.close();}
`;

type Pair = [string, string];
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000 })) as {
  unsafe: { plain: Pair; script: Pair; preview: Pair; plainNotice: boolean; scriptNotice: boolean; choices: number };
  valid: { plain: string; script: string; notice: boolean; choices: number };
  requests: number; errors: string[];
};
function ratio(pair: Pair): number {
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length !== 3) throw new Error("Expected opaque browser RGB");
    const rgb = values.map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(pair[0]), b = luminance(pair[1]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
is("the simple button's copied CSS is readable", ratio(result.unsafe.plain) >= 7, true);
is("the actual simple-button preview is readable", ratio(result.unsafe.preview) >= 7, true);
is("the script link's copied CSS is readable too", ratio(result.unsafe.script) >= 7, true);
is("the simple editor explains the substituted colors", result.unsafe.plainNotice, true);
is("the script editor explains the substituted colors", result.unsafe.scriptNotice, true);
is("both offer the existing store-color choice", result.unsafe.choices, 2);
is("readable colors are preserved in both copies", [result.valid.plain.includes("background:#4f2acc;color:#ffffff"), result.valid.script.includes("background:#4f2acc;color:#ffffff")], [true, true]);
is("normal colors have no irrelevant correction notice", [result.valid.notice, result.valid.choices], [false, 0]);
is("no outside service or saved-setting request", result.requests, 0);
is("no browser error", result.errors, []);
done();
