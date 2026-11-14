/**
 * WCAG 3.3.2 (labels or instructions) on the box a member or creator writes a
 * community post in: the title, the space and the text each have a label on
 * the screen, not only words inside the field that vanish once typing
 * starts. The real composer is rendered, its real Tailwind classes compiled
 * from app/globals.css, and measured in local Chromium with every request
 * refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityComposer } from "@/components/community-composer";
import { composerWords } from "@/lib/buyer-words/community";

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
 for(const width of [320,1280]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="st-page st-theme-light"><main class="p-4">'+input.html+'</main></div></body></html>');
  out.push({width,fields:await page.evaluate(()=>['post-title','post-space','post-text'].map(id=>{const field=document.getElementById(id);const label=field?.labels?.[0];const r=label?.getBoundingClientRect();const cs=label?getComputedStyle(label):null;return {id,label:label?.textContent?.trim()||'',seen:!!r&&r.width>1&&r.height>1&&cs.visibility!=='hidden'&&cs.clip!=='rect(0px, 0px, 0px, 0px)'&&!label.closest('.sr-only')&&!label.matches('.sr-only'),above:!!r&&r.bottom<=field.getBoundingClientRect().top+1};}))});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const html = renderToStaticMarkup(createElement(CommunityComposer, { words: composerWords("en", 6, 0), handle: "synthetic-kitchen", folder: "f", spaces: [{ id: "s".repeat(12), name: "General", creatorOnly: false, locked: false }] as never, current: null, owner: false, from: "feed", canEmail: false, reach: 0, named: false }));
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...classes, "st-page", "st-theme-light", "p-4"]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { width: number; fields: { id: string; label: string; seen: boolean; above: boolean }[] }[];
  for (const run of result) {
    for (const field of run.fields) {
      assert.ok(field.label, `${run.width}px: ${field.id} has a label`);
      assert.ok(field.seen, `${run.width}px: ${field.id}'s label "${field.label}" is on the screen`);
      assert.ok(field.above, `${run.width}px: ${field.id}'s label sits above it, before one types`);
    }
  }
  console.log(`Community composer: title, space and text each labelled on the screen at ${result.map((run) => run.width).join(" and ")} px`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
