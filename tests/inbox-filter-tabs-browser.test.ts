/**
 * The inbox's filter tabs (components/inbox-studio.tsx: Open, Mine, Closed, All), in local Chromium with the real
 * code; every outside request is refused.
 *
 * They were role="tab" buttons with no more of the pattern: each was its own stop for Tab, the arrow keys did
 * nothing, and no tab panel said what they show. WAI-ARIA Authoring Practices, "Tabs Pattern" (read November 13,
 * 2026): one tab in the Tab sequence (the selected one), Left and Right move between tabs (Home and End to the
 * first and last), and each tab controls a tabpanel labeled by it. The same as the tabs of the buyer's path
 * (components/buyer-path.tsx). WCAG 2.1.1, 4.1.2.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const shims={name:'shims',setup(b){
 b.onResolve({filter:/^next\/(navigation|link)$/},a=>({path:a.path,namespace:'shim'}));
 b.onLoad({filter:/.*/,namespace:'shim'},a=>({contents:a.path==='next/link'
  ?'import React from "react";export default function Link({children,...p}){return React.createElement("a",p,children)}'
  :'export function useRouter(){return {refresh(){},push(){},replace(){}}} export function usePathname(){return "/studio/inbox"} export function useSearchParams(){return new URLSearchParams()}',
  loader:'js',resolveDir:root}));
}};
const app=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {InboxStudio} from "@/components/inbox-studio";',
 'window.fetch=async()=>new Response(JSON.stringify({ok:true,list:[]}),{headers:{"Content-Type":"application/json"}});',
 'createRoot(document.getElementById("root")).render(React.createElement(InboxStudio,{me:"owner@example.com",initial:[],first:null,people:[],setting:{chat:false,saved:[]},ai:{on:false,left:0},canSettings:false,chatBlock:"",readAt:Date.now()}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',plugins:[shims]});
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}
}
let browser;
try{
 browser=await launch();
 const page=await browser.newPage();
 const out={errors:[]};
 page.on('pageerror',e=>out.errors.push(e.message));
 await page.route('**/*',r=>r.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.addScriptTag({content:app.outputFiles[0].text});
 await page.waitForSelector('[role=tablist]');
 const state=()=>page.evaluate(()=>{
  const tabs=[...document.querySelectorAll('[role=tablist] [role=tab]')];
  const a=document.activeElement;
  const sel=tabs.find(t=>t.getAttribute('aria-selected')==='true');
  const panelId=sel&&sel.getAttribute('aria-controls');
  const panel=panelId?document.getElementById(panelId):null;
  return {
   stops:tabs.filter(t=>t.tabIndex===0).map(t=>t.textContent.split(' ')[0]),
   selected:sel?sel.textContent.split(' ')[0]:null,
   focused:a&&a.getAttribute('role')==='tab'?a.textContent.split(' ')[0]:null,
   panel:panel?{role:panel.getAttribute('role'),labelledBy:panel.getAttribute('aria-labelledby')===sel.id&&!!sel.id}:null,
  };
 });
 out.start=await state();
 await page.locator('[role=tab][aria-selected=true]').focus();
 await page.keyboard.press('ArrowRight'); out.right=await state();
 await page.keyboard.press('End'); out.end=await state();
 await page.keyboard.press('ArrowRight'); out.wrap=await state();
 await page.keyboard.press('ArrowLeft'); out.left=await state();
 await page.keyboard.press('Home'); out.home=await state();
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

type State = { stops: string[]; selected: string | null; focused: string | null; panel: { role: string | null; labelledBy: boolean } | null };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as Record<"start" | "right" | "end" | "wrap" | "left" | "home", State> & { errors: string[] };

is("no page error", result.errors, []);
is("one stop for Tab: the selected tab", result.start.stops, ["Open"]);
is("it controls a tab panel labeled by it", result.start.panel, { role: "tabpanel", labelledBy: true });
is("Right selects and focuses the next tab", [result.right.selected, result.right.focused, result.right.stops], ["Mine", "Mine", ["Mine"]]);
is("End goes to the last", [result.end.selected, result.end.focused], ["All", "All"]);
is("Right on the last goes round to the first", [result.wrap.selected, result.wrap.focused], ["Open", "Open"]);
is("Left goes round to the last", [result.left.selected, result.left.focused], ["All", "All"]);
is("Home goes to the first", [result.home.selected, result.home.focused, result.home.stops], ["Open", "Open", ["Open"]]);
is("the panel follows the selected tab", result.home.panel, { role: "tabpanel", labelledBy: true });
done();
