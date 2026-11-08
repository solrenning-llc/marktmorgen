import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir='proofs/s/3215-decomp';
const m=JSON.parse(readFileSync(`${dir}/oracle-manifest.json`,'utf8'));
const files=m.sources.flatMap(s=>s.parts).filter(p=>p.file).map(p=>p.file);
writeFileSync(`${dir}/tsconfig.json`,JSON.stringify({extends:'../../../tsconfig.json',compilerOptions:{incremental:false,plugins:[]},include:files.map(f=>'../../../'+f),exclude:['../../../node_modules']},null,2)+'\n');
const jobs=[['types',[process.execPath,'--max-old-space-size=1024','node_modules/typescript/bin/tsc','--noEmit','-p',`${dir}/tsconfig.json`]],['lint',[process.execPath,'--max-old-space-size=512','node_modules/eslint/bin/eslint.js','--max-warnings=0',...files,`${dir}/run.mjs`,`${dir}/generate.mjs`,`${dir}/checks.mjs`]],['scanner',['python','scripts/check_public_data.py']],['diff',['git','diff','--check']]];
for(const [name,command]of jobs){console.log('ADMIT_STATIC',name,{seconds:120,heapMiB:name==='types'?1024:512,outputBytes:262144,providers:0});const r=spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:120000,maxBuffer:262144,killSignal:'SIGKILL'});writeFileSync(`${dir}/${name}.json`,JSON.stringify({command,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null},null,2)+'\n');console.log(name,r.status,r.stdout?.slice(-1000),r.stderr?.slice(-1000));if(r.status!==0){process.exitCode=1;break;}}
