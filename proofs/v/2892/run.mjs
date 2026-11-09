import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const [label,file,mode='green']=process.argv.slice(2);
const r=spawnSync(process.execPath,['--max-old-space-size=512','proofs/v/2892/worker.mjs',file,mode],{env:{...process.env,NODE_OPTIONS:`--max-old-space-size=512 --import=${resolve('proofs/v/2892/preload.mjs')}`},timeout:120000,maxBuffer:262144,encoding:'utf8',killSignal:'SIGKILL'});
const output=(r.stdout??'')+(r.stderr??'')+'\nV2892_STATUS '+JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null})+'\n';
writeFileSync(`proofs/v/2892/${label}.log`,output);process.stdout.write(output);process.exitCode=r.status??1;
