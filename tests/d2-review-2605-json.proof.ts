import assert from "node:assert/strict";
import {companyOwnerReport, OWNER_REPORT_MAX_CHARACTERS} from "../lib/company-owner-report";
const now=Date.UTC(2026,10,5), month="2026-11";
let checks=0, failures=0;
function check(label:string, run:()=>void){checks++;try{run();console.log("PASS "+label);}catch(error){failures++;console.log("FAIL "+label+": "+String(error));}}
const row=`{"status":"ready","observedAtMs":${now},"holdUntilMs":null}`;
const render=(raw:string)=>companyOwnerReport(raw,month,now);
const status=(raw:string)=>render(raw).sections[4].status;
check("ordinary source",()=>assert.equal(status(`{"sesPause":${row}}`),"observed"));
check("escaped key and value remain readable",()=>assert.equal(status(String.raw`{"\u0073esPause":{"sta\u0074us":"rea\u0064y","observedAtMs":`+now+`,"holdUntilMs":null}}`),"observed"));
check("same field names in different sources",()=>assert.equal(render(`{"sesPause":${row},"manualLook":{"observedAtMs":${now},"minimumWeeks":12,"stopped":0,"stuck":0}}`).sections.filter(s=>s.status==="observed").length,2));
for(const first of ["null","[]",'[{"x":"}\\\"["}]',"false",'"paused"']){
 check("duplicate status after "+first,()=>assert.equal(status(`{"sesPause":{"status":${first},"status":"ready","observedAtMs":${now},"holdUntilMs":null}}`),"unknown"));
}
for(const alias of [String.raw`\u0073tatus`,String.raw`sta\u0074us`,String.raw`status`]){
 check("decoded duplicate "+alias,()=>assert.equal(status(`{"sesPause":{"${alias}":"paused","status":"ready","observedAtMs":${now},"holdUntilMs":null}}`),"unknown"));
}
for(const alias of [String.raw`\u0073esPause`,String.raw`ses\u0050ause`,"sesPause"]){
 check("root duplicate "+alias,()=>assert.equal(status(`{"${alias}":null,"sesPause":${row}}`),"unknown"));
}
check("literal backslash is not a decoded alias",()=>assert.equal(status(String.raw`{"sesPause":{"sta\\u0074us":"paused","status":"ready","observedAtMs":`+now+`,"holdUntilMs":null}}`),"unknown"));
check("exact existing size boundary",()=>{const raw=`{"sesPause":${row}}`;assert.equal(status(raw+" ".repeat(OWNER_REPORT_MAX_CHARACTERS-raw.length)),"observed");});
check("over existing size boundary",()=>assert.equal(status(" ".repeat(OWNER_REPORT_MAX_CHARACTERS+1)),"unknown"));
check("bounded deep unknown input",()=>assert.ok(render("[".repeat(10000)+"0"+"]".repeat(10000)).sections.every(s=>s.status==="unknown")));
check("malformed bracket is unknown",()=>assert.equal(status(`{"sesPause":${row}]`),"unknown"));
check("output stays frozen",()=>assert.ok(Object.isFrozen(render(`{"sesPause":${row}}`).sections)));
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
