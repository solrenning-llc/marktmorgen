import {build} from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/esbuild/lib/main.js';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.env.Z_TEST_ROOT || '/workspace/scratch/z-points-correction';
const {testAliases,testEnvironment}=await import(root+'/tests/test-config.mjs');
const out=mkdtempSync(join(tmpdir(),'z-points-'));
let failed=0;
try {
  for(const file of process.argv.slice(2)) {
    const bundle=join(out,file+'.cjs');
    await build({plugins:[{name:'review-command-budget',setup(b){b.onLoad({filter:/redis-memory\.ts$/},a=>{let s=readFileSync(a.path,'utf8');const needle='run(command: (string | number)[]): unknown {';if(!s.includes(needle))throw new Error('Missing MemoryRedis hook');s=s.replace(needle,needle+' (globalThis as unknown as {__z2964Count:()=>void}).__z2964Count();');return {contents:s,loader:'ts'};});}}],banner:{js:"let __n=0;globalThis.__z2964Count=()=>{if(++__n>20000)throw new Error('Review command ceiling');};process.on('beforeExit',()=>console.log('COUNTED_MEMORY_COMMANDS',__n));let __h=0,__over=false;let __f=async()=>{throw new Error('External fetch forbidden in review2964')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return __f;},set(f){const prior=f;__f=(...a)=>{if(++__h>100){__over=true;throw new Error('Review mock HTTP ceiling');}return prior(...a);};}});process.on('beforeExit',()=>{console.log('COUNTED_MOCK_HTTP',__h);if(__over)process.exitCode=1;});"},entryPoints:[root+'/tests/'+file],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,root+'/tests'),nodePaths:['/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules']});
    const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:131072,encoding:'utf8'});
    process.stdout.write(file+'\n'+r.stdout+r.stderr);
    if(r.status!==0)failed++;
  }
} finally {rmSync(out,{recursive:true,force:true});}
process.exitCode=failed?1:0;
