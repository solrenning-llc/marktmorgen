import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=resolve(new URL('../',import.meta.url).pathname),require=createRequire(join(root,'package.json'));
const {build}=require('esbuild'),dir=mkdtempSync(join(tmpdir(),'g1952-'));
const world=join(root,'tests/g-audit-1952-world.ts');
const alias=testAliases('g-audit-1952.test.ts',root,join(root,'tests'));
for(const key of ['next/headers','next/navigation','@/lib/studio-route','@/lib/crm','@/lib/pipeline-access','@/lib/team','@/lib/segments','@/components/studio-header','@/components/studio-store-pin','@/components/deals-board','@/components/deals-unavailable'])alias[key]=world;
try{
 const outfile=join(dir,'proof.cjs');
 await build({entryPoints:[join(root,'tests/g-audit-1952.test.ts')],outfile,bundle:true,platform:'node',format:'cjs',alias,logLevel:'error'});
 const result=spawnSync(process.execPath,[outfile],{cwd:root,env:testEnvironment(process.env),stdio:'inherit',timeout:30000});
 process.exitCode=result.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
