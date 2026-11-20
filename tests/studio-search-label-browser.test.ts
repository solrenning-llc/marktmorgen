/**
 * The studio search box keeps its name while its label is not drawn (real React component in local Chromium;
 * every network request is refused). WebKit's signup matrix caught the label hidden for one frame while the
 * field was already audited, and axe then found a field named by its hint alone (label-title-only). axe 4.13 takes a
 * label's words, by for= or by aria-labelledby alike, only while the label is drawn, so the field carries the same
 * words itself (aria-label) and keeps its name whatever frame the label is in.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const axe=readFileSync(root+'/node_modules/axe-core/axe.min.js','utf8');
const entry=[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {StudioSearch} from "@/components/studio-search";',
 'createRoot(document.getElementById("root")).render(React.createElement(StudioSearch,{sid:"synthetic",buyers:true}));'
].join('\n');
const bundle=await build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
// Same installed-browser selection as tests/e2e/agreements.mjs; never download a browser.
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
const RULES=['label','label-title-only','aria-input-field-name'];
let browser;
try {
 browser=await launch();
 const page=await browser.newPage();let requests=0;const errors=[];
 await page.route('**/*',route=>{requests++;return route.abort();});
 page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<!doctype html><html lang="en"><head><title>Studio</title></head><body><main><div id="root"></div></main></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>{const box=document.querySelector('[role="search"]');return !!box&&!box.classList.contains('invisible')&&!box.inert;});
 await page.addScriptTag({content:axe});
 const audit=()=>page.evaluate(async rules=>{const found=await window.axe.run(document,{runOnly:rules});return found.violations.map(v=>v.id);},RULES);
 const shown=await audit();
 const name=await page.getByRole('combobox',{name:'Search the studio'}).count();
 // The frame WebKit audited: the field drawn, its label not.
 const hiddenNames={};
 for(const style of ['visibility:hidden','display:none']){
  await page.evaluate(css=>{document.querySelector('[role="search"] label').setAttribute('style',css);},style);
  hiddenNames[style]=await audit();
 }
 const wiring=await page.evaluate(()=>{const input=document.querySelector('[role="combobox"]'),label=document.querySelector('[role="search"] label');return {ownName:input.getAttribute('aria-label'),labelWords:label.textContent.trim(),labelledBy:input.hasAttribute('aria-labelledby'),forStill:label.htmlFor===input.id,describedBy:!!document.getElementById(input.getAttribute('aria-describedby')||'')};});
 console.log(JSON.stringify({shown,name,hiddenNames,wiring,requests,errors}));
} finally {if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000 })) as {
  shown: string[]; name: number; hiddenNames: Record<string, string[]>;
  wiring: { ownName: string | null; labelWords: string; labelledBy: boolean; forStill: boolean; describedBy: boolean };
  requests: number; errors: string[];
};
is("the drawn box has no field-name finding", result.shown, []);
is("the field is found by its visible name", result.name, 1);
is("a label hidden for a frame (visibility) leaves the field named", result.hiddenNames["visibility:hidden"], []);
is("a label not rendered for a frame (display none) leaves the field named", result.hiddenNames["display:none"], []);
is("the field carries the label's own words as its name (the visible name and the spoken one stay the same)", [result.wiring.ownName, result.wiring.labelWords], ["Search the studio", "Search the studio"]);
is("no second naming reference that could disagree with it", result.wiring.labelledBy, false);
is("the label still points at the field, so a click on it focuses the field", result.wiring.forStill, true);
is("the hint still describes the field", result.wiring.describedBy, true);
is("no outside request", result.requests, 0);
is("no browser error", result.errors, []);
done();
