import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const paths=Object.keys(JSON.parse(readFileSync('proofs/v/3024/fixture-completion-counts.json','utf8')));
const results=[];
for(const path of paths){
 const label='fixture-'+path.split('/').at(-1).replace(/\.(test|proof)\.ts$/,'');
 const r=spawnSync(process.execPath,['proofs/v/3024/run.mjs',label,path],{timeout:125000,maxBuffer:262144,encoding:'utf8'});
 const s=readFileSync(`proofs/v/3024/${label}.log`,'utf8');const count=/([0-9]+) checks, all passing/.exec(s)?.[1]??/ℹ tests ([0-9]+)/.exec(s)?.[1]??null;
 const row={path,label,status:r.status,signal:r.signal,error:r.error?.message??null,checks:count,volume:[...s.matchAll(/V3024_VOLUME (.*)/g)].map(x=>JSON.parse(x[1]))};results.push(row);console.log(JSON.stringify(row));
}
writeFileSync('proofs/v/3024/fixture-results.json',JSON.stringify(results,null,2)+'\n');process.exitCode=results.some(x=>x.status!==0)?1:0;
