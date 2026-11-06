import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd(), out=mkdtempSync(join(tmpdir(),'j2844-'));
let failed=false;
const files=process.argv.slice(2);
try {
 for(const file of files.length ? files : ['j-2844-settlement.proof.ts','j-2844-payday.proof.ts']) {
  const bundle=join(out,file+'.cjs');
  await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
  console.log('TEST '+file);
  const r=spawnSync(process.execPath,[bundle],{stdio:'inherit',env:testEnvironment(process.env)});
  if(r.status!==0)failed=true;
 }
 process.exitCode=failed?1:0;
} finally {rmSync(out,{recursive:true,force:true});}
