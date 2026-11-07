import {build} from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/esbuild/lib/main.js';
import {mkdtempSync,rmSync} from 'node:fs';
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
    await build({banner:{js:"globalThis.fetch=async()=>{throw new Error('External fetch forbidden in review3055')};"},entryPoints:[root+'/tests/'+file],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,root+'/tests'),nodePaths:['/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules']});
    const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:131072,encoding:'utf8'});
    process.stdout.write(file+'\n'+r.stdout+r.stderr);
    if(r.status!==0)failed++;
  }
} finally {rmSync(out,{recursive:true,force:true});}
process.exitCode=failed?1:0;
