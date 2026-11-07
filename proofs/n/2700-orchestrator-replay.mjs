import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Inputs are an exact BA14 source snapshot and an existing dependency directory.
// This runner never installs dependencies or edits the supplied source files.
const [rootArg,depsArg,testArg]=process.argv.slice(2);
if(!rootArg||!depsArg||!testArg)throw Error('Usage: node replay.mjs BA14_ROOT NODE_MODULES HANDOFF_OR_P_TEST');
const root=resolve(rootArg),deps=resolve(depsArg),testFile=resolve(testArg);
const bytes=readFileSync(testFile);
const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const allowed=new Map([
 ['ad0d51cf35553a94426c07b4dc953b5224e4dced','n-2700-c6-handoff.test.ts'],
 ['9378e6db2d1b1248adb70b839bd7d995ccec4993','p-2700-erasure-token-dependency.test.ts'],
]);
if(!allowed.has(blob))throw Error('Only the two immutable published proofs are accepted');
// The copies live at snapshot/tests so the original ./redis-stub and fixture
// imports keep their canonical meaning without changes to the proof bytes.
if(testFile!==join(root,'tests',allowed.get(blob)))throw Error('Put the unmodified proof at BA14_ROOT/tests/'+allowed.get(blob));
for(const [file,expected]of [
 ['lib/person-erasure.ts','13b3838a78e6c0496cc9e1c30cbfaec77cbf8841'],
 ['lib/mail-clicks.ts','2621968b57af0e8d6826200591a4c7c7d44149e7'],
 ['tests/test-config.mjs','007ad672ba2323e1ad93db2c83e35572b466dfee'],
]){
 const b=readFileSync(join(root,file));
 const actual=createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
 if(actual!==expected)throw Error('Source identity mismatch: '+file+' '+actual);
}
const require=createRequire(join(deps,'esbuild','package.json'));
const {build}=require('esbuild');
const {testAliases,testEnvironment}=await import(pathToFileURL(join(root,'tests/test-config.mjs')));
const out=mkdtempSync(join(tmpdir(),'n-2700-replay-'));
try{
 const result=await build({stdin:{contents:`import {store} from './tests/redis-stub';
let total=0,local=0;const original=store.pipeline.bind(store),clear=store.clear.bind(store);
store.clear=()=>{local=0;return clear()};
store.pipeline=async commands=>{if(total+commands.length>100000||local+commands.length>10000)throw Error('N synthetic budget exceeded');total+=commands.length;local+=commands.length;return original(commands)};
process.on('beforeExit',()=>console.log('N_SYNTHETIC_COMMANDS',total));
void import(${JSON.stringify('./tests/'+allowed.get(blob))});`,resolveDir:root,sourcefile:'n-handoff-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:join(out,'replay.cjs'),metafile:true,alias:testAliases(allowed.get(blob),root,join(root,'tests')),nodePaths:[deps],logLevel:'error',banner:{js:`globalThis.fetch=async()=>{throw Error('N: external network forbidden')};`}});
 console.log('PROOF_BLOB',blob,'BUNDLED_INPUTS',Object.keys(result.metafile.inputs).length);
 const run=spawnSync(process.execPath,[join(out,'replay.cjs')],{env:testEnvironment({...process.env,NIMBUS_DATA_KEY:'tests-only-not-a-real-deployment-secret'}),encoding:'utf8',timeout:120000,maxBuffer:256*1024});
 process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
 if(run.error)throw run.error;
 process.exitCode=run.status===0?0:1;
}finally{rmSync(out,{recursive:true,force:true});}
