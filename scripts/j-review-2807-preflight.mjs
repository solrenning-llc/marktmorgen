import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd(),out=mkdtempSync(join(tmpdir(),'j-2807-preflight-'));
let failed=0;
try {
 for(const file of process.argv.length>2 ? process.argv.slice(2) : ['j-2807-preflight.proof.ts']) {
  const bundle=join(out,file+'.cjs');
  await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
  console.log('TEST '+file);
  const result=spawnSync(process.execPath,[bundle],{stdio:'inherit',env:testEnvironment(process.env)});
  console.log('GROUP_EXIT '+file+' '+result.status);rmSync(bundle,{force:true});
  if(result.status!==0)failed++;
 }
 console.log('FAILED_GROUPS '+failed);process.exitCode=failed?1:0;
} finally {rmSync(out,{recursive:true,force:true});}
