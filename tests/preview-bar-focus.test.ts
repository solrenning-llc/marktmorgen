/**
 * WCAG 2.4.13 (focus appearance) on the line above the public menu that says
 * what the site is today (lib/opening.ts): its link sits on the dark bar, so
 * the keyboard ring around it must measure at least 3:1 against that bar, at
 * least 2 pixels thick. The violet ring of the rest of the site measures
 * about 2.3:1 there. The real menu is rendered, its real Tailwind classes
 * compiled from app/globals.css, and the link reached with the Tab key in
 * local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteNav } from "@/components/site-nav";
import { PLANS_ON_SALE, PREVIEW_LINK } from "@/lib/opening";

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
 for(const width of [1280,320]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body>'+input.html+'<main id="content">Page</main></body></html>');
  let found=null;
  for(let n=0;n<6&&!found;n++){
   await page.keyboard.press('Tab');
   found=await page.evaluate(href=>{const e=document.activeElement;if(!e||e.getAttribute('href')!==href)return null;
    const parse=c=>{const v=c.match(/[\d.]+/g).map(Number);return v;};
    const lum=v=>{const f=x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;};return 0.2126*f(v[0])+0.7152*f(v[1])+0.0722*f(v[2]);};
    const cs=getComputedStyle(e),bar=getComputedStyle(e.closest('[data-preview-bar]'));
    const a=lum(parse(cs.outlineColor)),b=lum(parse(bar.backgroundColor));
    return {visible:e.matches(':focus-visible'),style:cs.outlineStyle,width:parseFloat(cs.outlineWidth),ratio:Math.round((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)*100)/100};},input.href);
  }
  out.push({width,found});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  assert.equal(PLANS_ON_SALE, false, "the line is drawn while plans are not on sale");
  const html = renderToStaticMarkup(createElement(SiteNav));
  assert.ok(html.includes("data-preview-bar"), "the real menu draws the line about the site today");
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css, href: PREVIEW_LINK.href }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { width: number; found: { visible: boolean; style: string; width: number; ratio: number } | null }[];
  for (const run of result) {
    assert.ok(run.found, `${run.width}px: the Tab key reaches "${PREVIEW_LINK.label}"`);
    assert.equal(run.found.visible, true, `${run.width}px: the keyboard ring is drawn`);
    assert.notEqual(run.found.style, "none", `${run.width}px: the ring is an outline`);
    assert.ok(run.found.width >= 2, `${run.width}px: the ring is at least 2 pixels thick`);
    assert.ok(run.found.ratio >= 3, `${run.width}px: the ring measures ${run.found.ratio}:1 against the dark bar, at least 3:1`);
  }
  console.log(`Preview line: the keyboard ring on its link is thick and clear of the dark bar at ${result.map((run) => run.width).join(" and ")} px`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
