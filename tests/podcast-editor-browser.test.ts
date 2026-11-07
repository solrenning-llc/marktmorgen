/**
 * The podcast studio's transcripts in a real browser (274 [AX1] Part B.3; pre-review of
 * claude5/ax274-podcast-transcript). The real PodcastEditor runs in local Chromium; the studio's answers are played
 * by a local stand-in, the upload by a stub that names the file it was given, and every other request is refused.
 * No network, no storage, no email. Checked:
 *
 *   - two tabs: when the answer to "put the episode out" also holds an episode another tab put out a moment before,
 *     the transcript chosen with the new episode goes to the episode whose audio was just uploaded, never the other;
 *   - when the new episode is not in that answer, nothing is sent and the studio says so plainly, never
 *     "Transcript added.";
 *   - each episode's transcript field and buttons carry the episode's title in their accessible names (WCAG 2.4.6,
 *     2.4.9), each name beginning with the words on screen (2.5.3);
 *   - after a transcript is removed, focus goes to the field that adds one (WCAG 2.4.3), not to the page's start;
 *   - "Press again to remove" goes back by itself when focus leaves the button, and after a few seconds.
 */
import { execFileSync } from "node:child_process";
import { done, is, part } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const STUBS={
 '@/lib/sold-file-upload':'export async function uploadSoldFile(file,where){return "stores/"+where.folder+"/"+where.ownerId+"/"+file.name;} export function uploadReason(){return "server_error";}',
 '@/components/toast':'export function toast(message){(window.__toasts||(window.__toasts=[])).push(message);}',
};
const entry=[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {PodcastEditor} from "@/components/podcast-editor";',
 'window.renderEditor=(initial)=>{createRoot(document.getElementById("root")).render(React.createElement("div",null,React.createElement(PodcastEditor,{productId:"prod1",folder:"f",initial}),React.createElement("button",{type:"button",id:"elsewhere"},"Elsewhere")));};'
].join('\n');
const bundle=await build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,jsx:'automatic',define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',plugins:[{name:'studio-stubs',setup(b){
 b.onResolve({filter:/^@\//},async(args)=>{
  if(STUBS[args.path])return {path:args.path,namespace:'stub'};
  return b.resolve('./'+args.path.slice(2),{resolveDir:root,kind:args.kind});
 });
 b.onLoad({filter:/.*/,namespace:'stub'},(args)=>({contents:STUBS[args.path],loader:'js'}));
}}]});

async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}

const episode=(id,title,pathname,at,transcript=null)=>({id,title,notes:'',pathname,bytes:1000,contentType:'audio/mpeg',at,transcript});
let mode='two-tabs', posts=[], refused=0, podcast={id:'d'.repeat(32),episodes:[]};
const answer=(route,body)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
const out={};
let browser;
try {
 browser=await launch();
 const page=await browser.newPage();const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async(route)=>{
  const url=new URL(route.request().url());
  if(url.origin!=='http://studio.test'){refused++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});
  if(url.pathname!=='/api/store/podcast'){refused++;return route.abort();}
  const body=JSON.parse(route.request().postData()||'{}');posts.push(body);
  if(body.action==='add'){
   // Another tab put an episode out a moment before: the answer lists it first.
   const theirs=episode('tttttttttttt','From the other tab','stores/f/prod1/other-tab.mp3',100);
   const ours=episode('oooooooooooo',body.title,body.pathname,101);
   podcast={...podcast,episodes:mode==='two-tabs'?[theirs,...podcast.episodes,ours]:[theirs,...podcast.episodes]};
   return answer(route,{ok:true,podcast});
  }
  if(body.action==='transcript'){
   podcast={...podcast,episodes:podcast.episodes.map(e=>e.id!==body.episode?e:{...e,transcript:body.remove?null:{pathname:body.pathname,bytes:12}})};
   return answer(route,{ok:true,podcast});
  }
  return answer(route,{ok:false,error:'invalid'});
 });
 const open=async(initial)=>{
  podcast=initial;posts=[];
  await page.goto('http://studio.test/');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate((p)=>{window.__toasts=[];window.renderEditor(p);},initial);
 };
 const putOut=async()=>{
  await page.getByLabel('Title').fill('The new one');
  await page.getByLabel('The audio').setInputFiles({name:'new-episode.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('ID3')});
  await page.getByLabel('Transcript (optional)').setInputFiles({name:'new-words.txt',mimeType:'text/plain',buffer:Buffer.from('Hello there.')});
  await page.getByRole('button',{name:'Put the episode out'}).click();
 };

 // Two tabs.
 mode='two-tabs';
 await open({id:'d'.repeat(32),episodes:[]});
 await putOut();
 await page.waitForFunction(()=>(window.__toasts||[]).length>=2,null,{timeout:10000}).catch(()=>{});
 out.twoTabs={transcriptTo:posts.filter(p=>p.action==='transcript').map(p=>p.episode),toasts:await page.evaluate(()=>window.__toasts),alert:await page.locator('[role=alert]').allTextContents()};

 // The new episode not in the answer.
 mode='missing';
 await open({id:'d'.repeat(32),episodes:[]});
 await putOut();
 await page.waitForFunction(()=>document.querySelector('[role=alert]')||(window.__toasts||[]).includes('Transcript added.'),null,{timeout:10000}).catch(()=>{});
 out.missing={transcripts:posts.filter(p=>p.action==='transcript').length,toasts:await page.evaluate(()=>window.__toasts),alert:await page.locator('[role=alert]').allTextContents()};

 // One episode with a transcript, one without: names, focus, and the second press going back.
 await open({id:'d'.repeat(32),episodes:[episode('aaaaaaaaaaaa','Morning show','stores/f/prod1/a.mp3',1,{pathname:'stores/f/prod1/a.txt',bytes:2048}),episode('bbbbbbbbbbbb','Evening show','stores/f/prod1/b.mp3',2)]});
 const named=async(role,name)=>(await page.getByRole(role,{name,exact:true}).count());
 out.names={
  replaceField:await page.getByLabel('Replace the transcript (.txt) of “Morning show”',{exact:true}).count(),
  addField:await page.getByLabel('Add a transcript (.txt) to “Evening show”',{exact:true}).count(),
  uploadNew:await named('button','Upload the new transcript for “Morning show”'),
  upload:await named('button','Upload the transcript for “Evening show”'),
  remove:await named('button','Remove the transcript of “Morning show”'),
 };
 // Found by the words on screen inside the episode's own item, so the same steps run on code without the titled names.
 const morning=()=>page.locator('li',{hasText:'Morning show'});
 const removeButton=()=>morning().getByRole('button',{name:/^(Remove the transcript|Press again to remove)/});
 // Read and pressed only while it is there: on code where it is gone too early, the checks below say so.
 const removeText=async()=>(await removeButton().count())?await removeButton().textContent():null;
 const pressRemove=async()=>{if(await removeButton().count())await removeButton().click();};
 await pressRemove();
 const pressAgain=await removeText();
 await page.locator('#elsewhere').focus();
 await page.waitForTimeout(100);
 const afterBlur=await removeText();
 await pressRemove();
 const armed=await removeText();
 await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Press again to remove')),null,{timeout:9000}).catch(()=>{});
 const afterWait=await removeText();
 out.reset={pressAgain,afterBlur,armed,afterWait};
 await pressRemove();
 await pressRemove();
 await page.waitForFunction(()=>![...document.querySelectorAll('li')].some(li=>li.textContent.includes('Morning show')&&[...li.querySelectorAll('button')].some(b=>/^Remove the transcript|^Press again to remove/.test(b.textContent))),null,{timeout:5000}).catch(()=>{});
 await page.waitForTimeout(100);
 out.focus=await page.evaluate(()=>{const a=document.activeElement;return {tag:a?.tagName,type:a?.getAttribute('type'),label:a?.id?document.querySelector('label[for="'+CSS.escape(a.id)+'"]')?.textContent:null};});
 out.removed=posts.filter(p=>p.action==='transcript'&&p.remove).map(p=>p.episode);
 out.refused=refused;out.errors=errors;
 console.log(JSON.stringify(out));
} finally {if(browser)await browser.close();}
`;

type Result = {
  twoTabs: { transcriptTo: string[]; toasts: string[]; alert: string[] };
  missing: { transcripts: number; toasts: string[]; alert: string[] };
  names: { replaceField: number; addField: number; uploadNew: number; upload: number; remove: number };
  reset: { pressAgain: string | null; afterBlur: string | null; armed: string | null; afterWait: string | null };
  focus: { tag: string; type: string | null; label: string | null };
  removed: string[];
  refused: number;
  errors: string[];
};
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 })) as Result;

part("Two tabs: the transcript goes to the episode whose audio was just uploaded");
is("sent once, to the new episode, never the other tab's", result.twoTabs.transcriptTo, ["oooooooooooo"]);
is("and said so", result.twoTabs.toasts.includes("Transcript added."), true);
is("no error", result.twoTabs.alert, []);

part("The new episode not in the answer: nothing sent, said plainly");
is("no transcript sent to any episode", result.missing.transcripts, 0);
is("never \"Transcript added.\"", result.missing.toasts.includes("Transcript added."), false);
is("the studio says the transcript was not added, and where to add it", result.missing.alert.some((a) => /transcript was not added/.test(a) && /add it from the episode/i.test(a)), true);

part("Each episode's transcript controls name their episode");
is("the field, the buttons: each name holds the episode's title, after the words on screen", result.names, { replaceField: 1, addField: 1, uploadNew: 1, upload: 1, remove: 1 });

part("\"Press again to remove\" goes back by itself");
is("the first press asks again", result.reset.pressAgain?.startsWith("Press again to remove the transcript") ?? null, true);
is("focus leaving the button takes it back", result.reset.afterBlur?.startsWith("Remove the transcript") ?? null, true);
is("pressed again, it asks again", result.reset.armed?.startsWith("Press again to remove the transcript") ?? null, true);
is("and a few seconds later it goes back on its own", result.reset.afterWait?.startsWith("Remove the transcript") ?? null, true);

part("After a removal, focus goes to the field that adds one");
is("removed once, from that episode", result.removed, ["aaaaaaaaaaaa"]);
is("focus is on the episode's \"Add a transcript\" field", [result.focus.tag, result.focus.type, result.focus.label], ["INPUT", "file", "Add a transcript (.txt) to “Morning show”"]);

part("Nothing else");
is("no request left the page", result.refused, 0);
is("no page error", result.errors, []);

done();
