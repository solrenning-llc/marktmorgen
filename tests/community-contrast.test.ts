/**
 * Contrast in the community a buyer uses, in each of the store's light and
 * dark looks: "Delete the post" in a post's menu is small red text, so it
 * keeps 7:1 against the menu, also under the pointer (WCAG 1.4.6, AAA); the
 * search box in the community bar is known only by its edge, so that edge
 * keeps 3:1 against the bar (1.4.11). The real bar and a real post are
 * rendered with synthetic data in the real store look (lookStyle), their real
 * Tailwind classes compiled from app/globals.css, and measured in local
 * Chromium with every request refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityBar, PostCard } from "@/components/community-parts";
import { freshConfig } from "@/lib/community";
import { DEFAULT_LOOK, lookStyle } from "@/lib/store-look";
import type { Store } from "@/lib/store";

const THEMES = ["light", "sand", "night"] as const;

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
 for(const look of input.looks){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><style>'+input.css+'</style></head><body><div class="st-page st-theme-'+look.theme+'" style="'+look.style+'">'+look.html+'</div></body></html>');
  await page.evaluate(()=>{for(const d of document.querySelectorAll('details.cm-menu'))d.open=true;});
  const read=()=>page.evaluate(()=>{
   // Chromium gives rgb()/rgba() in 0-255, and color(srgb ...) from color-mix() in 0-1.
   const paint=c=>{const m=c.match(/[\d.]+/g).map(Number);const unit=c.startsWith('color(')?255:1;return {r:m[0]*unit,g:m[1]*unit,b:m[2]*unit,a:m.length>3?m[3]:1};};
   const lum=c=>{const f=x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
   const over=(c,under)=>({r:c.r*c.a+under.r*(1-c.a),g:c.g*c.a+under.g*(1-c.a),b:c.b*c.a+under.b*(1-c.a),a:1});
   const ratio=(a,b)=>{const x=lum(a),y=lum(b);return Math.round((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)*100)/100;};
   const behind=e=>{const layers=[];for(let p=e;p;p=p.parentElement){const c=paint(getComputedStyle(p).backgroundColor);if(c.a>0){layers.push(c);if(c.a>=0.99)break;}}let bg={r:255,g:255,b:255,a:1};for(const c of layers.reverse())bg=over(c,bg);return bg;};
   const danger=document.querySelector('.cm-danger'),search=document.querySelector('.cm-search');
   const dangerBg=behind(danger);
   const bar=behind(search.parentElement),edge=over(paint(getComputedStyle(search).borderTopColor),bar);
   return {danger:danger?ratio(paint(getComputedStyle(danger).color),dangerBg):null,dangerWords:danger?.textContent.trim(),edge:ratio(edge,bar)};
  });
  const still=await read();
  await page.hover('.cm-danger');await page.waitForTimeout(300);
  const hovered=await read();
  out.push({theme:look.theme,danger:still.danger,dangerHovered:hovered.danger,words:still.dangerWords,edge:still.edge});
  await page.close();
 }
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

async function main() {
  const looks = THEMES.map((theme) => {
    const look = { ...DEFAULT_LOOK, theme };
    const store = { handle: "synthetic-kitchen", name: "Synthetic Kitchen", language: "en", photoId: null, look } as unknown as Store;
    const config = freshConfig(store.name);
    const now = Date.UTC(2026, 10, 13, 12);
    const post = { id: "p".repeat(12), n: 1, sp: config.spaces[0].id, a: "a".repeat(32), title: "Which knife should a beginner buy first?", text: "A short question.", img: null, at: now / 1000 - 3600, kind: "post", hid: false, ed: 0 };
    const html =
      renderToStaticMarkup(createElement(CommunityBar, { store, config, tab: "feed", signedIn: true })) +
      `<main class="mx-auto max-w-2xl p-4">${renderToStaticMarkup(createElement(PostCard as never, { store, post, config, members: new Map(), numbers: { likes: 0, liked: false, comments: 0 }, viewer: { key: "o".repeat(32), owner: true, canWrite: true }, from: "feed" } as never))}</main>`;
    const style = Object.entries(lookStyle(look)).map(([name, value]) => `${name}:${value}`).join(";").replace(/"/g, "&quot;");
    return { theme, html, style };
  });
  const classes = looks.flatMap(({ html }) => [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, list]) => list.split(/\s+/)));
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build([...classes, "st-page", ...THEMES.map((theme) => `st-theme-${theme}`)]);
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { input: JSON.stringify({ looks, css }), encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 })) as { theme: string; danger: number | null; dangerHovered: number | null; words: string; edge: number }[];
  for (const run of result) {
    assert.equal(run.words, "Delete the post", `${run.theme}: the owner's post menu offers "Delete the post"`);
    assert.ok((run.danger ?? 0) >= 7, `${run.theme}: "Delete the post" is ${run.danger}:1 against the menu, at least 7:1`);
    assert.ok((run.dangerHovered ?? 0) >= 7, `${run.theme}: under the pointer it is ${run.dangerHovered}:1, at least 7:1`);
    assert.ok(run.edge >= 3, `${run.theme}: the search box's edge is ${run.edge}:1 against the bar, at least 3:1`);
  }
  console.log(`Community contrast: ${result.map((run) => `${run.theme} ${run.danger}/${run.dangerHovered}:1 red, ${run.edge}:1 edge`).join("; ")}`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
