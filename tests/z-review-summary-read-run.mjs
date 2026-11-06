import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve(process.argv[2]||'.');
const here=resolve(import.meta.dirname);
const {build}=await import(join(root,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const dir=mkdtempSync(join(tmpdir(),'z-summary-read-'));
try{
 const out=join(dir,'proof.cjs');
 await build({entryPoints:[join(here,'z-review-summary-read.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases('review-ai-summary.test.ts',root,join(root,'tests'))});
 const r=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});
 process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
