import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const here=import.meta.dirname,root=resolve(process.argv[2]||join(here,'..'));
const {build}=await import(join(root,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const folder=mkdtempSync(join(tmpdir(),'z2830-apply-'));
try{
 const out=join(folder,'proof.cjs');
 const alias=testAliases('page-routes-unknown.test.ts',root,join(root,'tests'));
 alias['@/lib/redis']=join(here,'redis-stub.ts');
 alias['@/lib/redis-memory']=join(here,'../lib/redis-memory.ts');
 await build({entryPoints:[join(here,'z2830-apply-read.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias});
 const r=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(folder,{recursive:true,force:true});}
