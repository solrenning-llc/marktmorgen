/**
 * WCAG 2.5.5 (target size, enhanced) on the studio's course pages: the
 * controls under each module and lesson (move, edit, up, down) and the two
 * links on the course's own page ("See it as a student does", "See a
 * sample") stand on their own, not inside a sentence, so each is at least 44
 * by 44 CSS pixels. The editor and the page need a signed-in creator, so they
 * are not rendered here: each target's real class list is read from its
 * source, its real Tailwind classes compiled from app/globals.css, and the
 * target measured in local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body class="bg-paper text-ink">'+input.html+'</body></html>');
  out.push({width,targets:await page.evaluate(()=>[...document.querySelectorAll('[data-target]')].map(e=>{const r=e.getBoundingClientRect();return {name:e.dataset.target,w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10};}))});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

/** One target as its file writes it: the element, its class list read from the source, its words. */
type Target = { name: string; tag: "a" | "button" | "summary" | "label"; classes: string; words: string };

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function markup(target: Target): string {
  const words = escape(target.words);
  if (target.tag === "summary") return `<details><summary data-target="${escape(target.name)}" class="${target.classes}">${words}</summary></details>`;
  if (target.tag === "label") return `<label data-target="${escape(target.name)}" class="${target.classes}"><input type="checkbox"><span>${words}</span></label>`;
  if (target.tag === "a") return `<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold"><a href="#t" data-target="${escape(target.name)}" class="${target.classes}">${words}</a></div>`;
  return `<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold"><button type="button" data-target="${escape(target.name)}" class="${target.classes}">${words}</button></div>`;
}

/** The class list a source file gives, by a pattern whose first group is that list. */
function classesIn(file: string, pattern: RegExp, what: string): string {
  const found = readFileSync(file, "utf8").match(pattern);
  assert.ok(found, `${file} still writes ${what}`);
  return found[1];
}

async function measure(targets: Target[]): Promise<{ width: number; targets: { name: string; w: number; h: number }[] }[]> {
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const html = targets.map(markup).join("");
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const css = compiler.build([...classes, "bg-paper", "text-ink"]);
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 }));
}

async function main() {
  const small = classesIn("components/course-editor.tsx", /\nconst small = "([^"]*)";/, "one class list for its module and lesson controls");
  const page = "app/studio/course/[product]/page.tsx";
  const targets: Target[] = [
    ...["Move module up", "Move module down", "Edit lesson", "Up", "Down"].map((words) => ({ name: `course editor: ${words}`, tag: "button" as const, classes: small, words })),
    { name: "course page: See it as a student does", tag: "a", classes: classesIn(page, /className="([^"]*)">\s*See it as a student does/, "its link to the course as a student sees it"), words: "See it as a student does" },
    { name: "course page: See a sample", tag: "a", classes: classesIn(page, /className="([^"]*)"\s*>\s*See a sample/, "its link to the sample certificate"), words: "See a sample" },
  ];
  const result = await measure(targets);
  for (const run of result) {
    assert.equal(run.targets.length, targets.length, `${run.width}px: every target is drawn`);
    assert.deepEqual(run.targets.filter((target) => target.w < 44 || target.h < 44).map((target) => `${target.name} ${target.w}x${target.h}`), [], `${run.width}px: every target is at least 44 by 44 pixels`);
  }
  console.log(`Studio course targets: ${targets.length} at 320 and 1280 px, each at least 44 by 44`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
