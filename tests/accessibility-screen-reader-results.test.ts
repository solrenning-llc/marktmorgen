import {readFileSync} from "node:fs";
import {generateReaderResults} from "../scripts/accessibility-screen-reader-results.mjs";
import {done,is,part} from "./check";
const source=JSON.parse(readFileSync("docs/accessibility-screen-reader-evidence.json","utf8"));
part("Recorded real-reader speech stays scoped and generated");
is("checked result matches reviewed source events",JSON.stringify(generateReaderResults(source),null,2)+"\n",readFileSync("docs/accessibility-screen-reader-results.json","utf8"));
is("result is explicitly partial",generateReaderResults(source).status,"partial");
const mutations:[string,(input:typeof source)=>void][]=[
 ["failed job",x=>{x.sources[0].conclusion="failure";}],
 ["duplicate reader",x=>{x.sources[1].reader=x.sources[0].reader;}],
 ["mixed revisions",x=>{x.sources[1].head="a".repeat(40);}],
 ["foreign evidence URL",x=>{x.sources[0].url="https://example.test/job";}],
 ["evidence URL under another owner",x=>{x.sources[0].url=x.sources[0].url.replace(/github\.com\/[^/]+\//,"github.com/someone/");}],
 ["wrong job identity",x=>{x.sources[0].jobId++;}],
 ["unknown writes",x=>{delete x.sources[0].events.find((e:{type:string})=>e.type==="RESULT").value.writes;}],
 ["actual mutation",x=>{x.sources[0].events.find((e:{type:string})=>e.type==="RESULT").value.writes=1;}],
 ["foreign request",x=>{x.sources[0].events.find((e:{type:string})=>e.type==="RESULT").value.foreign=1;}],
 ["inflated entry count",x=>{x.sources[0].events.find((e:{type:string})=>e.type==="RESULT").value.entryStates=126;}],
 ["event after completion",x=>{x.sources[0].completedAt="2000-01-01T00:00:00Z";}],
 ["missing transcript",x=>{x.sources[0].events=x.sources[0].events.filter((e:{type:string})=>e.type!=="TRANSCRIPT");}],
 ["missing entry",x=>{x.sources[0].events=x.sources[0].events.filter((e:{type:string;value:{step?:string}})=>e.value.step!=="entry heading /signin");}],
 ["wrong spoken role",x=>{const e=x.sources[0].events.find((e:{value:{step?:string}})=>e.value.step==="entry heading /signin");e.value.spoken="Start your store button";}],
 ["wrong expected role",x=>{x.sources[0].events.find((e:{value:{step?:string}})=>e.value.step==="entry heading /signin").value.expected[1]="button";}],
 ["duplicate entry route",x=>{x.sources[0].events.find((e:{value:{step?:string}})=>e.value.step==="entry heading /signin?to=login").value.step="entry heading /signin";}],
];
for(const [label,mutate] of mutations){const copy=structuredClone(source);mutate(copy);let refused=false;try{generateReaderResults(copy);}catch{refused=true;}is("refuse "+label,refused,true);}
{const copy=structuredClone(source);for(const s of copy.sources)s.url=s.url.replace("github.com/viniciussucupira/","github.com/solrenning-llc/");let accepted=true;try{generateReaderResults(copy);}catch{accepted=false;}is("accept the same jobs under the solrenning-llc organization, which owns the repository after a move",accepted,true);}
done();
