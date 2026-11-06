import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root=process.cwd(),out=mkdtempSync(join(tmpdir(),'j-2807-preflight-'));
const require=createRequire(import.meta.url),preload=join(out,'offline.cjs');
writeFileSync(preload,'const {MockAgent,setGlobalDispatcher}=require('+JSON.stringify(require.resolve('undici'))+');const blocked=new MockAgent();blocked.disableNetConnect();setGlobalDispatcher(blocked);globalThis.fetch=async()=>{throw new Error("Review transport: real network is disabled");};');
let failed=0;
try {
 for(const file of process.argv.length>2 ? process.argv.slice(2) : ['j-2807-preflight.proof.ts']) {
  const bundle=join(out,file+'.cjs');
  await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
  console.log('TEST '+file);
  const result=spawnSync(process.execPath,["--require",preload,bundle],{stdio:'inherit',env:testEnvironment(process.env)});
  console.log('GROUP_EXIT '+file+' '+result.status);rmSync(bundle,{force:true});
  if(result.status!==0)failed++;
 }
 console.log('FAILED_GROUPS '+failed);process.exitCode=failed?1:0;
} finally {rmSync(out,{recursive:true,force:true});}
