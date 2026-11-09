import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const label=process.argv[2];
const args=label==='types'?['--max-old-space-size=1024','proofs/v/2999/types.mjs']:['--max-old-space-size=512', 'node_modules/eslint/bin/eslint.js', 'app/api/store/checkout/route.ts', 'lib/data-families.ts', 'lib/discount-impact.ts', 'lib/fair-coupon.ts', 'lib/member-price-rules.ts', 'lib/member-price.ts', 'lib/store-checkout.ts', 'lib/store.ts', 'tests/member-price-proof-gaps.test.ts', 'tests/member-price.test.ts', 'tests/plan-cost-registry.ts', 'tests/store-data-registry.ts', 'proofs/v/2999/member-family.proof.ts'];
const r=spawnSync(process.execPath,args,{timeout:120000,maxBuffer:262144,encoding:'utf8',killSignal:'SIGKILL'});
const output=(r.stdout??'')+(r.stderr??'')+'\nV2999_VALIDATOR '+JSON.stringify({label,status:r.status,signal:r.signal,error:r.error?.message??null})+'\n';
writeFileSync(`proofs/v/2999/${label}.log`,output);process.stdout.write(output);process.exitCode=r.status??1;
