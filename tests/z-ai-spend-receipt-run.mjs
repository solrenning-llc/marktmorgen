import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const here=import.meta.dirname,root=resolve(here,'..');
const {build}=await import(join(root,'node_modules/esbuild/lib/main.js'));
const folder=mkdtempSync(join(tmpdir(),'z-ai-spend-receipt-'));
try{
 const out=join(folder,'proof.cjs');
 await build({entryPoints:[join(here,'z-ai-spend-receipt.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:{'@':root,'@/lib/redis':join(here,'ai-spend-redis.ts')}});
 const r=spawnSync(process.execPath,[out],{cwd:root,env:process.env,stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(folder,{recursive:true,force:true});}
