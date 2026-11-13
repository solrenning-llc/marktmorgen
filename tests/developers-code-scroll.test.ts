/**
 * WCAG 2.1.1 on the API page (app/developers): its example code blocks are
 * wider than a phone or a tablet and scroll sideways, so each must take the
 * keyboard's focus, or only a pointer can read their ends (in browsers that
 * do not make every scroller focusable on their own). The real page is
 * rendered, its real Tailwind classes compiled from app/globals.css, and
 * axe-core's scrollable-region-focusable rule run in local Chromium at
 * 320, 390 and 768 pixels with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DevelopersPage from "@/app/developers/page";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const require=createRequire(pathToFileURL(process.cwd()+'/package.json'));
const {chromium}=require('playwright-core');
const axe=readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
const input=JSON.parse(readFileSync(0,'utf8'));
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out=[];
try{
 browser=await launch();
 for(const width of [320,390,768]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body>'+input.html+'</body></html>');
  await page.evaluate(axe);
  const scrolling=await page.evaluate(()=>[...document.querySelectorAll('pre')].filter(p=>p.scrollWidth>p.clientWidth+1).length);
  const unreachable=await page.evaluate(async()=>(await window.axe.run(document,{runOnly:['scrollable-region-focusable']})).violations.flatMap(v=>v.nodes.map(n=>n.target.join(' '))));
  out.push({width,scrolling,unreachable});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const html = renderToStaticMarkup(createElement(DevelopersPage as never));
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css }), encoding: "utf8", timeout: 120_000, maxBuffer: 16_000_000 })) as { width: number; scrolling: number; unreachable: string[] }[];
  assert.ok(result.some((run) => run.scrolling > 0), "some example code scrolls sideways on a narrow screen");
  for (const run of result) assert.deepEqual(run.unreachable, [], `${run.width}px: every code block that scrolls takes the keyboard's focus (${run.scrolling} scroll)`);
  console.log(`API page: ${result.map((run) => `${run.scrolling} scrolling blocks at ${run.width}px`).join(", ")}, each reachable by keyboard`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
