# Independent review of PR #3068

Candidate: c729894aa09b15c5f2793554f5fffa0d04aed792.
Actual stacked base: 650754aa0c59a2b3cff0c3e42f9efa155ff9515e (#3067).
Request: C4-1406. Pre-source claim: 6710645363. Reservation: channel commit ae3420322211f23ad91cd63ff71ca0274ae6b535.
Date: 2026-11-07.

## Disposition

No new HIGH or MEDIUM demonstrated in the full 26-file delta. The unknown public-request count now propagates UnknownReplyError; the modified callers either use their existing error notice, return the existing uncached temporary-failure response, or omit optional cart offers. Healthy and confirmed-spent controls retain their behavior. The orders route's address-dependent privacy catch remains uniform, while the unknown store-wide count is checked before purchases are read.

This is not financial/global approval of #3067 or its other callers. #3067 must enter first, the expected #2995 composition still needs verification, and the owner controls CI and queue gates. No author ref, source, CI or queue was changed.

## Current verification

| Suite | Pass | MemoryRedis.run admissions | Synthetic HTTP |
|---|---:|---:|---:|
| public-request-unknown |29|77|0|
| limit-unknown |20|14|0|
| orders-open |34 Node tests|5591|80|
| cart-offers |47|660|42|
| traffic |75|1928|0|
| Total |205|8270|122 across separate processes|

All qualified current children exited 0. Selected repository TypeScript: six roots / zero diagnostics, ES2017 strict bundler resolution, no emit, 1024 MiB heap. Roots: traffic, buyer-orders, cart-offers, metered-limits, orders route, new permanent test. This is not a global tsc or a type check of every route. ESLint all 26 changed files: exit 0, no errors/warnings. Scanner: 4282 tracked files / zero corrections. Full PR diff check: exit 0.

## RED provenance

Final permanent test blob: 8bb699ed37fd63a4b75d0ee4195fd0989e7743d1; SHA256 e1916cad072ed8b6b60e2d80e47ef5ef53c8c911def50059e8bd4ca93a536dfc.
The final test differs from RED 43cb854b221b997e204bcd7e2eb0de9adddfea47 solely by constructing the vCard request as NextRequest rather than Request; all assertions are retained. It is not a claim of byte-identical whole test files.

Qualified RED reuses this final test and final aliases/dependency graph, replacing only changed non-test source files with their exact git-show contents at 43cb854b. Result: 29 checks / 14 failures / 15 passing controls, exit 1, 77 MemoryRedis.run, zero HTTP. Current: 29/29. This isolates the corrective source delta; it is not an execution of the entire historical checkout.

## Harness correction, preserved

The first launcher mistakenly used an extension regex that did not match .ts. Consequently it neither substituted old source nor injected the Redis cap: its purported RED passed 29/29, and the first current tests were not Redis-capped. Those outputs are NOT accepted RED or capped GREEN evidence. No external network occurred (socket denial and HTTP guard were active), but no pre-dispatch Redis ceiling is claimed for that initial attempt.

The regex was corrected to match ts/tsx/js/mjs/cjs before the qualified RED/current rerun. Assertions and product files were unchanged. The qualified outputs explicitly print Redis admissions; initial logs are retained locally separately. The corrected launcher below is durable; its SHA256 is f2170075ed0bbb3d4020dc83461d6d95220d083ed5bee607d002cf8965e84dd2.

## Review scope and limitations

The entire 846-line PR diff was read, including both existing source-text guards and the one test-config alias addition. The permanent test exercises malformed counts and shares, confirmed exhaustion, a Redis throw, withinStore, real contact/orders/preview/vCard routes and optional ownedBeforeCart. Supporting request-guard, buyer-actions and count/share logic were inspected. repliesFor enforces exact envelope/own slots; countOf enforces a nonnegative safe integer. No new Redis command, amount, price, gate or limit is introduced by this delta.

Malformed count response now means unknown; an ordinary transport throw still returns false, explicitly retained by the author and this review. isResting remains unchanged. The shared plain-text 503 remains US English with no lang/title/navigation; the author already documents that gap. No new independent translation/accessibility certification, browser, AT, live Redis/Lua or provider execution is claimed.

Each qualified test child is admitted before launch with 120s, 512 MiB heap, 256 KiB captured output, 20,000 MemoryRedis.run (nested included) and 100 synthetic HTTP calls before dispatch. Counters measure synthetic stub activity, not paid command accounting. Injected replies can bypass the Redis stub; fixtures remain repository testAliases/testEnvironment. Socket connections are denied before graph evaluation, and fetch defaults to refusal; test replacements run only canned fixtures. 1024 MiB selected-root type analysis is separate from execution children.

Run from the exact candidate checkout (proof branch is evidence, not a later product head):
`node runner.mjs /absolute/candidate red public-request-unknown.test.ts`
`node runner.mjs /absolute/candidate current public-request-unknown.test.ts limit-unknown.test.ts orders-open.test.ts cart-offers.test.ts traffic.test.ts`

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
const changed=new Set(execFileSync('git',['diff','--name-only','650754aa','c729894a'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>!f.startsWith('tests/')));
const banner=`require('node:net').Socket.prototype.connect=function(){throw new Error('external sockets denied')};let http=0;let fetchImpl=async()=>{throw new Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...args)=>{if(http>=100)throw new Error('HTTP budget before dispatch');http++;return fetchImpl(...args)}},set(fn){fetchImpl=fn}});process.once('exit',()=>console.log('ADMITTED synthetic HTTP:',http,'/100'));`;
for(const file of files){
 const out='/tmp/u-3068-'+mode+'-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:banner},plugins:[{name:'bounded-review',setup(b){b.onLoad({filter:/\.(?:ts|tsx|js|mjs|cjs)$/},args=>{
 const f=relative(root,args.path);let text;
 if(mode==='red'&&changed.has(f))text=execFileSync('git',['show','43cb854b:'+f],{cwd:root,encoding:'utf8'});
 else if(f==='lib/redis-memory.ts')text=readFileSync(args.path,'utf8');
 else return;
 if(f==='lib/redis-memory.ts')text+='\nlet n=0;const real=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(cmd){if(n>=20000)throw new Error("Redis budget before dispatch");n++;return real.call(this,cmd)};process.once("exit",()=>console.log("ADMITTED synthetic Redis:",n,"/20000"));';
 return {contents:text,loader:f.endsWith('.tsx')?'tsx':f.endsWith('.ts')?'ts':'js'};
 });}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-3068-'+mode+'-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(mode,file,'exit',run.status,(run.stdout||'').split('\n').filter(x=>/checks|ADMITTED|pass |fail |tests /.test(x)).join(' | '));
 if(run.error||(mode!=='red'&&run.status!==0))throw run.error||new Error('failed '+file);
}
```
