/**
 * The welcome offer's countdown (components/welcome-countdown.tsx) changed every second beside the rest of the page,
 * with no way to stop it: moving content that starts by itself needs a way to pause it (WCAG 2.2.2 Pause, Stop,
 * Hide, level A), and a person who asked their system for less motion should not get a number ticking every second
 * (2.3.3). Now a button pauses it and starts it again, and with prefers-reduced-motion it shows hours and minutes
 * and changes once a minute. The moment it ends and the words around it do not change. The sales page countdown
 * (components/countdown.tsx) is done by #4104. Checked in local Chromium with the real code.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {WelcomeCountdown} from "@/components/welcome-countdown";',
 'import {welcomeWords} from "@/lib/buyer-words/welcome";',
 'const ww=welcomeWords("en");',
 'const until=Math.floor(Date.now()/1000)+2*3600+125;',
 'createRoot(document.getElementById("root")).render(React.createElement(WelcomeCountdown,{until,left:ww.left,untilWords:ww.until("{when}"),locale:"en-US",pause:ww.pause,resume:ww.resume}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env':JSON.stringify({NODE_ENV:'production'})},logLevel:'error'});
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}
}
let browser;
try{
 browser=await launch();
 const out={errors:[]};
 for(const motion of ['no-preference','reduce']){
  const page=await browser.newPage();
  page.on('pageerror',e=>out.errors.push(e.message));
  await page.emulateMedia({reducedMotion:motion});
  await page.route('**/*',r=>r.abort());
  await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
  await page.addScriptTag({content:app.outputFiles[0].text});
  await page.waitForSelector('[data-welcome-left]');
  const read=()=>page.evaluate(()=>{const t=document.querySelector('[data-welcome-left]');return t?t.textContent.replace(/^Ends in\s*/,'').trim():null;});
  const first=await read();
  await page.waitForTimeout(1300);
  const later=await read();
  const r={first,later,changed:first!==later};
  const pause=page.getByRole('button',{name:/^Pause countdown$/});
  r.hasPause=await pause.count();
  if(r.hasPause){
   await pause.click();
   const a=await read();await page.waitForTimeout(1300);const b=await read();
   r.paused={a,b,resume:await page.getByRole('button',{name:/^Resume countdown$/}).count()};
   await page.getByRole('button',{name:/^Resume countdown$/}).click();
   r.resumed=await read();
  }
  out[motion]=r;
  await page.close();
 }
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

type Run = { first: string | null; later: string | null; changed: boolean; hasPause: number; paused?: { a: string | null; b: string | null; resume: number }; resumed?: string | null };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as { errors: string[]; "no-preference": Run; reduce: Run };
const counting = result["no-preference"];
const still = result.reduce;

is("no page error", result.errors, []);
is("without a motion setting it counts the seconds", [/^\d+:\d\d:\d\d$/.test(counting.first ?? ""), counting.changed], [true, true]);
is("it has a Pause countdown button", counting.hasPause, 1);
is("paused, the numbers stop (they are not shown)", [counting.paused?.a, counting.paused?.b], [null, null]);
is("and the button says Resume countdown", counting.paused?.resume, 1);
is("Resume starts it again", /^\d+:\d\d:\d\d$/.test(counting.resumed ?? ""), true);
is("with less motion asked for: hours and minutes, not changing every second", [/^\d+:\d\d$/.test(still.first ?? ""), still.changed], [true, false]);
is("and it can be paused too", still.hasPause, 1);
done();
