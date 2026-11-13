/**
 * WCAG 2.2 1.4.10 Reflow (274 [AX1]), measured: /studio/outreach's cards, drawn by the real component with the
 * real stylesheet (app/globals.css compiled by Tailwind) inside the page's own container, in local Chromium at
 * 320 CSS px, never make the page wider than the screen. tests/outreach-reflow.test.ts reads the classes; this one
 * measures the scroll width, as the review of #3850 asked (Codex H2/U, Claude 7, Claude 1 cloud: "the test reads
 * classes, not a 320 px measurement"). Every outside request is refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutreachStudio } from "@/components/outreach-studio";
import { done, is, part } from "./check";

// No hyphen: a break chance would let even an unprotected address wrap, and the test would prove nothing.
const storeUrl = "https://marktmorgen.com/@astorewithaverylonghandle0123456789";
const studio = renderToStaticMarkup(
  createElement(OutreachStudio, { sender: { name: "", address: "" }, pitches: [], left: 5, on: true, storeUrl }),
);
// The page's own wrapper (app/studio/outreach/page.tsx): the container with its side gutter.
const html = `<div class="min-h-screen bg-paper text-ink"><main id="content" class="container-page pb-20 pt-10">${studio}</main></div>`;

async function css(): Promise<string> {
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const decode = (s: string) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, c]) => decode(c).split(/\s+/)).filter(Boolean);
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  return compiler.build([...new Set(classes)]);
}

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const require=createRequire(pathToFileURL(process.cwd()+'/package.json'));
const {chromium}=require('playwright-core');
const {css,html,storeUrl}=JSON.parse(readFileSync(0,'utf8'));
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{}
  try{return await chromium.launch({...options,executablePath:'/opt/pw-browsers/chromium'});}catch{throw first;}
 }
}
const browser=await launch();
try{
 const page=await browser.newPage({viewport:{width:320,height:800}});
 let outside=0;
 await page.route('**/*',r=>{outside++;return r.abort();});
 await page.setContent('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+css+'</style></head><body>'+html+'</body></html>');
 const out=await page.evaluate((url)=>{
  const root=document.documentElement;
  const grid=document.querySelector('#content > div.grid');
  const cards=grid?[...grid.children].map(c=>Math.ceil(c.getBoundingClientRect().right)):[];
  const holder=[...document.querySelectorAll('#content *')].filter(e=>e.textContent.includes(url)).find(e=>![...e.children].some(c=>c.textContent.includes(url)));
  return {scroll:root.scrollWidth,client:root.clientWidth,cards,holder:holder?Math.ceil(holder.getBoundingClientRect().right):null};
 },storeUrl);
 out.outside=outside;
 console.log(JSON.stringify(out));
}finally{await browser.close();}
`;

async function main() {
  const stylesheet = await css();
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], {
    cwd: process.cwd(),
    input: JSON.stringify({ css: stylesheet, html, storeUrl }),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (process.env.SHOW) console.log(raw);
  const got = JSON.parse(raw.trim().split("\n").at(-1) ?? "{}") as { scroll: number; client: number; cards: number[]; holder: number | null; outside: number };

  part("The outreach studio, measured in Chromium at 320 px, fits the screen (WCAG 1.4.10)");
  is("the real stylesheet was compiled and holds the grid's rules", [stylesheet.includes("min-width: 0"), stylesheet.includes("overflow-wrap")], [true, true]);
  is("the page is drawn at 320 px, with its cards and the store's address in the empty list's sentence", [got.client, got.cards.length > 1, got.holder !== null], [320, true, true]);
  is("the page is no wider than the screen: nothing scrolls sideways", got.scroll <= got.client, true);
  is("no card of the grid reaches past the screen's right edge", got.cards.every((right) => right <= got.client), true);
  is("the store's address breaks inside the screen", (got.holder ?? Infinity) <= got.client, true);
  is("no request left the page", got.outside, 0);
  done();
}

void main();
