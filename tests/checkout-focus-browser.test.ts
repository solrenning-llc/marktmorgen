/**
 * The focus in the checkout script's overlay and in the store's cart, in local Chromium with the real code; every outside request is refused.
 * - The overlay of the checkout script (lib/embed-sdk.ts loaderSource): its Close button shows its focus in forced colors
 *   (high contrast) too, where the browser drops box-shadow (WCAG 2.2 SC 2.4.7 and 2.4.13, read November 7, 2026:
 *   https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html, https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html),
 *   and only while it has the focus, so the focus can be told from the rest.
 * - The same overlay's card, when it loads, takes the focus only on its first load and only if the person has not moved
 *   on (3.2.1, 3.2.5): a slow card, or the card moving within its frame, never pulls the focus back from Close.
 * - The cart (components/store-cart.tsx): removing a product puts the focus on the next one (2.4.3), but a Remove that took
 *   nothing out never moves the focus later, on a change the person did not make (3.2.1, 3.2.5).
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

// Resolve browser/build tools at runtime rather than bundling their internals into this test (as tests/embed-editor-contrast.test.ts).
const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const shell={name:'review-link-shell',setup(b){b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'review'}));b.onLoad({filter:/.*/,namespace:'review'},()=>({contents:'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}',loader:'js',resolveDir:root}));}};
const loader=await build({stdin:{contents:'import {loaderSource} from "@/lib/embed-sdk";window.__loader=loaderSource("https://marktmorgen.com");',loader:'ts',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},logLevel:'error'});
const cart=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {CartButton} from "@/components/store-cart";',
 'createRoot(document.getElementById("root")).render(React.createElement(CartButton,{handle:"synthetic-store",lang:"en",notice:null}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',plugins:[shell]});
// Same installed-browser selection as tests/e2e/agreements.mjs; never download a browser.
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
 const out={overlay:{},errors:[],outside:0};
 const source=await (async()=>{const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<p></p>');await page.addScriptTag({content:loader.outputFiles[0].text});const s=await page.evaluate(()=>window.__loader);await page.close();return s;})();
 for(const forced of ['none','active']){
  const page=await browser.newPage();
  // The card itself is never loaded: only the host page and the script are under test.
  await page.route('**/*',route=>route.abort());
  page.on('pageerror',error=>out.errors.push(error.message));
  await page.emulateMedia({forcedColors:forced});
  await page.setContent('<a href="https://marktmorgen.com/embed/synthetic-store/abc123" data-mm="overlay">Buy the course</a>');
  await page.addScriptTag({content:source});
  await page.focus('a');await page.keyboard.press('Enter');
  await page.waitForSelector('dialog button');
  const look=()=>page.evaluate(()=>{const x=document.querySelector('dialog button'),c=getComputedStyle(x);return {focused:document.activeElement===x,outline:c.outlineStyle,outlineColor:c.outlineColor,shadow:c.boxShadow};});
  const rest=await look();
  // The card's frame holds the focus; Close is focused as the next stop in the dialog.
  await page.evaluate(()=>document.querySelector('dialog button').focus());
  const focus=await look();
  out.overlay[forced]={rest,focus};
  await page.close();
 }
 // A synthetic card, held back until the test lets it load, so the person can move first (a slow network).
 out.load={};out.cardOutside=0;
 for(const moved of [false,true]){
  const page=await browser.newPage();
  page.on('pageerror',error=>out.errors.push(error.message));
  let release;const gate=new Promise(r=>{release=r;});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://marktmorgen.com'||!url.pathname.startsWith('/embed/')){out.cardOutside++;return route.abort();}
   await gate;
   return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><button>Pay</button></body></html>'});
  });
  await page.setContent('<a href="https://marktmorgen.com/embed/synthetic-store/abc123" data-mm="overlay">Buy the course</a>');
  await page.addScriptTag({content:source});
  await page.focus('a');await page.keyboard.press('Enter');
  await page.waitForSelector('dialog iframe');
  await page.evaluate(()=>{window.__loads=0;document.querySelector('dialog iframe').addEventListener('load',()=>{window.__loads++;});});
  if(moved)await page.evaluate(()=>document.querySelector('dialog button').focus());
  release();
  await page.waitForFunction(()=>window.__loads===1);
  await page.waitForTimeout(50);
  const on=()=>page.evaluate(()=>document.activeElement.tagName);
  const first=await on();
  // The card moves within its frame (a call's times, a form sent) while the person is on Close.
  await page.evaluate(()=>document.querySelector('dialog button').focus());
  const card=page.frames().find(f=>f!==page.mainFrame());
  await card.evaluate(()=>{location.href=location.href+'?view=times';});
  await page.waitForFunction(()=>window.__loads===2);
  await page.waitForTimeout(50);
  out.load[moved?'moved':'stayed']={first,later:await on()};
  await page.close();
 }
 const page=await browser.newPage();
 page.on('pageerror',error=>out.errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='https://cart.test'){out.outside++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
  if(url.pathname==='/api/store/cart'){
   const ids=(url.searchParams.get('ids')||'').split(',').filter(Boolean);
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,items:ids.map(id=>({id,title:'Synthetic '+id,href:'/synthetic/'+id,price:'$10.00',ok:true})),total:'$'+(10*ids.length)+'.00',digital:true})});
  }
  return route.abort();
 });
 await page.goto('https://cart.test/');
 await page.evaluate(()=>localStorage.setItem('mm-cart:synthetic-store',JSON.stringify(['a1','b2'])));
 await page.addScriptTag({content:cart.outputFiles[0].text});
 const rows=n=>page.waitForFunction(n=>document.querySelectorAll('#cart .st-cart-panel li').length===n,n);
 const where=()=>page.evaluate(()=>{const a=document.activeElement;return {remove:Boolean(a&&a.matches('button[data-remove]')),name:(a&&(a.getAttribute('aria-label')||a.textContent)||'').trim()};});
 await page.focus('#cart .st-cart-open');await page.keyboard.press('Enter');
 await rows(2);
 await page.focus('#cart button[data-remove]');await page.keyboard.press('Enter');
 await rows(1);
 out.removed=await where();
 // Put back, then a Remove whose writing fails (storage full or refused): nothing comes out, so nothing may stay armed.
 await page.evaluate(()=>{localStorage.setItem('mm-cart:synthetic-store',JSON.stringify(['a1','b2']));window.dispatchEvent(new Event('mm-cart-changed'));});
 await rows(2);
 await page.evaluate(()=>{window.__set=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('QuotaExceededError (synthetic)');};});
 await page.focus('#cart button[data-remove]');await page.keyboard.press('Enter');
 await page.waitForTimeout(150);
 out.failedRows=await page.evaluate(()=>document.querySelectorAll('#cart .st-cart-panel li').length);
 await page.evaluate(()=>{Storage.prototype.setItem=window.__set;});
 // The person moves on to Close; then another tab adds a product to the same cart.
 await page.getByRole('button',{name:'Close',exact:true}).focus();
 await page.evaluate(()=>{localStorage.setItem('mm-cart:synthetic-store',JSON.stringify(['a1','b2','c3']));window.dispatchEvent(new StorageEvent('storage',{key:'mm-cart:synthetic-store'}));});
 await rows(3);
 await page.waitForTimeout(50);
 out.later=await where();
 await page.close();
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  overlay: Record<"none" | "active", Record<"rest" | "focus", { focused: boolean; outline: string; outlineColor: string; shadow: string }>>;
  load: Record<"stayed" | "moved", { first: string; later: string }>;
  cardOutside: number;
  removed: { remove: boolean; name: string };
  failedRows: number;
  later: { remove: boolean; name: string };
  errors: string[];
  outside: number;
};
const { overlay } = result;
is("the overlay's Close button really has the focus", [overlay.none.focus.focused, overlay.active.focus.focused], [true, true]);
is("in normal colors its two-color ring is unchanged", overlay.none.focus.shadow, "rgb(21, 17, 46) 0px 0px 0px 3px, rgb(255, 255, 255) 0px 0px 0px 6px");
is("in normal colors nothing else is drawn: its outline, if any, is transparent", overlay.none.focus.outline === "none" || overlay.none.focus.outlineColor === "rgba(0, 0, 0, 0)", true);
is("in forced colors the browser drops the ring", overlay.active.focus.shadow, "none");
is("so in forced colors Close shows its focus with an outline in the system's color (2.4.7, 2.4.13)", overlay.active.focus.outline !== "none", true);
is("and only while it has the focus, so the focus can be told apart", overlay.active.rest.outline, "none");
is("a card that loads while the person waits takes the focus into its frame", result.load.stayed.first, "IFRAME");
is("a card that loads after the person moved on to Close leaves the focus on Close", result.load.moved.first, "BUTTON");
is("and the card moving within its frame never pulls the focus back from Close", [result.load.stayed.later, result.load.moved.later], ["BUTTON", "BUTTON"]);
is("the synthetic card asked nothing outside itself", result.cardOutside, 0);
is("removing a product puts the focus on the next one's Remove (2.4.3)", result.removed, { remove: true, name: "Remove Synthetic b2" });
is("a Remove whose writing failed takes nothing out", result.failedRows, 2);
is("and never moves the focus later, when another tab changes the cart", result.later, { remove: false, name: "Close" });
is("the cart asked nothing outside its own synthetic page", result.outside, 0);
is("no browser error", result.errors, []);
done();
