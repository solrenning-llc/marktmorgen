/**
 * WCAG 1.4.11 on the address a creator types to make a store
 * ("marktmorgen.com/@yourname"): the field is a white box drawn by the card
 * around it, on a white or ivory page, so the card's edge is what shows where
 * to type. That edge keeps 3:1 against the page, and turns violet while the
 * field has the keyboard. The real form is rendered, its real Tailwind
 * classes compiled from app/globals.css, and measured in local Chromium with
 * every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HandleForm } from "@/components/handle-form";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(pathToFileURL(process.cwd()+'/package.json'));
const {chromium}=require('playwright-core');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out=[];
try{
 browser=await launch();
 for(const page_ of ['bg-paper','bg-white']){
  const page=await browser.newPage({viewport:{width:800,height:700}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body class="'+page_+'"><main class="p-6">'+input.html+'</main></body></html>');
  const read=()=>page.evaluate(()=>{
   const paint=c=>{const m=c.match(/[\d.]+/g).map(Number);const unit=c.startsWith('color(')?255:1;return {r:m[0]*unit,g:m[1]*unit,b:m[2]*unit,a:m.length>3?m[3]:1};};
   const lum=c=>{const f=x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
   const over=(c,u)=>({r:c.r*c.a+u.r*(1-c.a),g:c.g*c.a+u.g*(1-c.a),b:c.b*c.a+u.b*(1-c.a),a:1});
   const ratio=(a,b)=>{const x=lum(a),y=lum(b);return Math.round((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)*100)/100;};
   const box=document.getElementById('store-handle').parentElement,cs=getComputedStyle(box);
   const pageBg=paint(getComputedStyle(document.body).backgroundColor);
   const edges=['Top','Right','Bottom','Left'].map(s=>({w:parseFloat(cs['border'+s+'Width']),c:ratio(over(paint(cs['border'+s+'Color']),pageBg),pageBg)}));
   return {edges,color:cs.borderTopColor};
  });
  const still=await read();
  await page.focus('#store-handle');await page.waitForTimeout(400);
  const focused=await read();
  out.push({page:page_,still,focused});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const html = renderToStaticMarkup(createElement(HandleForm, {}));
  assert.ok(html.includes('id="store-handle"'), "the real form has the address field");
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...classes, "bg-paper", "bg-white", "p-6"]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { page: string; still: { edges: { w: number; c: number }[]; color: string }; focused: { edges: { w: number; c: number }[]; color: string } }[];
  for (const run of result) {
    assert.ok(run.still.edges.every((edge) => edge.w >= 1 && edge.c >= 3), `${run.page}: the address field's edge is at least 3:1 all round (${run.still.edges.map((edge) => `${edge.w}px ${edge.c}:1`).join(", ")})`);
    assert.notEqual(run.focused.color, run.still.color, `${run.page}: the edge changes while the field has the keyboard`);
    assert.ok(run.focused.edges.every((edge) => edge.w >= 1 && edge.c >= 3), `${run.page}: and stays at least 3:1 then`);
  }
  console.log(`Address field: its edge keeps 3:1 on ${result.map((run) => run.page).join(" and ")}, and turns violet with the keyboard`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
