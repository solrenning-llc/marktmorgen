/** Review-only candidate: transforms an in-memory module; never edits the author source. */
import {build} from 'esbuild';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=resolve(import.meta.dirname,'..');
let source=readFileSync(root+'/lib/billing-reminders.ts','utf8');
const helper=`/** Only a complete Redis reply proves whether this notice claim was taken. */
function noticeClaim(reply: unknown): "taken" | "existing" | "unknown" {
  if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0)) return "unknown";
  return reply[0] === "OK" ? "taken" : reply[0] === null ? "existing" : "unknown";
}

`;
let sent=0,missed=0;
source=source.replace('const DAY =',helper+'const DAY =');
source=source.replace(/const \[claimed\] = await redisPipeline\(\[\["SET", key, "1", "NX", "EX", (60|90) \* DAY\]\]\);\n(\s*)if \(claimed === null\) continue;/g,(_match,days,indent)=>{
 sent++;
 return `const claim = noticeClaim(await redisPipeline([["SET", key, "1", "NX", "EX", ${days} * DAY]]));\n${indent}if (claim === "existing") continue;\n${indent}if (claim === "unknown") {\n${indent}  counts.failed += 1;\n${indent}  console.error("Billing notice claim was not confirmed");\n${indent}  continue;\n${indent}}`;
});
source=source.replace(/const \[unsent\] = await redisPipeline\(\[\["SET", missedKey, "1", "NX", "EX", 60 \* DAY\]\]\);\n(\s*)if \(unsent !== null\) \{/g,(_match,indent)=>{
 missed++;
 return `const claim = noticeClaim(await redisPipeline([["SET", missedKey, "1", "NX", "EX", 60 * DAY]]));\n${indent}if (claim === "unknown") {\n${indent}  counts.failed += 1;\n${indent}  console.error("Missed billing notice claim was not confirmed");\n${indent}} else if (claim === "taken") {`;
});
if(sent!==2||missed!==1)throw Error('The reviewed source changed; do not apply a different patch silently');
if(process.argv.includes('--source')){process.stdout.write(source);process.exit(0);}
const dir=mkdtempSync(tmpdir()+'/i2-notice-candidate-');
try{
 for(const file of ['plan-renewal-notice-window.test.ts','plan-notice-run.test.ts','plan-payment-failed.test.ts','review-i2-notice-claim.test.ts']){
  const plugins=process.env.REVIEW_I2_CLAIM_FIX==='0'?[]:[{name:'candidate-module',setup(api){api.onLoad({filter:/[/\\]lib[/\\]billing-reminders\.ts$/},()=>({contents:source,loader:'ts',resolveDir:root+'/lib'}));}}];
  await build({entryPoints:[root+'/tests/'+file],bundle:true,platform:'node',format:'cjs',outfile:dir+'/'+file+'.cjs',alias:testAliases(file,root,root+'/tests'),plugins,logLevel:'error'});
  console.log('=== '+file+' ===');const result=spawnSync(process.execPath,[dir+'/'+file+'.cjs'],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});if(result.status)process.exitCode=1;
 }
}finally{rmSync(dir,{recursive:true,force:true});}
