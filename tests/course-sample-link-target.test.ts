/**
 * WCAG 2.5.5 (target size, enhanced) on the course page a creator sees of
 * their own course: the link to the sample certificate stands alone in its
 * own line, not inside a sentence, so it must be at least 44 by 44 CSS
 * pixels. The course page reads the request's cookies, so it is not rendered
 * here: the link's real class list is taken from the page source, its real
 * Tailwind classes compiled from app/globals.css, and the link measured in
 * local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { coursesWords } from "@/lib/buyer-words/courses";

const source = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
const found = source.match(/<p className="([^"]*)">\s*<Link href=\{`\/@\$\{store\.handle\}\/certificate\/sample\?product=\$\{product\.id\}`\} className="([^"]*)"[^>]*>\s*\{w\.seeSample\}/);
assert.ok(found, "the course page still links its owner to the sample certificate on a line of its own");
const [, lineClasses, linkClasses] = found;

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
  const page=await browser.newPage({viewport:{width,height:600}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="st-page st-theme-light"><div class="st-note mt-6"><p class="'+input.lineClasses+'"><a href="#sample" class="'+input.linkClasses+'">'+input.words+'</a></p></div></div></body></html>');
  out.push({width,...await page.evaluate(()=>{const r=document.querySelector('a').getBoundingClientRect();return {w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10};})});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...lineClasses.split(/\s+/), ...linkClasses.split(/\s+/), "st-page", "st-theme-light", "st-note", "mt-6"]);
  const words = coursesWords("en").seeSample;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ css, lineClasses, linkClasses, words }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { width: number; w: number; h: number }[];
  for (const run of result) assert.ok(run.w >= 44 && run.h >= 44, `${run.width}px: "${words}" is ${run.w}x${run.h}, at least 44 by 44`);
  console.log(`Course page: "${words}" is at least 44 by 44 at ${result.map((run) => run.width).join(" and ")} px`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
