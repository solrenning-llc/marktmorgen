import {build} from 'esbuild';
import {resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(),input=process.argv[2],ref=process.argv[3];
const aliases=testAliases(input.split('/').pop(),root,resolve(root,'tests'));
if(input.endsWith('review-2848-boundary.proof.ts'))for(const name of ['blob','vault','stream'])aliases['@/lib/'+name]=resolve(root,'proofs/g/review-2848-world.ts');
const result=await build({entryPoints:[resolve(root,input)],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'error',alias:aliases,plugins:ref?[{name:'g-exact-prior-cost-registry',setup(b){b.onLoad({filter:/\/tests\/plan-cost-registry\.ts$/},()=>({contents:execFileSync('git',['show',`${ref}:tests/plan-cost-registry.ts`],{encoding:'utf8'}),loader:'ts',resolveDir:resolve(root,'tests')}));}}]:[]});
const r=spawnSync(process.execPath,['-'],{input:result.outputFiles[0].contents,encoding:'utf8',cwd:root,env:testEnvironment(process.env),maxBuffer:8*1024*1024});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exitCode=r.status??1;
