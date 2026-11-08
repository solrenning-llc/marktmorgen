import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const names=['accessibility-inventory','community-old-handle-after-failure','community-handle-give-back-exact','community-old-handle-release','community-handle-reserve-unknown','community-patch-member-exact','community-reads-unknown','community-handle-erasure-orphan','store-socials','socials-keyboards','mail-socials-block','platform-us-english','store-data-registry','person-data-registry','plan-cost-registry'];
const rows=[];
for(const name of names){
 const r=spawnSync(process.execPath,['proofs/v/3024/run.mjs',name,`tests/${name}.test.ts`],{timeout:125000,maxBuffer:262144,encoding:'utf8'});
 const output=readFileSync(`proofs/v/3024/${name}.log`,'utf8');
 const count=/([0-9]+) checks, all passing/.exec(output)?.[1]??/ℹ tests ([0-9]+)/.exec(output)?.[1]??null;
 const row={name,status:r.status,signal:r.signal,error:r.error?.message??null,checks:count,volume:[...output.matchAll(/V3024_VOLUME (.*)/g)].map(x=>JSON.parse(x[1]))};rows.push(row);console.log(JSON.stringify(row));
}
writeFileSync('proofs/v/3024/linked-results.json',JSON.stringify(rows,null,2)+'\n');
process.exitCode=rows.some(x=>x.status!==0)?1:0;
