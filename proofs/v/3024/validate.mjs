import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const label=process.argv[2];
const paths=JSON.parse(readFileSync('proofs/v/3024/types-roots.json','utf8'));
const args=label==='types'?['--max-old-space-size=1024','proofs/v/3024/types.mjs']:label==='typegen'?['--max-old-space-size=1024','node_modules/next/dist/bin/next','typegen']:['--max-old-space-size=512','node_modules/eslint/bin/eslint.js',...paths];
const r=spawnSync(process.execPath,args,{env:{...process.env,NODE_OPTIONS:`--import=${resolve('proofs/v/3024/preload.mjs')}`},timeout:120000,maxBuffer:262144,encoding:'utf8',killSignal:'SIGKILL'});
const output=(r.stdout??'')+(r.stderr??'')+'\nV3024_VALIDATOR '+JSON.stringify({label,status:r.status,signal:r.signal,error:r.error?.message??null})+'\n';
writeFileSync(`proofs/v/3024/${label}.log`,output);process.stdout.write(output);process.exitCode=r.status??1;
