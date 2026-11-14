/**
 * WCAG 2.5.5 (target size, enhanced) on the community a buyer uses: the bar
 * across the top (its link home and its tabs), the box to write a post (the
 * poll's check box), a post in the feed (its title link) and an event (its
 * title link). Every target is at least 44 by 44 CSS pixels; a check box
 * counts by the label around it, which takes the click too. The real
 * components are rendered with synthetic data, their real Tailwind classes
 * compiled from app/globals.css, and measured in local Chromium with every
 * request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityBar, PostCard } from "@/components/community-parts";
import { CommunityComposer } from "@/components/community-composer";
import { EventCard } from "@/components/community-events";
import { freshConfig } from "@/lib/community";
import { composerWords } from "@/lib/buyer-words/community";
import type { Store } from "@/lib/store";

const store = { handle: "synthetic-kitchen", name: "Synthetic Kitchen", language: "en", photoId: null, look: { theme: "light" } } as unknown as Store;
const config = freshConfig(store.name);
const now = Date.UTC(2026, 10, 13, 12);
const post = { id: "p".repeat(12), n: 1, sp: config.spaces[0].id, a: "a".repeat(32), title: "Which knife should a beginner buy first?", text: "A short question.", img: null, at: now / 1000 - 3600, kind: "post", hid: false, ed: 0 };
const event = { id: "e".repeat(12), title: "Live knife class", about: "", start: now + 86_400_000, minutes: 60, tz: "America/New_York", cap: 0, where: "room", meet: null, room: "r".repeat(12), link: "", only: [], replay: null, cancelled: false };
const parts = [
  ["bar", createElement(CommunityBar, { store, config, tab: "feed", signedIn: true })],
  ["composer", createElement(CommunityComposer, { words: composerWords("en", 6, 0), handle: store.handle, folder: "f", spaces: [{ id: config.spaces[0].id, name: "General", creatorOnly: false, locked: false }] as never, current: null, owner: true, from: "feed", canEmail: false, reach: 0, named: false })],
  ["post", createElement(PostCard as never, { store, post, config, members: new Map(), numbers: { likes: 0, liked: false, comments: 0 }, viewer: { key: "a".repeat(32), owner: false, canWrite: true }, from: "feed" } as never)],
  ["event", createElement(EventCard as never, { store, event, going: 0, mine: false, locked: false, now } as never)],
] as const;

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
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="st-page st-theme-light">'+input.parts.map(([name,html])=>'<section data-part="'+name+'">'+html+'</section>').join('')+'</div></body></html>');
  out.push({width,targets:await page.evaluate(()=>[...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary')].filter(e=>{const cs=getComputedStyle(e);const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&!e.closest('.sr-only');}).map(e=>{
   const target=e.matches('input[type=checkbox],input[type=radio]')&&e.closest('label')?e.closest('label'):e;
   const r=target.getBoundingClientRect();
   return {part:e.closest('[data-part]').dataset.part,name:(e.textContent||e.getAttribute('aria-label')||e.name||e.tagName).replace(/\s+/g,' ').trim().slice(0,40),w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10};
  }))});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const rendered = parts.map(([name, element]) => [name, renderToStaticMarkup(element)] as const);
  const classes = rendered.flatMap(([, html]) => [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/)));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...classes, "st-page", "st-theme-light"]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ parts: rendered, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { width: number; targets: { part: string; name: string; w: number; h: number }[] }[];
  for (const run of result) {
    for (const part of ["bar", "composer", "post", "event"]) assert.ok(run.targets.some((target) => target.part === part), `${run.width}px: the ${part} has targets to measure`);
    assert.ok(run.targets.some((target) => target.part === "composer" && target.name.includes("poll")), `${run.width}px: the poll's check box is measured`);
    assert.deepEqual(run.targets.filter((target) => target.w < 44 || target.h < 44).map((target) => `${target.part}: ${target.name} ${target.w}x${target.h}`), [], `${run.width}px: every target is at least 44 by 44 pixels`);
  }
  console.log(`Community targets: ${result[0].targets.length} measured at ${result.map((run) => run.width).join(" and ")} px, each at least 44 by 44`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
