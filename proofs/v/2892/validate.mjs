import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const label=process.argv[2];
const args=label==='types'?['--max-old-space-size=1024','proofs/v/2892/types.mjs']:['--max-old-space-size=512','node_modules/eslint/bin/eslint.js','lib/short-links.ts','lib/segments.ts','app/api/store/mail/route.ts','app/api/store/short-links/route.ts','components/email-studio.tsx','components/short-links.tsx','tests/list-limits-exact.test.ts','tests/list-limits-unreadable-member.test.ts'];
const r=spawnSync(process.execPath,args,{timeout:120000,maxBuffer:262144,encoding:'utf8',killSignal:'SIGKILL'});
const output=(r.stdout??'')+(r.stderr??'')+'\nV2892_VALIDATOR '+JSON.stringify({label,status:r.status,signal:r.signal,error:r.error?.message??null})+'\n';
writeFileSync(`proofs/v/2892/${label}.log`,output);process.stdout.write(output);process.exitCode=r.status??1;
