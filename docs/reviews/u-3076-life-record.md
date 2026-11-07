# PR #3076: independent incremental review

Candidate e926602c42fa2bb576e4e1aaee45bee39725ebd1; stacked #2905 head 0e0c2b3c1d; own RED f8ac197d53. Reviewed the entire final two-commit delta (three files) and supporting readPathCounts, countsFrom, path snapshot update, readLifeFlat, Tally and count writers. This is an incremental review, not global approval of the old #2905 stack or #3074 composition. Claims: 6711337016 before source/tests; channel e98fb532d251129c64bcd4dc4d4d04d8833048fa. Date 2026-11-07.

## Disposition

No new HIGH/MEDIUM demonstrated in this delta. One conditional LOW remains in the same unknown-count class: negative source counts are accepted as signed integers and then clamped to zero by countsFrom. This does not represent a normal view writer response: recordHit adds +1 to r:<source>. It is demonstrated only with an injected malformed read, not live Redis or a production occurrence. No product repair was made.

At lib/stats.ts:686 the new regex permits "-4"; readLifeRecord therefore returns a map, and lib/path-facts.ts countsFrom clamps that value to zero. With a healthy stored r:instagram=4, an injected r:instagram="-4" returns {social:0,visitors:3,links:1,leads:0}, rather than null. readPathCounts' documented fallback is null to retain the previous reading; lib/path.ts:209 replaces stored counts when readCounts is non-null.

The separate unchanged four-check probe fails once on both old source and candidate, with three controls passing. Healthy values before/after prove the persisted record was not modified. Its cm:usd=-100 control is merely an arbitrary synthetic extension field; the label "signed currency amount" does NOT establish a real production currency field/writer or certify signed financial-domain values. The actual negative-view assertion does not depend on that field.

Suggested follow-up: classify count domains before rejecting negatives; do not blindly change monetary behavior or policy. This LOW is nonblocking in this review. Dependencies, another independent money review and nine current exact-head checks remain the author's gates.

## Qualified results and limits

- Permanent r24-life-record: 21 current passing. Test is byte-identical to its RED commit, blob43e4f01f3206bbf4792b0dab8cbf131c21b950f3, SHA2569cb1cbdb5dbb2a0cb15718bf19287ce681a2259c57c1b9bfd7b99e2e62f2395b.
- Source-only RED: final test/dependency graph with two changed production modules substituted from f8ac197d: 21 checks/14 failing. Two source guards read current files and remain passing in this transform. This is NOT the author's full-checkout 21/16 RED; that historical result is credited, not claimed rerun.
- Linked path-facts39 and short-links16 pass: 76 current checks total with permanent21. Current synthetic Redis counts623+99+438=1160, HTTP0+17+0=17.
- Additional stats-life-lock-exact was attempted but hit the 20,000 MemoryRedis.run pre-dispatch ceiling. It is INCONCLUSIVE, not product RED and not GREEN. No ceiling increase/retry. Its repeated readStats/fill fixtures exceeded the test budget; denied commands do not dispatch.
- Separate negative probe: four checks/one failing/three controls on both sources, nine MemoryRedis.run/zero HTTP each. It is not part of the 76 passing checks.
- Selected repository TypeScript: five roots/zero diagnostics, ES2017 strict bundler/no emit, 1024MiB heap. Roots stats, short-links, path-facts, permanent test, own probe. Not global tsc.
- ESLint on two product modules, permanent test and probe: no output/exit0. Scanner4274 tracked (includes staged own probe)/zero corrections. Product delta and own staged diff checks pass.

Every test child has 120s,512MiB heap,256KiB output,20,000 MemoryRedis.run admissions before dispatch and100 mockHTTP calls before dispatch. Socket connections are denied before graph evaluation; initial fetch refuses, test assignments are canned fixtures through repository aliases. No external provider, browser, native Redis/Lua, regional cost or production certification. Injected replies can bypass stub counters; these are synthetic execution limits, not paid command accounting. No author branch/source, CI, queue, price, limit, flag or gate changed.

Reproduce on a detached exact candidate checkout after copying the probe:
- node runner.mjs /candidate red r24-life-record.test.ts
- node runner.mjs /candidate current r24-life-record.test.ts path-facts.test.ts short-links.test.ts
- node runner.mjs /candidate diagnostic u-review-3076-negative-view.proof.ts (expected exit1)
- node runner.mjs /candidate red u-review-3076-negative-view.proof.ts (expected exit1)
The separate capped suite can be observed with current stats-life-lock-exact.test.ts; do not call it passing.

## Exact launcher

SHA256 a0819f0a906dc705437053138a61793d0f7c99a86a8599ac58d8167a5853465b.
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
const changed=new Set(execFileSync('git',['diff','--name-only','0e0c2b3c','e926602c'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>!f.startsWith('tests/')));
const banner=`require('node:net').Socket.prototype.connect=function(){throw new Error('external sockets denied')};let http=0;let fetchImpl=async()=>{throw new Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...args)=>{if(http>=100)throw new Error('HTTP budget before dispatch');http++;return fetchImpl(...args)}},set(fn){fetchImpl=fn}});process.once('exit',()=>console.log('ADMITTED synthetic HTTP:',http,'/100'));`;
for(const file of files){
 const out='/tmp/u-3076-'+mode+'-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:banner},plugins:[{name:'bounded-review',setup(b){b.onLoad({filter:/\.(?:ts|tsx|js|mjs|cjs)$/},args=>{
 const f=relative(root,args.path);let text;
 if(mode==='red'&&changed.has(f))text=execFileSync('git',['show','f8ac197d:'+f],{cwd:root,encoding:'utf8'});
 else if(f==='lib/redis-memory.ts')text=readFileSync(args.path,'utf8');
 else return;
 if(f==='lib/redis-memory.ts')text+='\nlet n=0;const real=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(cmd){if(n>=20000)throw new Error("Redis budget before dispatch");n++;return real.call(this,cmd)};process.once("exit",()=>console.log("ADMITTED synthetic Redis:",n,"/20000"));';
 return {contents:text,loader:f.endsWith('.tsx')?'tsx':f.endsWith('.ts')?'ts':'js'};
 });}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-3076-'+mode+'-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(mode,file,'exit',run.status,(run.stdout||'').split('\n').filter(x=>/checks|ADMITTED|pass |fail |tests /.test(x)).join(' | '));
 if(run.error||(mode!=='red'&&run.status!==0))throw run.error||new Error('failed '+file);
}

```

## Current probe output

```text
  ok    healthy social and visitor counts
  ok    signed currency amount remains readable
  FAIL  negative visit count is unknown, not zero social visits
        expected null
        got      {"at":1794076184411,"social":0,"visitors":3,"links":1,"leads":0}
  ok    underlying healthy record was not modified

4 checks, 1 failing.
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 9 /20000

```
