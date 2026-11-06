import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const own=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]||own);
const {build}=await import(join(own,'node_modules/esbuild/lib/main.js'));
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const file=process.argv[3]||'z-counted-ack.proof.ts';
if(!['z-counted-ack.proof.ts','z-ai-left-envelope.proof.ts'].includes(file))throw new Error('Unknown proof');
const dir=mkdtempSync(join(tmpdir(),'z-counted-ack-'));
try{
 const alias=testAliases('z-counted-ack.proof.ts',root,join(root,'tests'));
 for(const name of ['redis','ai-spend'])alias['@/lib/'+name]=join(own,'tests/z-counted-ack-world.ts');
 await build({entryPoints:[join(own,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:join(dir,'proof.cjs'),alias,logLevel:'error'});
 const env=testEnvironment(process.env);env.ANTHROPIC_API_KEY='sk-ant-'+'synthetic'.repeat(5);
 const r=spawnSync(process.execPath,[join(dir,'proof.cjs')],{cwd:root,env,stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
