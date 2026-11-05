import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {build} from '/workspace/scratch/e103dcbb1f28/marktmorgen/node_modules/esbuild/lib/main.js';
import {testAliases,testEnvironment} from './redis-arity/tests/test-config.mjs';
import {checkClientBundles} from './redis-arity/tests/client-bundles.mjs';
const root='/workspace/scratch/fa8a93fd1cff/redis-arity',here=join(root,'tests');
const files=readdirSync(here).filter(f=>f.endsWith('.test.ts')).sort();
const failures=[];
const compileInput="const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');const file=process.env.V_SUITE_BUNDLE;const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(0,'utf8'),file);";
for(const file of files){
 const bundle=join('/tmp',file+'.cjs');
 const result=await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,write:false,logLevel:'error',alias:testAliases(file,root,here)});
 console.log(`\n=== ${file} ===`);
 const run=spawnSync(process.execPath,['-e',compileInput],{input:result.outputFiles[0].contents,stdio:['pipe','inherit','inherit'],env:{...testEnvironment(process.env),V_SUITE_BUNDLE:bundle}});
 if(run.status!==0)failures.push({file,status:run.status,error:run.error?.message});
}
const clients=await checkClientBundles(root);
console.log('V_FULL_SUITE_RESULT:'+JSON.stringify({files:files.length,failures,clients}));
process.exitCode=failures.length||clients.failed?1:0;
