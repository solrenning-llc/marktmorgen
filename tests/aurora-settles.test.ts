/**
 * WCAG 2.2.2 (pause, stop, hide) on the Aurora backdrop a creator can pick for
 * their store (lib/store-look.ts): it moves on its own as the page opens, so
 * it must stop within five seconds and stay still (no control is then
 * needed), on every store page and on the studio's preview of it. Its
 * description in the studio no longer promises movement. A real store page
 * shell with the real Aurora style is drawn in local Chromium with the real
 * stylesheet compiled from app/globals.css, every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BACKDROPS, DEFAULT_LOOK, lookStyle } from "@/lib/store-look";

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
 const page=await browser.newPage({viewport:{width:800,height:600},reducedMotion:'no-preference'});
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="st-page st-theme-light" style="'+input.style+';min-height:100vh"><p>Store</p></div></body></html>');
 const timing=await page.evaluate(()=>{const a=document.querySelector('.st-page').getAnimations().find(x=>x.animationName==='st-aurora');if(!a)return null;const t=a.effect.getComputedTiming();return {state:a.playState,total:t.endTime,iterations:t.iterations};});
 await page.waitForTimeout(5200);
 const later=await page.evaluate(()=>{const a=document.querySelector('.st-page').getAnimations().find(x=>x.animationName==='st-aurora');return {running:!!a&&a.playState==='running',position:getComputedStyle(document.querySelector('.st-page')).backgroundPosition};});
 await page.waitForTimeout(600);
 const after=await page.evaluate(()=>getComputedStyle(document.querySelector('.st-page')).backgroundPosition);
 out={timing,later,after};
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const aurora = BACKDROPS.find((backdrop) => backdrop.id === "aurora");
  assert.ok(aurora, "Aurora is still a backdrop a creator can pick");
  assert.doesNotMatch(aurora.description, /drift|mov|flow|float/i, `its description in the studio does not promise movement: "${aurora.description}"`);
  const style = Object.entries(lookStyle({ ...DEFAULT_LOOK, backdrop: "aurora" })).map(([name, value]) => `${name}:${value}`).join(";").replace(/"/g, "&quot;");
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(["st-page", "st-theme-light"]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ css, style }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { timing: { state: string; total: number; iterations: number } | null; later: { running: boolean; position: string }; after: string };
  assert.ok(result.timing, "the Aurora backdrop still moves as the page opens");
  assert.equal(result.timing.state, "running", "it starts on its own");
  assert.ok(Number.isFinite(result.timing.iterations), `it does not repeat forever (iterations ${result.timing.iterations})`);
  assert.ok(result.timing.total <= 5000, `it ends within five seconds (${result.timing.total} ms)`);
  assert.equal(result.later.running, false, "after five seconds it no longer moves");
  assert.equal(result.after, result.later.position, "and it stays still where it settled");
  console.log(`Aurora: moves for ${result.timing.total} ms once, then stays still; "${aurora.description}"`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
