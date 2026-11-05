import{build}from'esbuild';
import{spawnSync}from'node:child_process';
import{resolve}from'node:path';
import{testAliases,testEnvironment}from'../../tests/test-config.mjs';
const file='c2-2692-open-requests.proof.ts';
const result=await build({entryPoints:['tests/'+file],bundle:true,write:false,platform:'node',format:'cjs',alias:testAliases(file,process.cwd(),resolve('tests')),logLevel:'silent'});
const run=spawnSync(process.execPath,['-'],{input:result.outputFiles[0].text,cwd:process.cwd(),env:testEnvironment(process.env),encoding:'utf8'});
process.stdout.write(run.stdout+run.stderr);process.exitCode=run.status??1;
