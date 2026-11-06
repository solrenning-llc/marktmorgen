import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const own=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]||own);
const {build}=await import(join(own,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const dir=mkdtempSync(join(tmpdir(),'z-summary-keep-'));
try{
 await build({entryPoints:[join(own,'tests/z-review-summary-keep.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(dir,'proof.cjs'),alias:testAliases('z-review-summary-keep.proof.ts',root,join(root,'tests')),logLevel:'error'});
 const r=spawnSync(process.execPath,[join(dir,'proof.cjs')],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
