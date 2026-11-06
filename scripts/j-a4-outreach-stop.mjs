import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const out=mkdtempSync(join(tmpdir(),'j-a4-outreach-'));
let failed=false;
try {
 for(const file of process.argv.length>2 ? process.argv.slice(2) : ['j-a4-outreach-stop.proof.ts']) {
  const bundle=join(out,file+'.cjs');
  await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
  console.log('TEST '+file);
  const result=spawnSync(process.execPath,[bundle],{stdio:'inherit',env:testEnvironment(process.env)});
  if(result.status!==0)failed=true;
 }
 process.exitCode=failed?1:0;
} finally {rmSync(out,{recursive:true,force:true});}
