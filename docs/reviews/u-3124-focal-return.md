# Codex U: focal return on PR #3124

Subject: `7d6526a35e010a1bd37e5578f4b8433aaf21af47`, compared with original reviewed `4103f03d6a417a9e9bbaae05c2805a3d8f957f93`.
Request: issue comment 6712773785. Pre-source claim: 6713198528. Channel reservation: 2c14da759a66fe8453e892f58a40dda2bab46f71.

## Disposition

The conditional MEDIUM in my review 5814778953 is closed in this exact subject. No additional grave/medium finding was demonstrated in the causal delta. This is an original-reviewer focal return, not a new global review, CI certification, GitHub approval event or authorization to bypass the merge queue.

The full corrective delta is two files: `lib/flows.ts` and the unchanged frozen probe adopted as `tests/flow-due-batch-holes.test.ts`. Both envelopes now pass through `repliesFor`: the outer pipeline must own all expected slots, and the HMGET row list must own all expected row slots. This happens before interpreting rows, collecting held leases, noting runs, claiming attempts or calling the email stand-in. Unknown envelopes throw into the existing deferred retry path. Exact null retains its existing meaning; no provider request or Redis key family was added.

## Same proof, without weakened assertions

The adopted 17-check file is byte-identical to my original evidence test: Git blob `c9f6354aabdd78fd646015c25a1406d5e9f9967d`, SHA256 `619043277ccb9a74132141e86399ee169cd03b756b52f961056be44b90d403bd`.
Frozen historical evidence remains in `codex/u-review-3124-flow-batch@97ed0da7c4ffcd82bbef17cb56df3fb883754707` (report `docs/reviews/u-3124-flow-batch.md`). It records 17 checks / 3 failures against the old reviewed subject, with 14 controls passing. I did not rerun or relabel that historical RED today. Author RED `0aa316c597` adds the same file with no `lib/` difference from 4103f03d (verified locally with git diff --exit-code).

On the new exact subject the same file passes 17/17: a sparse row reply no longer ends the run as left, and a sparse outer score slot no longer authorizes an attempt. Both defer with no simulated email attempt and recover to one attempt on the next healthy read. These malformed runtime arrays are synthetic; this does not establish that sparse arrays occur through a normal JSON Upstash response.

Current focal checks, run once per file:

| Test | Result | MemoryRedis.run | Synthetic HTTP |
| --- | --- | --- | --- |
| flow-due-batch-holes | 17/17 | 1218 | 20 |
| flow-due-batch-rows-unknown | 13/13 | 956 | 16 |
| workflow-retries | 31/31 | 461 | 4 |
| workflow-run-history | 19/19 | 420 | 5 |
| Total | 80/80 | 3055 | 45 |

The permanent 13 controls overlap the frozen 17; the aggregate is 80 actual assertions executed, not 80 distinct behaviors. Selected-root actual-tsconfig types: three roots (`lib/flows.ts`, both due-batch tests), zero diagnostics, no emit, 1024MiB cap. ESLint on those three files: exit0/no output. Public data scanner: 4324 tracked files, zero corrections. Causal `git diff --check`: exit0. Detached subject worktree remained clean.

## Import overlap and limits

I read #2861's `lib/flows.ts` import at exact `9d9fdd568a278b8903ce2e3221ef6764f08cc022`: `import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";`. Keeping this union preserves both symbols. That is a static conflict-resolution observation, not a locally executed merged-product test or fresh mergeability/CI claim. The author reports having tested the resolution; that report is credited to the author only.

Existing explicitly declared queue-claim/putBack numeric conversions and corrupt JSON policy are outside this corrective delta and remain separately identified. No new global audit of those paths, browser, native Redis/Lua, real SES/Stripe, actual delivery, productive cost or global MR assertion. No author source/ref, CI, queue or product PR was changed by U. No new product unit was opened.

## Bounded synthetic execution

The same frozen launcher from the original evidence was used in mode `focal`, on this new detached subject. Before each child dispatch: 20,000 MemoryRedis.run admissions (including nested calls), 100 mock fetch calls, 120 seconds, 512MiB heap, 256KiB captured output. Socket connect is denied before the application graph; default fetch is denied and fixture fetches remain counted. Four children completed below their limits. No paid provider IO. Expected caught errors for malformed cases are preserved below, not suppressed.

Commands:

```sh
node /tmp/u-3124-run.mjs "$PWD" focal flow-due-batch-holes.test.ts flow-due-batch-rows-unknown.test.ts workflow-retries.test.ts workflow-run-history.test.ts
node --max-old-space-size=1024 /tmp/codex-u-verify.mjs "$PWD" types lib/flows.ts tests/flow-due-batch-holes.test.ts tests/flow-due-batch-rows-unknown.test.ts
node node_modules/eslint/bin/eslint.js lib/flows.ts tests/flow-due-batch-holes.test.ts tests/flow-due-batch-rows-unknown.test.ts
python3 scripts/check_public_data.py
git diff --check 4103f03d 7d6526a3
```

## Launcher used

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

## Raw output: flow-due-batch-holes.test.ts

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
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

The due step's read: a hole in the outer score slot
  ok    the run is not ended, nothing is sent, and the step is back in the queue
  ok    on the next run, read exactly, the step goes out once and the run goes on

17 checks, all passing.
ADMITTED synthetic HTTP: 20 /100
ADMITTED synthetic Redis: 1218 /20000
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-holes.test.ts.cjs:63979:5)

```

## Raw output: flow-due-batch-rows-unknown.test.ts

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

13 checks, all passing.
ADMITTED synthetic HTTP: 16 /100
ADMITTED synthetic Redis: 956 /20000
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)
sending a sequence step failed Error: A due workflow step's rows or lease entries could not be read
    at sendGroup (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63385:13)
    at async sendDueSteps (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63333:9)
    at async main (/tmp/u-3124-focal-flow-due-batch-rows-unknown.test.ts.cjs:63973:5)

```

## Raw output: workflow-retries.test.ts

```text

When a waiting step is tried again
  ok    the fixture uses one clock for timestamps and UTC day keys
  ok    without a known end: 10 minutes, then three times longer each time, a day at the most
  ok    the month's emails: once, a minute after the window turns
  ok    a pause: a minute after it ends
  ok    the day's room: just after the next UTC day begins
  ok    near midnight the daily retry retains the ten-minute minimum
  ok    after midnight the daily retry waits for the following day
  ok    an unknown end falls back to the growing delay
  ok    a list's portion: at least fifteen minutes
  ok    a run may wait while it is within both bounds
  ok    one wait past the most a run may
  ok    a step waiting more than 35 days
  ok    a count that cannot be read stops it: unknown is not room

The worst case per run counts every wait and every retry
  ok    start, every step and each retry of the creator's, and every wait
  ok    and the commercial review captures the bounds

Every way a run stops, listed
  ok    the goal, each ending condition and end, the last step, and the engine's own
  ok    the bounds are the code's numbers
  ok    a workflow with no goal and no conditions still lists the engine's stops

The preview writes nothing
  ok    no database command and no key

A run waits a bounded number of times, then stops
  ok    the first daily wait honors the ten-minute minimum near UTC midnight
  ok    after 3 waits it is still waiting, nothing sent, nothing written to its history
  ok    one wait costs at most 32 database commands, the store's own reads included
  ok    one wait more and the run stops, with nothing done at that step
  ok    its history says why
  ok    and it is no longer in the queue

A wait for the month's emails is tried once, when the month turns
  ok    queued for a minute after the store's window turns
  ok    that wait cost at most 32 database commands too

Trying a held step again is bounded
  ok    a lost answer holds the run
  ok    taken 1 times, then refused
  ok    the run says how often it was tried again
  ok    refused, it stays held for the creator's other choices

31 checks, all passing.
ADMITTED synthetic HTTP: 4 /100
ADMITTED synthetic Redis: 461 /20000

```

## Raw output: workflow-run-history.test.ts

```text

Effects are counted four ways, and nothing unconfirmed counts as done
  ok    four attempts: one confirmed, one failed, two uncertain
  ok    the one marked as gone through by the creator stays uncertain, with their choice beside it
  ok    an attempt with no outcome yet is uncertain and waiting, never done
  ok    a full history is not trimmed
  ok    a skipped step is not an effect
  ok    a step tried again is two attempts: the first stays uncertain, the second is confirmed
  ok    a history whose earliest events were let go says so, and still counts the outcome it kept

Bounds by construction
  ok    a workflow keeps at most the plan's runs a day for as long as a start is remembered
  ok    after a choice, there is room for everything a run can still write

A step that waits writes nothing new
  ok    it waits: nothing was sent
  ok    and its history is still just its start
  ok    once there is room it goes out, written down once: attempted, then confirmed
  ok    counted as one attempt, confirmed

A held run's history stays bounded, whatever came before the creator's choice
  ok    a lost answer holds the run
  ok    trying it again is taken 1 time, then refused
  ok    going on past it is the creator's word
  ok    the choice keeps the latest 20 events, room for all that can follow
  ok    the history says its earliest events were let go
  ok    its last event is the creator's choice, and nothing it kept counts as confirmed

19 checks, all passing.
ADMITTED synthetic HTTP: 5 /100
ADMITTED synthetic Redis: 420 /20000

```
