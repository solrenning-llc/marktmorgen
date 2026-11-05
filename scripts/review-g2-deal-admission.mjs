import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
const root=process.cwd(); mkdirSync('.review-output',{recursive:true}); let failures=0;
for (const file of process.argv.slice(2)) {
 const name=file.endsWith('.test.ts')?file:file+'.test.ts';const outfile=resolve('.review-output',name+'.cjs');
 try {await build({entryPoints:[resolve('tests',name)],bundle:true,platform:'node',format:'cjs',outfile,logLevel:'error',alias:testAliases(name,root,resolve('tests'))});
 const r=spawnSync(process.execPath,[outfile],{env:testEnvironment(process.env),encoding:'utf8',maxBuffer:20e6});writeFileSync(resolve('.review-output',name+'.log'),r.stdout+r.stderr); console.log(name,'exit',r.status,(r.stdout+r.stderr).split('\n').filter(l=>/pass|fail|check|error/i.test(l)).slice(-3).join(' | ')); if(r.status!==0) failures++;
 } catch(e) {console.log(name,String(e));failures++;}
} process.exitCode=failures?1:0;
