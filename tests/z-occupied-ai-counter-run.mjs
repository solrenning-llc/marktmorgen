/** Reproduce against a product checkout without changing any supplier or product source. */
import { build } from 'esbuild';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from './test-config.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(process.argv[2] || join(here,'..'));
const file='z-occupied-ai-counter-proof.test.ts';
const aliases=testAliases(file,root,here);
for(const name of ['redis','store-request','customer-voice','review-ai-summary','stats-report','numbers-ask','person-agenda-read','ai'])aliases['@/lib/'+name]=join(here,'z-occupied-ai-counter-world.ts');
const folder=mkdtempSync(join(tmpdir(),'z-occupied-counter-'));
try {
 const out=join(folder,'proof.cjs');
 await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:out,alias:aliases,logLevel:'error'});
 const run=spawnSync(process.execPath,[out],{cwd:root,stdio:'inherit',env:testEnvironment(process.env)});
 process.exitCode=run.status ?? 1;
} finally {rmSync(folder,{recursive:true,force:true});}
