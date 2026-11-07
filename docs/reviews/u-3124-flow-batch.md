# PR #3124: independent review and residual sparse-reply evidence

Candidate4103f03d6a417a9e9bbaae05c2805a3d8f957f93. Base09dd1ece44482e239e4d10bd690d9e46ab1e2fcc.
Claim6712564426 and channel reservation7b4e07c61bde3ea0b50941ff4639f9a2114c5456 precede source/diff/tests.
Entire two-file delta and sender/group/putBack/contact/run paths inspected.

## Disposition: one conditional MEDIUM proposed, not unconditionally cleared

The new exact-shape validator still skips absent array positions. This is the same unknown-row/lease class addressed by the PR, not three distinct findings and not a claim of a new regression:
- lib/flows.ts:1157-1165: rows.some skips holes. A correctly sized sparse row array passes validation; found[i] is undefined, parseContact returns null, and the real run is ended as left with the false unsubscribe/removal note. On a later healthy read it stays left with no email queued.
- reply.slice(1) preserves a missing outer score position, scores.every skips it, and undefined !== null marks the lease held. The real SES stand-in is called and the run advances despite an unknown score.

Separate probe adds exactly two injected-shape cases to the permanent source; every existing assertion is unchanged. Candidate17 checks/3 failures/14 passing (including all original13). Rows-hole case: expected [running,0,0,true], got [left,-1,0,false]; recovery expected [1,running,1], got [0,left,-1]. Score-hole case: expected [running,0,0,true], got [running,1,1,false]; recovery assertion passes because the send already happened.

Same17 on prior production source:15 failures/2 controls. Thus these vectors are inherited/residual, not introduced as a new normal Redis behavior. Sparse arrays are injected malformed runtime replies; this does NOT prove Upstash/JSON produces holes in production, live delivery, consent violation occurrence or financial loss.

Revisor2: execute the SAME probe/runner and classify. Claude4: dispose this conditional finding before author repair or unconditional release. Suggested causal approach after disposition: exact own-slot envelope validation (repliesFor or equivalent) on both outer replies and rows, then existing nullable string/score checks. No new Redis call is needed. No product fix was made by U.

## Qualified checks

| Test | Current result | MemoryRedis.run | Synthetic HTTP |
|---|---|---:|---:|
| Permanent13 |13/13 pass|956|16|
| workflow-retries |31/31 pass|461|4|
| workflow-run-history |19/19 pass|420|5|
| Separate17 sparse probe |3 fail/14 pass|1122|18|

63 ordinary current passing checks. The17-probe retains/overlaps the original13; do not add its14 passing checks as unique new GREEN coverage.
Permanent source-only RED:13 checks/11 failures,511run/6mockHTTP. Permanent blobf7fc28d59f8816c10d70920a60095567834ccc5f is byte-identical to RED131c8441222a8aee8d2aa559ff22aa56bab00d97.
Separate probe source-only RED:17/15 failures,596run/6mockHTTP. Both RED modes substitute only lib/flows.ts from131c8441 in the final dependency graph, not an entire historical checkout.

Selected actual repository TypeScript:3 roots/0 diagnostics (flows,permanent,probe),ES2017 strict bundler,no emit,1024MiB. Lint these3:exit0/no output. Scanner4324 tracked/0 corrections including staged own probe. Entire product diff and own staged diff checks pass. No global tsc/build/Actions/AT/browser/nativeRedis/SES/provider/MR certificate.

Declared existing queue ZREM/putBack/orphan claims, corrupt JSON contact behavior and stop-note count are outside this new finding and remain separately disclosed by the author. Dependencies2861/3083/1927 and compositions are not certified here.

## Provenance and execution boundary

Probe tests/u-review-3124-sparse-replies.proof.ts Gitblobc9f6354aabdd78fd646015c25a1406d5e9f9967d, SHA256619043277ccb9a74132141e86399ee169cd03b756b52f961056be44b90d403bd.
Permanent SHA2569e235ae1506a972a38fd763efbd32cfae7ca891c6e4ee8da29477be3fd4c6d89.
Runner SHA25698b37e3dfb679ee2c6575097cba410196f1db3c8a339789a91c2f6a056a225b6.

All test subprocesses:120s,512MiB heap,256KiB output,<=20k MemoryRedis.run and100 mockHTTP admissions before dispatch. Counts include nested MemoryRedis.run; injected pipeline replies can bypass that stub. These are synthetic execution ceilings, not paid IO accounting. Network sockets denied before graph evaluation; fetch defaults to refusal, SES fixture and other replacements are canned. No author source/ref,CI,queue,price,limit,flag or gate changed. Serial/no subagents.

Copy probe and runner to an exact detached candidate checkout:
node runner.mjs /candidate red flow-due-batch-rows-unknown.test.ts
node runner.mjs /candidate current flow-due-batch-rows-unknown.test.ts workflow-retries.test.ts workflow-run-history.test.ts
node runner.mjs /candidate diagnostic u-review-3124-sparse-replies.proof.ts (expected exit1)
node runner.mjs /candidate red u-review-3124-sparse-replies.proof.ts (expected exit1)

## Exact launcher

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
const changed=new Set(execFileSync('git',['diff','--name-only','09dd1ece','4103f03d'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>!f.startsWith('tests/')));
const banner=`require('node:net').Socket.prototype.connect=function(){throw new Error('external sockets denied')};let http=0;let fetchImpl=async()=>{throw new Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...args)=>{if(http>=100)throw new Error('HTTP budget before dispatch');http++;return fetchImpl(...args)}},set(fn){fetchImpl=fn}});process.once('exit',()=>console.log('ADMITTED synthetic HTTP:',http,'/100'));`;
for(const file of files){
 const out='/tmp/u-3124-'+mode+'-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:banner},plugins:[{name:'bounded-review',setup(b){b.onLoad({filter:/\.(?:ts|tsx|js|mjs|cjs)$/},args=>{
 const f=relative(root,args.path);let text;
 if(mode==='red'&&changed.has(f))text=execFileSync('git',['show','131c8441:'+f],{cwd:root,encoding:'utf8'});
 else if(f==='lib/redis-memory.ts')text=readFileSync(args.path,'utf8');
 else return;
 if(f==='lib/redis-memory.ts')text+='\nlet n=0;const real=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(cmd){if(n>=20000)throw new Error("Redis budget before dispatch");n++;return real.call(this,cmd)};process.once("exit",()=>console.log("ADMITTED synthetic Redis:",n,"/20000"));';
 return {contents:text,loader:f.endsWith('.tsx')?'tsx':f.endsWith('.ts')?'ts':'js'};
 });}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-3124-'+mode+'-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(mode,file,'exit',run.status,(run.stdout||'').split('\n').filter(x=>/checks|ADMITTED|pass |fail |tests /.test(x)).join(' | '));
 if(run.error||(mode!=='red'&&run.status!==0))throw run.error||new Error('failed '+file);
}

```

## Current probe output

```text

Control: an exact reply sends the step
  ok    the first step went out once and the run is on to step two

The due step's read: the rows answered with a word, not a list
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: no answer for the rows
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: a number where the person's row belongs
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: a shorter list of rows
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: no answer for the lease entry's score
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: a list where the lease entry's score belongs
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: a hole in the rows array
  FAIL  the run is not ended, nothing is sent, and the step is back in the queue
        expected ["running",0,0,true]
        got      ["left",-1,0,false]
  FAIL  on the next run, read exactly, the step goes out once and the run goes on
        expected [1,"running",1]
        got      [0,"left",-1]

The due step's read: a hole in the outer score slot
  FAIL  the run is not ended, nothing is sent, and the step is back in the queue
        expected ["running",0,0,true]
        got      ["running",1,1,false]
  ok    on the next run, read exactly, the step goes out once and the run goes on

17 checks, 3 failing.
ADMITTED synthetic HTTP: 18 /100
ADMITTED synthetic Redis: 1122 /20000
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63384:13)
    at async sendDueSteps (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63333:9)
    at async main (/tmp/u-3124-diagnostic-u-review-3124-sparse-replies.proof.ts.cjs:63977:5)

```
