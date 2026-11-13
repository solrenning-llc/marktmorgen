/**
 * WCAG 1.4.10 and 1.4.12 on the help center's questions: a long word in a
 * question ("MarktmorgenOutreach") must wrap, so the open/close sign beside it
 * stays inside its box at 320px with the reader's own text spacing, instead of
 * being pushed out and cut off. The real page is rendered, its real Tailwind
 * classes compiled from app/globals.css, and measured in local Chromium with
 * every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPage from "@/app/help/page";
import { HELP_SECTIONS } from "@/lib/help-content";

const SPACING = "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";

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
 for(const [width,spacing] of [[320,false],[320,true],[1280,true]]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style>'+(spacing?'<style>'+input.spacing+'</style>':'')+'</head><body>'+input.html+'</body></html>');
  out.push({width,spacing,questions:await page.evaluate(()=>[...document.querySelectorAll('[data-help-item] > summary')].map(summary=>{const box=summary.closest('details').parentElement.getBoundingClientRect(),sign=summary.querySelector('[aria-hidden="true"]').getBoundingClientRect();return {q:summary.textContent.trim(),out:Math.round(sign.right-box.right)};})),page:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)});
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
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css, spacing: SPACING }), encoding: "utf8", timeout: 120_000, maxBuffer: 16_000_000 })) as { width: number; spacing: boolean; questions: { q: string; out: number }[]; page: number }[];
  const total = HELP_SECTIONS.reduce((sum, section) => sum + section.items.length, 0);
  for (const run of result) {
    const label = `${run.width}px${run.spacing ? " with text spacing" : ""}`;
    assert.equal(run.questions.length, total, `${label}: every question is on the page`);
    assert.deepEqual(run.questions.filter((question) => question.out > 0).map((question) => question.q), [], `${label}: no question's open/close sign is pushed out of its box`);
    assert.equal(run.page, 0, `${label}: the page does not scroll sideways`);
  }
  console.log(`Help center: ${total} questions in ${result.length} layouts, every open/close sign inside its box`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
