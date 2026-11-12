/**
 * A sales page's countdown (components/countdown.tsx) can be stopped (issue #3992). Numbers that change every second
 * beside the rest of the page are moving content: WCAG 2.2.2 Pause, Stop, Hide (A), with 2.3.3 and the W3C COGA
 * guidance on distraction (AX274), read November 12, 2026: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html.
 * - The real component, drawn by React: a 44 × 44 px button named in the store's language stops the numbers; stopped,
 *   no seconds are drawn and nothing ticks, and "Until {when}" names the moment instead.
 * - In local Chromium with the real code (as tests/checkout-focus-browser.test.ts; every outside request refused): the
 *   seconds change while counting, stop changing after the button, count again after it is pressed again, and a visitor
 *   who asked for less motion (prefers-reduced-motion) starts with them stopped. Screen readers never hear the ticking.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Countdown } from "@/components/countdown";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is } from "./check";

const base = { until: 2_000_000_000, now: 1_900_000_000, heading: "Doors close soon", note: "" };
const counting = renderToStaticMarkup(createElement(Countdown, base));
const stopped = renderToStaticMarkup(createElement(Countdown, { ...base, paused: true }));
const button = (html: string) => html.match(/<button[^>]*>([^<]*)<\/button>/);

is("a counting countdown has a real button to pause it, named by its own words", [button(counting)?.[0].includes('type="button"'), button(counting)?.[1]], [true, "Pause countdown"]);
is("and it still draws its seconds", counting.includes(">sec<"), true);
is("stopped, no seconds (and no other changing number) are drawn", [stopped.includes(">sec<"), stopped.includes("sp-countdown-units")], [false, false]);
is("and the same button now starts it again", button(stopped)?.[1], "Resume countdown");
is("screen readers are never told of a change, either way", [counting, stopped].map((html) => /aria-live="off"/.test(html) && !/aria-live="(polite|assertive)"/.test(html)), [true, true]);

const css = readFileSync("app/globals.css", "utf8");
const rule = css.match(/\.sp-countdown-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
is("the button is a target of at least 44 × 44 px (2.5.5)", [/min-width:\s*44px/.test(rule), /min-height:\s*44px/.test(rule)], [true, true]);
is("and its edge is a border, which forced colors keep", /border:\s*1px solid/.test(rule), true);

// Every buyer language names both states of the button in its own words.
const named = LANGUAGE_CODES.map((code) => {
  const w = wordsIn(code);
  return [code, Boolean(w.countdownPause.trim()), Boolean(w.countdownResume.trim()), w.countdownPause !== w.countdownResume];
});
is("every buyer language names both states of the button", named, LANGUAGE_CODES.map((code) => [code, true, true, true]));
is("and none but English uses the English words", LANGUAGE_CODES.filter((code) => code !== "en" && wordsIn(code).countdownPause === wordsIn("en").countdownPause), []);
const blocks = readFileSync("components/sales-blocks.tsx", "utf8");
is("the sales page hands the countdown the store's words for its button", [/pause: wordsIn\([^)]*\)\.countdownPause/.test(blocks), /resume: wordsIn\([^)]*\)\.countdownResume/.test(blocks)], [true, true]);

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const {readFileSync}=require('node:fs');
const toggleRule=readFileSync(root+'/app/globals.css','utf8').match(/\.sp-countdown-toggle\s*\{[^}]*\}/)?.[0]??'';
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {Countdown} from "@/components/countdown";',
 'const until=Math.floor(Date.now()/1000)+3*86400;',
 'createRoot(document.getElementById("root")).render(React.createElement(Countdown,{until,heading:"Doors close soon",note:""}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
let browser;
try {
 browser=await launch();
 const out={errors:[],outside:0};
 for(const motion of ['no-preference','reduce']){
  const page=await browser.newPage();
  await page.route('**/*',route=>{out.outside++;return route.abort();});
  page.on('pageerror',error=>out.errors.push(error.message));
  await page.emulateMedia({reducedMotion:motion});
  await page.setContent('<div id="root"></div>');
  // The button's own rule from the store's style sheet, as the store draws it.
  await page.addStyleTag({content:toggleRule});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForSelector('.sp-countdown button');
  const look=()=>page.evaluate(()=>{const units=[...document.querySelectorAll('.sp-countdown-number')].map(n=>n.textContent);const b=document.querySelector('.sp-countdown button');const r=b.getBoundingClientRect();return {units:units.join(':'),button:b.textContent,width:r.width,height:r.height,until:[...document.querySelectorAll('.sp-countdown p')].some(p=>p.textContent.startsWith('Until '))};});
  const first=await look();
  await page.waitForTimeout(2200);
  const later=await look();
  const state={first,later};
  if(motion==='no-preference'){
   await page.focus('.sp-countdown button');await page.keyboard.press('Enter');
   state.paused=await look();
   await page.waitForTimeout(1200);
   state.pausedLater=await look();
   state.focusKept=await page.evaluate(()=>document.activeElement===document.querySelector('.sp-countdown button'));
   await page.keyboard.press('Enter');
   state.resumed=await look();
  }
  out[motion]=state;
  await page.close();
 }
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

type Look = { units: string; button: string; width: number; height: number; until: boolean };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  "no-preference": { first: Look; later: Look; paused: Look; pausedLater: Look; focusKept: boolean; resumed: Look };
  reduce: { first: Look; later: Look };
  errors: string[];
  outside: number;
};
const moving = result["no-preference"];
is("in the browser the countdown counts, its seconds changing", [moving.first.units.split(":").length, moving.first.units !== moving.later.units], [4, true]);
is("the button is at least 44 × 44 px as drawn", moving.first.width >= 44 && moving.first.height >= 44, true);
is("pressed from the keyboard, it stops the numbers: none are drawn, and \"Until …\" names the moment", [moving.paused.units, moving.paused.until, moving.paused.button], ["", true, "Resume countdown"]);
is("and nothing changes while it is stopped", moving.pausedLater, moving.paused);
is("the focus stays on the button", moving.focusKept, true);
is("pressed again, it counts again", [moving.resumed.units.split(":").length, moving.resumed.button], [4, "Pause countdown"]);
is("a visitor who asked for less motion starts with it stopped, and nothing moves", [result.reduce.first.units, result.reduce.later.units, result.reduce.first.until, result.reduce.first.button], ["", "", true, "Resume countdown"]);
is("the page asked nothing outside itself", result.outside, 0);
is("no browser error", result.errors, []);
done();
