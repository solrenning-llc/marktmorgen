/**
 * AX274 Part A item 6 on the sales page coach (lib/page-coach.ts,
 * components/page-coach.tsx): "Every picture described" and "Every button says
 * what it does" offer their fix in one click. Each names the first part of the
 * page being edited that misses it, and its "Show me" opens that part with the
 * focus in the exact field (a picture's description, a button's words) in the
 * page editor. Nothing is filled in or changed: the creator writes and saves.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { coachChecks, type CoachCheck, type CoachInput } from "@/lib/page-coach";
import { done, is, part } from "./check";

const picture = (alt: string) => ({ path: `images/${"a".repeat(24)}/${"1".repeat(32)}.jpg`, width: 1200, height: 800, alt, caption: "" });
const page = {
  blocks: [
    { id: "b1", kind: "pictures", items: [picture("A loaf on a board")] },
    { id: "b2", kind: "pictures", items: [picture("")] },
    { id: "b3", kind: "cta", label: "Get the book", note: "" },
    { id: "b4", kind: "cta", label: "Click here", note: "" },
  ],
  variant: null,
  seoDescription: "",
  test: null,
} as unknown as CoachInput["page"];

type WithFix = CoachCheck & { fix?: { field: string; block: string } };

part("Each check names the first part that misses it");
const checks = coachChecks({ page, productTitle: "Bread Book", free: false, picture: false, pictureAlt: "", facts: {} } as unknown as CoachInput) as WithFix[];
const described = checks.find((c) => c.id === "described");
const words = checks.find((c) => c.id === "button_words");
is("the picture with no description: its block and its field", described?.fix, { field: "alt", block: "b2" });
is("the button whose words say nothing: its block and its field", words?.fix, { field: "button-words", block: "b4" });
const fine = coachChecks({ page: { ...page, blocks: page.blocks.slice(0, 1) }, productTitle: "Bread Book", free: false, picture: false, pictureAlt: "", facts: {} } as unknown as CoachInput) as WithFix[];
is("nothing to fix: nothing named", fine.find((c) => c.id === "described")?.fix, undefined);

part("The coach offers it");
const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const page=${JSON.stringify(page)};
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {PageCoach} from "@/components/page-coach";',
 'window.__fixes=[];',
 'createRoot(document.getElementById("root")).render(React.createElement(PageCoach,{productId:"p1",productTitle:"Bread Book",free:false,picture:false,pictureAlt:"",facts:{},page:'+JSON.stringify(page)+',reach:null,onAdd:()=>{},onHeadline:()=>{},onTest:()=>{},onFit:()=>{},onQuestions:()=>{},onFix:(fix)=>window.__fixes.push(fix)}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out={};
try{
 browser=await launch();
 const tab=await browser.newPage();
 await tab.route('**/*',route=>route.abort());
 await tab.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await tab.addScriptTag({content:bundle.outputFiles[0].text});
 await tab.waitForTimeout(200);
 await tab.getByRole('button',{name:'See what to improve'}).click();
 await tab.waitForTimeout(100);
 out.names=await tab.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent).filter(t=>t.startsWith('Show me')));
 for (const name of out.names) await tab.getByRole('button',{name}).click();
 out.fixes=await tab.evaluate(()=>window.__fixes);
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;
let result: { names: string[]; fixes: { field: string; block: string }[] } | null = null;
try {
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 }));
} catch (error) {
  console.log(String(error).slice(0, 1500));
  result = null;
}
is("the coach runs in a browser", result !== null, true);
if (result) {
  is("a Show me for the picture and one for the button, each saying which", [...result.names].sort(), ["Show me the first button whose words say nothing", "Show me the first picture with no description"]);
  is("pressed, each hands the editor its part and field", [...result.fixes].sort((a, b) => a.block.localeCompare(b.block)), [{ field: "alt", block: "b2" }, { field: "button-words", block: "b4" }]);
}

part("The page editor opens the part and focuses the field, and only when pressed");
const editor = readFileSync("components/page-editor.tsx", "utf8");
is("the coach's Show me is answered by the editor", /onFix=\{showFix\}/.test(editor), true);
is("which opens that part and focuses its field once drawn", /function showFix\([\s\S]{0,400}setOpen\(fix\.block\)[\s\S]{0,600}focusWhenDrawn\([\s\S]{0,300}data-fix="\$\{fix\.field\}"/.test(editor), true);
is("a picture's description field is marked for it", /data-fix="alt"/.test(editor), true);
is("each button's words field is marked for it", (editor.match(/data-fix="button-words"/g) ?? []).length, 3);
done();
