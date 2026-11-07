# PR #2878: original U short-link finding — focal return

Reviewed candidate: `1481b6f31dd0f356ae9a87f75cc8eb0396d40283`.
Original U review: `5807366086`, against `97abb22d128294139e025cd7d3a72801c248c0ef`.
Request: C4-1240. Pre-source claim: issue comment `6709776579`; channel reservation `711d78d734d0e3f94d705022592ac078e20cc659`.

## Disposition

The original U MEDIUM is closed on the reviewed candidate. An unread store behind a live short link now returns HTTP 503, no Location header, and Cache-Control `private, no-store`, rather than a five-minute cacheable redirect to /l/ended. The identical link works before the injected malformed record and after the read recovers.

This is a focal return, not global approval of this financial/store PR. Claude 5's separately recorded MEDIUM B and LOW D are not closed by this report. No decision on CI, reservations, merge eligibility or queue admission is made here.

## Unchanged original evidence and historical RED

Original durable evidence: `codex/u-review-2878-short-link-proof@321512408a92d1be34263cd29d6558a4225c81e3`.
Test: `tests/u-review-2878-short-link.proof.ts`.
Git blob: `afa4d4f8bc0d4255a75d3584e1c21ca56aa30eb9`.
SHA-256: `c54f3bf639a6d385477b8b1a35d9bcc72ebf05dddf3fa7b2565528beb287069f`.

The five assertions were copied byte-for-byte into a detached checkout at the candidate. The historical original execution had five checks / three failures. That RED is preserved; it was not rerun or relabeled as new execution today. Today's unchanged five checks all pass on the candidate.

## Current verification

| Test | Passing checks | MemoryRedis.run admissions |
| --- | ---: | ---: |
| Original U proof | 5 | 19 |
| store-id-ref-exact.test.ts | 18 | 50 |
| store-read-exact.test.ts | 27 | 81 |
| store-owner-lookup.test.ts | 2 | 28 |
| short-links.test.ts | 16 | 438 |
| Total | 68 | 616 |

Every process exited 0. Selected-root TypeScript uses the repository tsconfig (ES2017, strict, bundler resolution), no emit, four roots: route, lib/store.ts, permanent store-id-ref test and unchanged U proof. Result: four roots / zero diagnostics. ESLint: zero errors, two existing unused-import warnings at lib/store.ts:35 (MAX_JOIN_HEADING and MAX_JOIN_LINE). Public-data scanner: 4,107 tracked files / zero corrections; the additional unchanged proof is untracked in the detached candidate. Candidate commit diff check and local diff check pass.

The corrective commit's entire two-file delta was read, along with the original-to-current store/route/test delta. lib/store.ts reference validation now rejects a malformed reference or a record carrying another store id as unknown. The route catches failed link/store reads around the two actual awaits. Confirmed missing-link and healthy-link behavior remains covered by the permanent test and linked short-link suite.

Candidate blobs:
- app/l/[code]/route.ts: `77b3a9264a91c8408a7fea5b5cda47629843f54b`
- lib/store.ts: `68ec1709f925d5569e7fa6bd26b01cad27cdf6bf`
- tests/store-id-ref-exact.test.ts: `4db8abe1f50c8bdc12d504eece3307cbb5cf61be`

## Execution boundary

Serial execution, no subagents. Each child is limited before launch to 120 seconds, 512 MiB Node heap and 256 KiB captured output. A bundle-only wrapper rejects dispatch after 20,000 MemoryRedis.run admissions per process, including nested run calls. Recorded counts measure those admissions, not paid Redis commands. Synthetic injected pipeline replies may bypass that counter; no paid IO is performed.

The repository testAliases/testEnvironment wire Redis to tests/redis-stub.ts and retain the standard AI-spend/resend fixtures. An initial fetch guard throws instead of using the network; the permanent reference test replaces fetch with its own canned HTTP 500 response. Neither is a provider request. No browser, live Redis, SES, Stripe or production execution is claimed.

Runner SHA-256: `a54c69bdd0611e94afb6ab28bc9dbe7d3f0f1707fcded4165c2fb764c4c0ab62`. Exact launcher is embedded below so this report does not depend on temporary files.

```javascript
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.argv[2];
const req=createRequire(join(root,'package.json'));
const {build}=req('esbuild');
const {testAliases,testEnvironment}=await import(pathToFileURL(join(root,'tests/test-config.mjs')));
for(const file of process.argv.slice(3)){
 const out='/tmp/u-2878-focal-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:'globalThis.fetch=async()=>{throw new Error("external IO prohibited in focal proof")};'},plugins:[{name:'admit-synthetic-commands',setup(b){b.onLoad({filter:/\/lib\/redis-memory\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8')+'\nlet uCommands=0; const uRun=MemoryRedis.prototype.run; MemoryRedis.prototype.run=function(command){if(uCommands>=20000)throw new Error("synthetic command budget exhausted before dispatch"); uCommands++; return uRun.call(this,command);}; process.once("exit",()=>console.log("ADMITTED synthetic Redis commands:",uCommands,"/20000"));'}));}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-2878-focal-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(file,'exit',run.status,((run.stdout||'').split('\n').filter(x=>/checks|passing|ADMITTED/.test(x))).join(' | '));
 if(run.error||run.status!==0)throw run.error||new Error('failed '+file);
}
```

The evidence branch has only this report added. The author's source, branch, CI and queue remain untouched.
