import {build} from 'esbuild';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
for(const f of process.argv.slice(2)){const root=process.cwd();const out='/tmp/g-'+f.replaceAll('/','-')+'.cjs';await build({entryPoints:[resolve('tests',f)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(f,root,resolve('tests'))}); const r=spawnSync(process.execPath,[out],{env:testEnvironment(process.env),encoding:'utf8'});console.log('=== '+f+' ===\n'+r.stdout+r.stderr);if(r.status) process.exitCode=1;}
