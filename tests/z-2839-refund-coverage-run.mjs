import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const here=import.meta.dirname,root=resolve(process.argv[2]||join(here,'..'));
const {build}=await import(join(root,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const dir=mkdtempSync(join(tmpdir(),'z2839-refund-coverage-'));
try{
 const out=join(dir,'proof.cjs');
 await build({entryPoints:[join(here,'z-2839-refund-coverage.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases('paypal-refunds-exact.test.ts',root,join(root,'tests'))});
 const result=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});
 process.exitCode=result.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
