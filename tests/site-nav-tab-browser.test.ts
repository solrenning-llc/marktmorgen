/**
 * Tab and Shift+Tab through the site's main menu with a menu open, in local Chromium with the real SiteNav
 * (components/site-nav.tsx; 524 [NV1], #3663). Every outside request is refused.
 *
 * Tab on an open menu's button goes into its panel, but the panel is drawn after the whole row and after Log in and
 * Start. So without care the focus order breaks (WCAG 2.2 SC 2.4.3 Focus Order, read November 11, 2026:
 * https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html): Tab from the panel's last link would leave the header,
 * skipping the rest of the row, and Shift+Tab from its first link would land on the control drawn just before the
 * panel instead of the menu's button. What must hold, as on main before the change for everything but the panel:
 *   - Tab from the open menu's button: its first link;
 *   - Tab through the panel's links in order, then from the last one: the row's next item after that button;
 *   - Shift+Tab from the panel's first link: back on the menu's button;
 *   - with no menu open, Tab from a menu's button: the row's next item, as before.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

// Resolve browser/build tools at runtime rather than bundling their internals into this test (as tests/checkout-focus-browser.test.ts).
const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const shell={name:'nav-link-shell',setup(b){b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'nav'}));b.onLoad({filter:/.*/,namespace:'nav'},()=>({contents:'import React from "react";export default function Link({children,prefetch,...props}){return React.createElement("a",props,children)}',loader:'tsx',resolveDir:root}));}};
const nav=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {SiteNav} from "@/components/site-nav";',
 'createRoot(document.getElementById("root")).render(React.createElement(React.Fragment,null,React.createElement(SiteNav),React.createElement("main",null,React.createElement("a",{href:"/after",id:"after"},"After the header"))));'
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
 const out={errors:[],outside:0};
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('pageerror',error=>out.errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://nav.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
  out.outside++;return route.abort();
 });
 await page.goto('https://nav.test/');
 await page.addScriptTag({content:nav.outputFiles[0].text});
 await page.waitForSelector('nav[aria-label="Main"] button[aria-controls]');
 const where=()=>page.evaluate(()=>{const a=document.activeElement;if(!a||a===document.body)return 'body';const panel=a.closest('[id^="menu-"]');return (panel?panel.id+' > ':'')+(a.getAttribute('aria-label')||a.textContent||'').trim().replace(/\s+/g,' ').slice(0,40);});
 const row=await page.evaluate(()=>[...document.querySelectorAll('nav[aria-label="Main"] > a, nav[aria-label="Main"] > button')].map(x=>(x.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)));
 out.row=row;
 const first=page.locator('nav[aria-label="Main"] > button[aria-controls]').first();
 const control=await first.getAttribute('aria-controls');
 out.control=control;
 // No menu open: Tab from the first menu's button goes along the row.
 await first.focus();
 await page.keyboard.press('Tab');
 out.closedTab=await where();
 // Open it from the keyboard, then Tab in.
 await first.focus();
 await page.keyboard.press('Enter');
 await page.waitForSelector('#'+control+' a[href]');
 const links=await page.locator('#'+control+' a[href]').count();
 out.links=links;
 await first.focus();
 await page.keyboard.press('Tab');
 out.enter=await where();
 out.walk=[];
 for(let i=1;i<links;i++){await page.keyboard.press('Tab');out.walk.push(await where());}
 await page.keyboard.press('Tab');
 out.afterLast=await where();
 out.openAfterLast=await page.evaluate(c=>Boolean(document.getElementById(c)),control);
 // Back in, then Shift+Tab from the first link.
 await first.focus();
 if(!(await page.evaluate(c=>Boolean(document.getElementById(c)),control))){await page.keyboard.press('Enter');await page.waitForSelector('#'+control+' a[href]');await first.focus();}
 await page.keyboard.press('Tab');
 await page.keyboard.press('Shift+Tab');
 out.backFromFirst=await where();
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  errors: string[];
  outside: number;
  row: string[];
  control: string;
  closedTab: string;
  links: number;
  enter: string;
  walk: string[];
  afterLast: string;
  openAfterLast: boolean;
  backFromFirst: string;
};

const button = result.row[0];
const nextInRow = result.row[1];
is("the row has a menu first and something after it", [result.row.length > 1, typeof button === "string" && button.length > 0], [true, true]);
is("no menu open: Tab from its button goes to the row's next item, as before", result.closedTab, nextInRow);
is("Tab from the open menu's button: its first link", result.enter.startsWith(`${result.control} > `), true);
is("Tab walks the panel's links in order, every one of them", [result.walk.length, result.walk.every((w) => w.startsWith(`${result.control} > `))], [result.links - 1, true]);
is("Tab from the panel's last link: the row's next item, never past the header", result.afterLast, nextInRow);
is("and the panel it left is closed", result.openAfterLast, false);
is("Shift+Tab from the panel's first link: back on the menu's button", result.backFromFirst, button);
is("no page error, nothing fetched from outside", [result.errors, result.outside], [[], 0]);
done();
