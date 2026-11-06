import {build,stop} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=process.cwd(),mode=process.argv[2],ref=process.argv[3]||'e7a0e382d9e0897a679030ba9eda18155073fb9d';
if(!['stress','guard'].includes(mode)||!/^[a-f0-9]{40}$/.test(ref))throw Error('mode and exact SHA required');
const source=path=>execFileSync('/usr/local/bin/git',['show',ref+':'+path],{cwd:root,encoding:'utf8'});
const temp=mkdtempSync('/dev/shm/g2894-');
try{
 const input=resolve(root,mode==='stress'?'tests/check-exit.proof.ts':'tests/check-exit.test.ts');
 const output=join(temp,'proof.cjs');
 await build({entryPoints:[input],bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'error',plugins:[{name:'exact-check-preimage',setup(b){b.onLoad({filter:/\/tests\/check\.ts$/},()=>({contents:source('tests/check.ts'),loader:'ts'}));}}]});
 mkdirSync(join(temp,'tests'));for(const path of ['tests/check.ts','tests/run.mjs'])writeFileSync(join(temp,path),source(path));
 const r=spawnSync(process.execPath,[output],{cwd:temp,encoding:'utf8',timeout:45000,maxBuffer:1024*1024,env:{...process.env,CHECK_EXIT_CHILD:''}});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exitCode=r.status??1;
}finally{stop();rmSync(temp,{recursive:true,force:true});}
