/** Linux: timeout 120s node --max-old-space-size=512 proofs/h2/3021-member-price-run.mjs
 * Uses official aliases/environment and a pinned product source. No real HTTP.
 * Optional H2_REVIEW_REF selects a different immutable product commit. */
import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=process.cwd(),here=join(root,'tests');
const ref=process.env.H2_REVIEW_REF??'b6055d9861d7dd1926ce1a35cc333e85d3eda23b';
if(!/^[a-f0-9]{40}$/.test(ref))throw Error('immutable SHA required');
const file=process.argv[2]??'h2-3021-member-price.proof.ts';
if(!['h2-3021-member-price.proof.ts','sz4-u2-product-page.test.ts','member-price.test.ts','digital-consent.test.ts','product-structured-data.test.ts'].includes(file))throw Error('entry outside review budget');
const out=mkdtempSync(join(tmpdir(),'h2-3021-')),bundle=join(out,'proof.cjs');
try{
 await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,here),
  banner:{js:"globalThis.fetch=async()=>{throw Error('external network forbidden')};globalThis.h2Counts={commands:0,http:0};"},
  plugins:[{name:'pinned-bounded-review',setup(b){b.onLoad({filter:/\.(ts|tsx)$/},a=>{
   const path=a.path.slice(root.length+1);let source;
   if(/^(app|components|lib)\//.test(path)){
    try{source=execFileSync('git',['show',`${ref}:${path}`],{cwd:root,encoding:'utf8',timeout:20000,maxBuffer:1048576});}
    catch{return {errors:[{text:`Absent in selected product source: ${path}`}]};}
   }else if(path==='tests/redis-stub.ts'){
    source=readFileSync(a.path,'utf8')+"\nconst original=store.pipeline.bind(store);store.pipeline=async cs=>{globalThis.h2Counts.commands+=cs.length;if(globalThis.h2Counts.commands>20000)throw Error('synthetic command ceiling');return original(cs)};";
   }else if(path==='tests/'+file){
    source=readFileSync(a.path,'utf8')+"\nconst rawFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{if(++globalThis.h2Counts.http>200)throw Error('HTTP ceiling');return rawFetch(...args)};process.on('exit',()=>console.log('H2_COUNTS',JSON.stringify(globalThis.h2Counts)));";
   }
   return source===undefined?undefined:{contents:source,loader:path.endsWith('.tsx')?'tsx':'ts'};
  });}}]});
 const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:110000,maxBuffer:262144});
 process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');
 if(r.error)throw r.error;
 console.log(JSON.stringify({ref,entry:file,status:r.status}));process.exitCode=r.status??1;
}finally{rmSync(out,{recursive:true,force:true});}
