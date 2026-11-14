/**
 * WCAG 2.4.12 (focus not obscured, enhanced) on the help center's row of
 * section links: on a narrow screen it used to be a sideways scroller, and
 * Chromium's keyboard focus does not scroll a link that is already partly in
 * view, so half of the links were focused with part of them hidden past the
 * scroller's edge. Every section link, once reached with the Tab key, must be
 * whole inside its list and inside the screen. The real page is rendered, its
 * real Tailwind classes compiled from app/globals.css, and the links reached
 * with real Tab presses in local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPage from "@/app/help/page";
import { HELP_SECTIONS } from "@/lib/help-content";

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
 for(const width of [320,390,768,1280]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body>'+input.html+'</body></html>');
  await page.evaluate(()=>document.querySelector('nav[aria-label="Help sections"]').previousElementSibling?.scrollIntoView());
  await page.focus('nav[aria-label="Help sections"] a');
  const links=[];
  for(let n=0;n<input.count;n++){
   if(n)await page.keyboard.press('Tab');
   await page.waitForTimeout(50);
   links.push(await page.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),list=e.closest('ul').getBoundingClientRect();return {text:e.textContent.trim(),inNav:!!e.closest('nav[aria-label="Help sections"]'),hidden:Math.round(Math.max(0,list.left-r.left)+Math.max(0,r.right-list.right)+Math.max(0,-r.left)+Math.max(0,r.right-document.documentElement.clientWidth))};}));
  }
  out.push({width,links});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const html = renderToStaticMarkup(createElement(HelpPage));
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css, count: HELP_SECTIONS.length }), encoding: "utf8", timeout: 120_000, maxBuffer: 16_000_000 })) as { width: number; links: { text: string; inNav: boolean; hidden: number }[] }[];
  for (const run of result) {
    assert.deepEqual(run.links.map((link) => link.text), HELP_SECTIONS.map((section) => section.title), `${run.width}px: the Tab key reaches every section link, in order`);
    assert.ok(run.links.every((link) => link.inNav), `${run.width}px: every one is in the sections menu`);
    assert.deepEqual(run.links.filter((link) => link.hidden > 0).map((link) => `${link.text} (${link.hidden}px hidden)`), [], `${run.width}px: no focused section link is partly hidden`);
  }
  console.log(`Help sections: ${HELP_SECTIONS.length} links at ${result.map((run) => run.width).join(", ")} px, each whole in view when focused`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
