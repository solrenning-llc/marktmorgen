import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
const refuse=message=>{throw Error("Invalid screen reader evidence: "+message);};
const record=value=>{if(!value||typeof value!=="object"||Array.isArray(value))refuse("object required");return value;};
const instant=value=>{if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(value)||!Number.isFinite(Date.parse(value)))refuse("UTC timestamp");return Date.parse(value);};
export function generateReaderResults(input){
 const data=record(input);
 if(data.schemaVersion!==1||!Array.isArray(data.sources)||data.sources.length!==2)refuse("two real-reader sources required");
 const identities=new Set(),jobs=new Set(),heads=new Set();
 const readers=data.sources.map(raw=>{
  const source=record(raw),engine={nvda:"chromium",voiceover:"webkit"}[source.reader];
  if(!engine||identities.has(source.reader))refuse("reader identity");
  identities.add(source.reader);
  if(source.conclusion!=="success"||!Number.isSafeInteger(source.jobId)||source.jobId<=0||jobs.has(source.jobId))refuse("successful unique job");
  jobs.add(source.jobId);
  const url=typeof source.url==="string"&&source.url.match(/^https:\/\/github\.com\/(?:viniciussucupira|solrenning-llc)\/marktmorgen\/actions\/runs\/[1-9]\d*\/job\/(\d+)$/);
  if(!url||Number(url[1])!==source.jobId)refuse("canonical job URL");
  if(typeof source.head!=="string"||!(/^[a-f0-9]{40}$/).test(source.head))refuse("revision");
  heads.add(source.head);
  const completed=instant(source.completedAt);
  if(!Array.isArray(source.events)||!source.events.length||source.events.length>1000)refuse("events");
  for(const event of source.events){record(event);if(instant(event.at)>completed)refuse("event after completion");record(event.value);if(event.value.reader!==source.reader)refuse("event reader mismatch");}
  const results=source.events.filter(e=>e.type==="RESULT");
  const transcripts=source.events.filter(e=>e.type==="TRANSCRIPT");
  if(results.length!==1||transcripts.length!==1)refuse("one result and transcript");
  const result=results[0].value,phrases=transcripts[0].value.phrases;
  if(result.engine!==engine||transcripts[0].value.engine!==engine||result.writes!==0||result.foreign!==0||result.entryStates!==2||typeof result.scope!=="string"||!result.scope.startsWith("Entry headings only;"))refuse("scope or operations");
  if(!Array.isArray(phrases)||!phrases.length||phrases.length>1000||phrases.some(p=>typeof p!=="string"))refuse("transcript");
  const steps=source.events.filter(e=>e.type==="STEP"&&typeof e.value.step==="string"&&e.value.step.startsWith("entry heading "));
  if(steps.length!==result.entryStates)refuse("entry count");
  const routes=new Set();
  const entries=steps.map(event=>{
   const step=event.value,route=step.step.slice("entry heading ".length);
   if(!["/signin","/signin?to=login"].includes(route)||routes.has(route))refuse("entry route");
   routes.add(route);
   if(!Array.isArray(step.expected)||step.expected.length!==3||typeof step.expected[0]!=="string"||!step.expected[0].trim()||step.expected[1]!=="heading"||step.expected[2]!=="1")refuse("name role level contract");
   if(typeof step.spoken!=="string"||!phrases.includes(step.spoken)||!step.spoken.toLowerCase().includes(step.expected[0].toLowerCase())||!(/\bheading\b[\s,]+level[\s,]+1\b/i).test(step.spoken))refuse("spoken name role or level");
   return {route,name:step.expected[0],spoken:step.spoken};
  }).sort((a,b)=>a.route.localeCompare(b.route,"en"));
  return {reader:source.reader,engine,jobId:source.jobId,url:source.url,completedAt:source.completedAt,entryCount:entries.length,entries,transcript:phrases,scope:result.scope};
 }).sort((a,b)=>a.reader.localeCompare(b.reader,"en"));
 if(heads.size!==1)refuse("mixed revisions");
 return {schemaVersion:1,status:"partial",sourceRevision:[...heads][0],lastReviewedAt:readers.map(r=>r.completedAt).sort().at(-1),readers};
}
if(process.argv[1]?.replaceAll("\\","/").endsWith("/accessibility-screen-reader-results.mjs")){
 const source=JSON.parse(readFileSync(resolve("docs/accessibility-screen-reader-evidence.json"),"utf8"));
 const content=JSON.stringify(generateReaderResults(source),null,2)+"\n",path=resolve("docs/accessibility-screen-reader-results.json");
 if(process.argv.includes("--write"))writeFileSync(path,content);
 else if(readFileSync(path,"utf8")!==content)throw Error("Screen reader results are stale; regenerate from reviewed evidence");
}
