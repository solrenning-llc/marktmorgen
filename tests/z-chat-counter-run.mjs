import {build} from 'esbuild';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from './test-config.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(process.argv[2]||join(here,'..'));
const file='z-chat-counter-admission.proof.ts';
const aliases=testAliases(file,root,here);
for(const name of ['redis','store-request','store'])aliases['@/lib/'+name]=join(here,'z-chat-counter-world.ts');
const folder=mkdtempSync(join(tmpdir(),'z-chat-counter-'));
try{const out=join(folder,'proof.cjs');await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:out,alias:aliases,logLevel:'error'});const r=spawnSync(process.execPath,[out],{cwd:root,stdio:'inherit',env:testEnvironment(process.env)});process.exitCode=r.status??1;}finally{rmSync(folder,{recursive:true,force:true});}
