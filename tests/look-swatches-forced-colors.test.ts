/**
 * Forced colors (Windows high contrast) on the studio's "Your color" choice:
 * each colour circle IS the information, so forced colors must not repaint
 * it with the system background, or every circle looks the same. The ring
 * and the check that mark the chosen one stay. The look editor needs a
 * signed-in creator, so it is not rendered here: the circles' real class
 * lists are read from components/look-editor.tsx, their real Tailwind
 * classes compiled from app/globals.css, and the circles drawn in local
 * Chromium with forced colors on and every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ACCENTS } from "@/lib/store-look";

const source = readFileSync("components/look-editor.tsx", "utf8");
const preset = source.match(/key=\{option\.hex\}\s*title=\{option\.label\}\s*className="([^"]*)"\s*style=\{\{ background: option\.hex \}\}/);
assert.ok(preset, "the look editor still draws each ready colour as a circle filled with it");
const own = source.match(/<span aria-hidden="true" className="([^"]*)" style=\{\{ background: accent \}\} \/>\s*Your own/);
assert.ok(own, "the look editor still shows the creator's own colour in a circle beside \"Your own\"");
const presetClasses = preset[1];
const ownClasses = own[1];

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(pathToFileURL(process.cwd()+'/package.json'));
const {chromium}=require('playwright-core');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;let out;
try{
 browser=await launch();
 const context=await browser.newContext({viewport:{width:800,height:400},forcedColors:'active'});
 const page=await context.newPage();
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="mt-3 flex flex-wrap items-center gap-2.5">'+input.swatches.map(s=>'<label data-hex="'+s.hex+'" class="'+input.preset+'" style="background:'+s.hex+'"><input type="radio" name="accent" class="sr-only"><span class="sr-only">'+s.label+'</span></label>').join('')+'<label class="flex h-11 items-center gap-2"><span data-hex="#123456" aria-hidden="true" class="'+input.own+'" style="background:#123456"></span>Your own</label></div></body></html>');
 out={forced:await page.evaluate(()=>matchMedia('(forced-colors: active)').matches),circles:await page.evaluate(()=>[...document.querySelectorAll('[data-hex]')].map(e=>({hex:e.dataset.hex,drawn:getComputedStyle(e).backgroundColor})))};
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function main() {
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...presetClasses.split(/\s+/), ...ownClasses.split(/\s+/), "sr-only", "mt-3", "flex", "flex-wrap", "items-center", "gap-2.5", "h-11", "gap-2"]);
  const swatches = ACCENTS.map((option) => ({ hex: option.hex, label: option.label }));
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ css, preset: presetClasses, own: ownClasses, swatches }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { forced: boolean; circles: { hex: string; drawn: string }[] };
  assert.equal(result.forced, true, "Chromium draws the page with forced colors");
  assert.equal(result.circles.length, ACCENTS.length + 1, "every ready colour and the creator's own are drawn");
  assert.deepEqual(result.circles.filter((circle) => circle.drawn !== rgb(circle.hex)).map((circle) => `${circle.hex} drawn as ${circle.drawn}`), [], "with forced colors each circle keeps its own colour");
  console.log(`Look colours: ${result.circles.length} circles keep their colour with forced colors on`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
