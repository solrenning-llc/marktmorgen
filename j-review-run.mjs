import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
const root=resolve('.'), out=mkdtempSync(join(tmpdir(),'j-2684-'));
let failed=0;
try { for(const file of process.argv.slice(2)) {
 const bundle=join(out,file+'.cjs');
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
 console.log('\n=== '+file+' ===');
 const r=spawnSync(process.execPath,[bundle],{stdio:'inherit',env:testEnvironment(process.env)});
 if(r.status!==0) failed++;
} } finally { rmSync(out,{recursive:true,force:true}); }
process.exitCode=failed?1:0;
