/**
 * WCAG 1.4.10 on the product card a creator pastes into a site, framed as the
 * checkout script opens it: at 400% zoom the script's frame is 160 CSS pixels
 * tall (its calc(100vh - 96px) on a 256-pixel-tall view). The card fills its
 * frame and clips what overflows, so a full-size action (a 44-pixel button,
 * as when the store can take payments) must never be cut off: the card grows
 * past the frame instead and the frame scrolls. At the frame heights the card
 * is made for, nothing changes.
 *
 * The card page reads the request's headers, so it is not rendered here.
 * Its real class lists and its real frame stylesheet are taken from the page
 * source, its real Tailwind classes compiled from app/globals.css, and the
 * result measured in local Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { CARD_COVER_FROM } from "@/lib/embed-rules";

const source = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
const rules = source.match(/const CARD_RULES =\s*([\s\S]*?);\nconst SEE_THROUGH = ([^\n]*);/);
assert.ok(rules, "the card page still keeps its frame stylesheet in CARD_RULES and SEE_THROUGH");
const seeThrough = new Function("CARD_COVER_FROM", `const CARD_RULES = ${rules[1]}; return ${rules[2]};`)(CARD_COVER_FROM) as string;

/** A class list exactly as the card page writes it, for a card that is not a creator's "sold by" card. */
function classesOf(fragment: string): string {
  assert.ok(source.includes(fragment), `the card page still writes ${fragment}`);
  return fragment;
}
const article = classesOf('st-card flex ${soldBy ? "min-h-full" : "h-full"} flex-col overflow-hidden p-4').replace('${soldBy ? "min-h-full" : "h-full"}', "h-full");
const root = classesOf('st-page st-theme-${store.look.theme} h-screen${soldBy ? " overflow-y-auto" : ""}').replace("${store.look.theme}", "light").replace('${soldBy ? " overflow-y-auto" : ""}', "");
const mainClasses = classesOf('<main id="content" className="h-full">') && "h-full";
const heading = classesOf("font-display line-clamp-2 text-[1.0625rem] font-semibold leading-snug");
const storeName = classesOf("st-muted truncate text-sm");
const priceLine = classesOf("mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1");
const summaryBox = classesOf("mt-2 min-h-0 flex-1 overflow-hidden");
const summary = classesOf("em-sum st-muted text-sm leading-relaxed");
const action = classesOf("btn st-btn btn-block mt-3");

const html =
  `<div class="${root}" style="background:transparent"><style>${seeThrough}</style><main id="content" class="${mainClasses}">` +
  `<article class="${article}" style="box-shadow:none"><div class="flex items-start gap-3"><div class="min-w-0 flex-1">` +
  `<h1 class="${heading}"><a href="#p" class="st-title-link">Knife Skills For Absolutely Everyone At Home</a></h1>` +
  `<p class="${storeName}">Harbor Kitchen Local</p></div></div>` +
  `<div class="${priceLine}"><p class="st-price text-sm">$49</p></div>` +
  `<div class="${summaryBox}"><p class="${summary}" style="--lines:2">Ten short lessons on cutting safely and fast: holding the knife, the claw grip, onions without tears.</p></div>` +
  `<a href="#buy" class="${action}" id="action">Buy now</a></article></main></div>`;

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
 for(const [width,height,scale] of [[288,160,4],[400,200,1],[400,260,1],[400,300,1],[400,420,1],[400,520,1]]){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:scale});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body>'+input.html+'</body></html>');
  out.push({width,height,scale,...await page.evaluate(()=>{const card=document.querySelector('article'),act=document.getElementById('action');const c=card.getBoundingClientRect(),a=act.getBoundingClientRect();return {card:Math.round(c.height),clipped:card.scrollHeight-card.clientHeight,actionHeight:Math.round(a.height),actionBottom:Math.round(a.bottom),cardInner:Math.round(c.bottom-parseFloat(getComputedStyle(card).paddingBottom)),doc:document.documentElement.scrollHeight};})});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ html, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { width: number; height: number; scale: number; card: number; clipped: number; actionHeight: number; actionBottom: number; cardInner: number; doc: number }[];
  for (const run of result) {
    const label = `${run.width}x${run.height} at ${run.scale * 100}%`;
    assert.ok(run.actionHeight >= 44, `${label}: the action is a full 44-pixel target`);
    assert.equal(run.clipped, 0, `${label}: the card clips none of what it holds`);
    assert.ok(run.actionBottom <= run.cardInner, `${label}: the action ends inside the card, above its padding`);
    assert.ok(run.doc >= run.card, `${label}: the frame scrolls to whatever the card holds`);
    if (run.scale === 1) assert.equal(run.card, run.height, `${label}: at the heights it is made for, the card fills its frame exactly as before`);
  }
  console.log(`Embed card: ${result.length} frames, the 44-pixel action never cut off, the made-for heights unchanged`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
