import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const own=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]||own);
const {build}=await import(join(own,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const dir=mkdtempSync(join(tmpdir(),'z-oauth-return-'));
try{
 const alias=testAliases('z-oauth-return-counter.proof.ts',root,join(root,'tests'));
 for(const name of ['redis','auth','studio-route','store','integration-pause','contract-resource-window','account-notice','team','meet-providers','metered-limits'])alias['@/lib/'+name]=join(own,'tests/z-oauth-return-world.ts');
 alias['@/lib/meta-ads']=join(own,'tests/z-oauth-return-meta-world.ts');
 alias['@/lib/meet-connect']=join(own,'tests/z-oauth-return-meet-world.ts');
 alias['next/server']=join(root,'tests/next-server-after-world.ts');
 await build({entryPoints:[join(own,'tests/z-oauth-return-counter.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(dir,'proof.cjs'),alias,logLevel:'error'});
 const env=testEnvironment(process.env);env.META_APP_ID='123456789';env.META_APP_SECRET='synthetic-not-a-provider-secret';
 const r=spawnSync(process.execPath,[join(dir,'proof.cjs')],{cwd:root,env,stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
