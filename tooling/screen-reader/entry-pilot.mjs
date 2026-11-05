import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {resolve,join} from "node:path";
import {nvda,voiceOver} from "@guidepup/guidepup";
import {resetVoiceOverRunner} from "./reset-voiceover.mjs";
import {navigateToContent} from "./navigate-to-content.mjs";
import {startWindowsForegroundProbe} from "./windows-foreground.mjs";
const root=resolve("../.."),require=createRequire(join(root,"package.json"));
const kind=process.platform==="win32"?"nvda":process.platform==="darwin"?"voiceover":null;
if(!kind)throw Error("Real reader pilot requires Windows or macOS");
const engine=kind==="nvda"?"chromium":"webkit",reader=kind==="nvda"?nvda:voiceOver;
const port=3196,origin="http://127.0.0.1:"+port;
const app=spawn(process.execPath,[join(root,"node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(port)],{cwd:root,env:{...process.env,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
let output="",browser,context,foreground,writes=0,foreign=0,primaryFailure=false,stage="local app startup";
for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{output=(output+chunk).slice(-6000);});
async function report(step,expected){
 const spoken=await reader.lastSpokenPhrase();
 console.log("AX2_REAL_READER_STEP:"+JSON.stringify({reader:kind,step,expected,spoken}));
 assert.equal(typeof spoken,"string","Reader must return spoken text");
 for(const fragment of expected)assert.ok(spoken.toLowerCase().includes(fragment.toLowerCase()),"Missing spoken "+fragment+" at "+step);
}
try{
 let up=false;
 for(let n=0;n<120;n++){
  if(app.exitCode!==null)throw Error(output);
  try{up=(await fetch(origin+"/signin")).ok;}catch{}
  if(up)break;await new Promise(resolve=>setTimeout(resolve,500));
 }
 assert.ok(up,"Local synthetic app did not start: "+output);
 if(kind==="nvda"&&process.env.GITHUB_ACTIONS==="true"){
  // Start the hidden persistent observer before any browser window exists.
  try{foreground=await startWindowsForegroundProbe();}
  catch(error){console.error("AX2_NVDA_NATIVE_FOREGROUND_UNKNOWN:"+JSON.stringify({stage:"observer startup",error:String(error)}));}
 }
 browser=await require("playwright-core")[engine].launch({headless:false});
 context=await browser.newContext({serviceWorkers:"block",locale:"en-US"});
 await context.route("**/*",route=>{
  const request=route.request(),url=new URL(request.url());
  if(!["GET","HEAD"].includes(request.method())){writes++;return route.abort();}
  if(url.origin!==origin){foreign++;return route.abort();}
  return route.continue();
 });
 const page=await context.newPage();
 if(kind==="voiceover"&&process.env.GITHUB_ACTIONS==="true"){
  stage="disposable runner reader preflight";
  const result=await resetVoiceOverRunner();
  console.log("AX2_REAL_READER_PREFLIGHT:"+JSON.stringify({reader:kind,...result}));
 }
 stage="real reader startup";
 await reader.start({capture:"initial"});
 for(const fixture of [{path:"/signin",heading:"Start your store"},{path:"/signin?to=login",heading:"Log in to your store"}]){
  stage="entry navigation "+fixture.path;
  const response=await page.goto(origin+fixture.path,{waitUntil:"networkidle",timeout:60000});
  assert.equal(response.status(),200);
  // Verify the expected application state independently before checking speech.
  await page.getByRole("heading",{level:1,name:fixture.heading,exact:true}).waitFor();
  stage="reader content navigation "+fixture.path;
  await navigateToContent(reader,page,kind,foreground);
  stage="reader heading assertions "+fixture.path;
  let matched=false;
  for(let step=0;step<8;step++){
   await reader.nextHeading();
   const spoken=await reader.lastSpokenPhrase();
   console.log("AX2_REAL_READER_STEP:"+JSON.stringify({reader:kind,step:"heading navigation "+fixture.path+" "+step,spoken}));
   if(spoken.toLowerCase().includes(fixture.heading.toLowerCase())){matched=true;break;}
  }
  assert.ok(matched,"Required entry heading was not announced");
  await report("entry heading "+fixture.path,[fixture.heading,"heading","1"]);
 }
 const phrases=await reader.spokenPhraseLog();
 assert.ok(Array.isArray(phrases)&&phrases.length>0&&phrases.length<=1000,"Unexpected transcript size; fail rather than truncate");
 console.log("AX2_REAL_READER_TRANSCRIPT:"+JSON.stringify({reader:kind,engine,phrases}));
 assert.equal(writes,0,"Entry pilot must not submit anything");
 assert.equal(foreign,0,"No browser request may leave local synthetic origin");
 console.log("AX2_REAL_READER_RESULT:"+JSON.stringify({reader:kind,engine,entryStates:2,writes,foreign,scope:"Entry headings only; account creation, purchase, course, cancellation and refund tasks remain untested"}));
}catch(error){
 primaryFailure=true;
 console.error("AX2_REAL_READER_PRIMARY_ERROR:"+JSON.stringify({reader:kind,stage,error:String(error),stack:error instanceof Error?error.stack:null}));
 throw error;
}finally{
 try{const phrases=await reader.spokenPhraseLog();if(Array.isArray(phrases)&&phrases.length<=1000)console.log("AX2_REAL_READER_FINAL_TRANSCRIPT:"+JSON.stringify({reader:kind,phrases}));}catch(error){console.error("Transcript unavailable",String(error));}
 const cleanupErrors=[];
 for(const [step,close] of [
  ["reader stop",()=>reader.stop()],
  ["foreground observer close",()=>foreground?.close()],
  ["browser context close",()=>context?.close()],
  ["browser close",()=>browser?.close()],
  ["local app stop",()=>app.kill()],
 ]){
  try{await close();}catch(error){
   cleanupErrors.push(error);
   console.error("AX2_REAL_READER_CLEANUP_ERROR:"+JSON.stringify({reader:kind,step,error:String(error)}));
  }
 }
 if(!primaryFailure&&cleanupErrors.length)throw cleanupErrors[0];
}
