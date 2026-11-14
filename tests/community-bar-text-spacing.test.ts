/**
 * WCAG 1.4.10 and 1.4.12 on the bar across the top of every community page:
 * the community's name and the "by store · back to the store" link are the
 * page's own words, so at 320px, and with the reader's own text spacing, they
 * wrap rather than end in an ellipsis that hides the rest. The real bar is
 * rendered, its real Tailwind classes compiled from app/globals.css, and the
 * result measured in local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityBar } from "@/components/community-parts";
import { freshConfig } from "@/lib/community";
import type { Store } from "@/lib/store";

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
  out.push({width,spacing,lines:await page.evaluate(()=>[...document.querySelectorAll('.cm-home span span')].map(e=>({text:e.textContent,cut:e.scrollWidth>e.clientWidth+1||getComputedStyle(e).textOverflow==='ellipsis'&&getComputedStyle(e).overflowX!=='visible',right:Math.round(e.getBoundingClientRect().right)}))),page:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const store = { handle: "synthetic-kitchen", name: "Synthetic Kitchen With A Rather Long Store Name", language: "en", photoId: null } as unknown as Store;
  const html = renderToStaticMarkup(createElement(CommunityBar, { store, config: freshConfig(store.name), tab: "feed", signedIn: true }));
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css, spacing: SPACING }), encoding: "utf8", timeout: 60_000, maxBuffer: 4_000_000 })) as { width: number; spacing: boolean; lines: { text: string; cut: boolean; right: number }[]; page: number }[];
  for (const run of result) {
    const label = `${run.width}px${run.spacing ? " with text spacing" : ""}`;
    assert.deepEqual(run.lines.map((line) => line.text), [`${store.name} Community`, `by ${store.name} · back to the store`].map((text) => text), `${label}: the bar still carries both lines`);
    assert.deepEqual(run.lines.filter((line) => line.cut).map((line) => line.text), [], `${label}: no line of the bar is cut off`);
    assert.ok(run.lines.every((line) => line.right <= run.width), `${label}: every line ends inside the screen`);
    assert.equal(run.page, 0, `${label}: the page does not scroll sideways`);
  }
  console.log(`Community bar: ${result.length} layouts, both lines whole and inside the screen`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
