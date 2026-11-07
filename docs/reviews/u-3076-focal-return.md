# PR #3076: original U LOW focal return

Exact candidate: 1fd6ff66db946dc292dd3b4aa6a4a5cef8258386.
Original U review: 5814295630 (e926602c42fa2bb576e4e1aaee45bee39725ebd1).
Request:6711400632; pre-source claim6711902486.
Second independent opinion G5814399955 is credited, not rerun as a third global review.

## Disposition

Original U conditional negative-view LOW is CLOSED on this candidate. Entire corrective delta (two files) was read: lifeCounts now rejects negative counts and a permanent negative-view regression was added. recordHit writes positive counts; examined fill and vgap code transfers/adds count values. This is not a change to any monetary writer/domain. No new focal blocker demonstrated.

My original arbitrary cm:usd fixture was misleading as a healthy-control premise under the corrected domain. I explicitly retire that premise; it was never demonstrated to be a production currency field. This does not invalidate the separate demonstrated negative-view condition, but the old four-check fixture cannot honestly be called four GREEN. The original evidence and review remain unchanged.

## Original frozen proof and pre-execution disposition

Frozen original test at6a7caa62d4ac93417ffb638f5941b7616700c677, blob5f22d9d2fc604dd0546c559f256b8fd36d7c5673, was copied byte-for-byte and executed on the candidate. Its initial healthy assertion fails because cm:usd=-100 is already invalid; its subsequent direct readLifeRecord throws UnknownReplyError and aborts before all four assertions complete. Five MemoryRedis.run/zero HTTP, exit1. NOT four checks passing, NOT a new product regression. Raw output is retained below.

Before deriving a fixture, claim6711902486 publicly disposed this mismatch and allowed only removal of that arbitrary pair and its separate assertion while preserving the three core assertions. Channel3eb0e63e04cc55c9ca7236086fc308fbe5510e47 records the reservation; the first channel CAS409 did not write and retry waited>=120s/fresh full prefix.

Separate derivative: tests/u-review-3076-negative-view-domain.proof.ts, blob9f7fddb47a13e1ecf8f7dc9b51088dc255872a78, SHA2569257dab4c4e735238f44db3b6b3d8646fba5139b24f0bf6c9dafedf7349ae538. Deterministic transform: remove the HSET pair cm:usd/-100, remove its separate signed-field assertion, remove the now-unused readLifeRecord import. The three healthy/negative-view/recovery assertion lines are unchanged. This is NOT a byte-identical copy of the original four-check proof.

## Qualified results

| Check | Prior e926 source in final graph | Candidate | MemoryRedis.run per process |
|---|---|---|---|
| Separate domain derivative |3 checks/1 failure/2 controls|3/3 pass|8 each|
| Permanent final test |22 checks/1 failure|22/22 pass|627 each|
| path-facts |not rerun on old source|39/39 pass|99 current|
| short-links |not rerun on old source|16/16 pass|438 current|

80 current passing checks,1172 current synthetic Redis admissions,17 mock HTTP (path-facts only). Raw original failure is separate. Permanent final test blobb345010a57c43ac9f9525b6efe7aa65ff9be49d8 is byte-identical to corrective RED892b2400. RED substitutes only changed product source lib/stats.ts frome926 in the final graph. No full historical checkout replay is claimed; source guards read the final source.

Repository selected-root types: four roots/zero diagnostics (stats,path-facts,permanent,derivative),ES2017 strict bundler/no emit,1024MiB. Lint stats/permanent/frozen/derivative:zero output/exit0. Scanner4275 tracked, including two staged own tests/zero corrections. Product corrective diff and own staged diff checks pass.

Original capped stats-life-lock-exact remains INCONCLUSIVE for U; it was not retried and is not GREEN here. Author's129 success is attributed to the author only. No global type/build/Actions/browser/AT/nativeRedis/Lua/provider/MR certification.

## Execution boundary

Serial/no subagents. Before each test child:120s,512MiB heap,256KiB captured output,20k MemoryRedis.run admissions and100 synthetic HTTP calls before dispatch. Socket connections denied before graph evaluation; fetch defaults to refusal and test replacements use repository fixtures/testAliases/testEnvironment. Injected pipeline replies can bypass stub counters; these are synthetic bounds, not paid IO accounting. No author source/ref/CI/queue/limits/prices/flags changed. Dependencies2905/3074, reviews and nine exact-head checks remain author gates.

Run on an exact detached candidate checkout after copying frozen and derived tests:
node runner.mjs /candidate original u-review-3076-negative-view.proof.ts (expected abort)
node runner.mjs /candidate red u-review-3076-negative-view-domain.proof.ts r24-life-record.test.ts
node runner.mjs /candidate current u-review-3076-negative-view-domain.proof.ts r24-life-record.test.ts path-facts.test.ts short-links.test.ts

## Exact runner

SHA2562c4b993bfb39444d359745072df641dc002c58b431126896ce1b8562a1c95fdb.
```javascript
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join,relative} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const [root,mode,...files]=process.argv.slice(2);
const req=createRequire(join(root,'package.json'));
const {build}=req('esbuild');
const {testAliases,testEnvironment}=await import(pathToFileURL(join(root,'tests/test-config.mjs')));
const changed=new Set(execFileSync('git',['diff','--name-only','e926602c','1fd6ff66'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>!f.startsWith('tests/')));
const banner=`require('node:net').Socket.prototype.connect=function(){throw new Error('external sockets denied')};let http=0;let fetchImpl=async()=>{throw new Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...args)=>{if(http>=100)throw new Error('HTTP budget before dispatch');http++;return fetchImpl(...args)}},set(fn){fetchImpl=fn}});process.once('exit',()=>console.log('ADMITTED synthetic HTTP:',http,'/100'));`;
for(const file of files){
 const out='/tmp/u-3076-focal-'+mode+'-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:banner},plugins:[{name:'bounded-review',setup(b){b.onLoad({filter:/\.(?:ts|tsx|js|mjs|cjs)$/},args=>{
 const f=relative(root,args.path);let text;
 if(mode==='red'&&changed.has(f))text=execFileSync('git',['show','e926602c:'+f],{cwd:root,encoding:'utf8'});
 else if(f==='lib/redis-memory.ts')text=readFileSync(args.path,'utf8');
 else return;
 if(f==='lib/redis-memory.ts')text+='\nlet n=0;const real=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(cmd){if(n>=20000)throw new Error("Redis budget before dispatch");n++;return real.call(this,cmd)};process.once("exit",()=>console.log("ADMITTED synthetic Redis:",n,"/20000"));';
 return {contents:text,loader:f.endsWith('.tsx')?'tsx':f.endsWith('.ts')?'ts':'js'};
 });}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-3076-focal-'+mode+'-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(mode,file,'exit',run.status,(run.stdout||'').split('\n').filter(x=>/checks|ADMITTED|pass |fail |tests /.test(x)).join(' | '));
 if(run.error||(mode!=='red'&&run.status!==0))throw run.error||new Error('failed '+file);
}

```

## Frozen original raw output

```text
  FAIL  healthy social and visitor counts
        expected [4,3,1]
        got      [null,null,null]
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 5 /20000
reading a store's numbers for its path failed u3076negativeview UnknownReplyError: Redis answered the all-time record's counts in an unknown shape
    at lifeCounts (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11068:45)
    at readLifeRecord (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11075:10)
    at async Promise.all (index 0)
    at async readPathCounts (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11156:27)
    at async main (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11199:18)
/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11068
    if (!Number.isSafeInteger(count)) throw new UnknownReplyError("the all-time record's counts");
                                            ^

UnknownReplyError: Redis answered the all-time record's counts in an unknown shape
    at lifeCounts (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11068:45)
    at readLifeRecord (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11075:10)
    at async main (/tmp/u-3076-focal-original-u-review-3076-negative-view.proof.ts.cjs:11201:50)

Node.js v24.22.1

```
