import {build} from 'esbuild';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from './test-config.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(process.argv[2]||join(here,'..'));
const files=process.argv.slice(3);
if(!files.length)files.push('review-t2690-count-evidence.proof.ts','z2690-financial.proof.ts');
const folder=mkdtempSync(join(tmpdir(),'z2690-review-'));
try{for(const spec of files){const product=spec.startsWith('product:');const file=product?spec.slice(8):spec;const tests=product?join(root,'tests'):here;const out=join(folder,file+'.cjs');await build({entryPoints:[join(tests,file)],bundle:true,platform:'node',format:'cjs',outfile:out,alias:testAliases(file,root,tests),logLevel:'error'});const run=spawnSync(process.execPath,[out],{cwd:root,stdio:'inherit',env:testEnvironment(process.env)});if(run.status!==0)process.exitCode=1;}}finally{rmSync(folder,{recursive:true,force:true});}
