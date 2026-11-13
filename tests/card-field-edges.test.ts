/**
 * WCAG 1.4.11 on every field that is drawn only by the card around it (the
 * store address, its rename, a product's prices): the card's edge is what
 * shows where to type, so it keeps 3:1 against the page and turns violet
 * while the field has the keyboard. Each such card's real class list is read
 * from the source (every "card ... focus-within" box in app/ and components/),
 * its real Tailwind classes compiled from app/globals.css, and the box
 * measured in local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

const boxes = [...files("app"), ...files("components")].flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/className="(card\b[^"]*focus-within:[^"]*)"/g)].map(([, classes], n) => ({ name: `${file} #${n + 1}`, classes })),
);

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
 const page=await browser.newPage({viewport:{width:800,height:700}});
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body class="bg-paper"><main class="p-6">'+input.boxes.map((b,i)=>'<div data-box="'+i+'" class="'+b.classes+'"><span>$</span><input id="f'+i+'" aria-label="Field '+i+'" class="min-w-0 w-full bg-transparent px-1 py-3.5 outline-none"></div>').join('')+'</main></body></html>');
 const read=i=>page.evaluate(i=>{
  const paint=c=>{const m=c.match(/[\d.]+/g).map(Number);const unit=c.startsWith('color(')?255:1;return {r:m[0]*unit,g:m[1]*unit,b:m[2]*unit,a:m.length>3?m[3]:1};};
  const lum=c=>{const f=x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
  const over=(c,u)=>({r:c.r*c.a+u.r*(1-c.a),g:c.g*c.a+u.g*(1-c.a),b:c.b*c.a+u.b*(1-c.a),a:1});
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return Math.round((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)*100)/100;};
  const cs=getComputedStyle(document.querySelector('[data-box="'+i+'"]')),bg=paint(getComputedStyle(document.body).backgroundColor);
  return {color:cs.borderTopColor,low:Math.min(...['Top','Right','Bottom','Left'].map(s=>parseFloat(cs['border'+s+'Width'])>=1?ratio(over(paint(cs['border'+s+'Color']),bg),bg):0))};
 },i);
 for(let i=0;i<input.boxes.length;i++){
  const still=await read(i);
  await page.focus('#f'+i);await page.waitForTimeout(400);
  const focused=await read(i);
  await page.evaluate(()=>document.activeElement.blur());await page.waitForTimeout(400);
  out.push({still,focused});
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  assert.ok(boxes.length >= 6, `the fields drawn by a card are found (${boxes.length})`);
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...boxes.flatMap((box) => box.classes.split(/\s+/)), "bg-paper", "p-6", "min-w-0", "w-full", "bg-transparent", "px-1", "py-3.5", "outline-none"]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ boxes, css }), encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000 })) as { still: { color: string; low: number }; focused: { color: string; low: number } }[];
  const failing = boxes.flatMap((box, i) => {
    const run = result[i];
    return [
      ...(run.still.low >= 3 ? [] : [`${box.name}: edge ${run.still.low}:1`]),
      ...(run.focused.color !== run.still.color && run.focused.low >= 3 ? [] : [`${box.name}: no clear edge change with the keyboard`]),
    ];
  });
  assert.deepEqual(failing, [], "every field drawn by a card has an edge of at least 3:1 that turns violet with the keyboard");
  console.log(`Card fields: ${boxes.length} boxes keep a 3:1 edge and show the keyboard`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
