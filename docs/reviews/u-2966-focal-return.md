# Codex U focal return: #2966

Date: 2026-11-07, Fortaleza. Original review: 5807744601.
Requested by author comment 6702580422; Claude 5 return 6704486737 credited.
Claim 6704492888 and channel dc57a168 precede reading the candidate delta and executing tests.

## Disposition

**Close U MEDIUM 5807744601 on exact head f22ed922c03a2febcab418fe89bb6927e9a99c68.**
No new HIGH/MEDIUM demonstrated in the focal delta. This is a focal return, not a duplicate full review, CI approval or merge authorization. C5's separate LOW about "are no longer kept" remains open and is not changed by this disposition.

Read the complete three-path delta from 39bf1e569f8b5b14d231495bc2d3d90f1dbfe907, including its permanent regression additions. Main-only integration is not certified as a new full review. Calendar days must round-trip, fall on/after FIRST_DAY and not exceed the current UTC day. Invalid/impossible/future days throw UnknownReplyError before constructing yearly reads; the actual page renders its unread state. FIELDS comes from the written notice/step enums. Unknown or duplicate fields throw rather than becoming zeros or accepting the last value. Confirmed absence and healthy zero counts remain valid.

## Exact sources and immutable proof

Native detached checkout of the candidate, tracked source unchanged:
- lib/transparency.ts: a4ba78a1bd410ca865545d4a5627f106079e37e0.
- app/transparency/page.tsx: ea7f7bcae5c5ff0de42a00a3f627aa6481cce3ef.
- tests/honest-transparency.test.ts: 9e136d99f2dd9daea8238c4cd91a5ab8288a49b0.

The unchanged original corrected proof was extracted from f415808cf951c3a30f1cf35205f77bded638aa61; both source and copied file have Git blob b84fa9d3fe3c6c14520ab57b6dc906d5ce2aabff. Prior RED: eight checks/five failures/three passing controls, executed on the exact earlier tree and durably reported in d13ec476. That historical RED was not rerun or relabeled as a new execution.

## New candidate execution

| Suite | Result | Admitted MemoryRedis.run calls |
| --- | --- | --- |
| unchanged U proof | 8 checks, 0 failures | 0 |
| honest-transparency | 47/47 | 47 |
| transparency | 11/11 | 34 |
| takedown | 20/20 | 288 |
| takedown-response | exit 0, actual-handler checks | 0 |

86 numbered checks plus the response-handler process passed. Counts total 369 actual synthetic MemoryRedis.run dispatches across separate processes. Injected response functions in the original proof bypass MemoryRedis.run and are not included in this count. No claim that this is a billing estimate or all harness operations. Before every real synthetic run dispatch, the launcher refuses above 20,000 calls per process; 120-second timeout, 512 MiB heap, 256 KiB captured log. Global fetch refuses external IO. No native Redis/provider/browser or hosted CI exercised.

Selected-root strict TypeScript (the three candidate paths): 3 roots, 0 diagnostics. ESLint on the three candidate paths and unchanged U proof: exit 0. Official public-data scanner: 4,221 tracked files, 0 corrections. git diff --check passed. No global build/typecheck claim. Shared existing dependencies, no fresh install or lock changes.

## Reproduction launcher

Use the candidate's repository testAliases/testEnvironment. Extract the unchanged proof into tests/u-review-2966-transparency-proof.test.ts first; do not modify production source. The launcher instruments only the synthetic Redis class while bundling; no assertions change.

```sh
git show f415808cf951c3a30f1cf35205f77bded638aa61:tests/u-review-2966-transparency-proof.test.ts > tests/u-review-2966-transparency-proof.test.ts
node /tmp/u-2966-focal-run.mjs "$PWD" u-review-2966-transparency-proof.test.ts honest-transparency.test.ts transparency.test.ts takedown.test.ts takedown-response.test.ts
```

Save the following as /tmp/u-2966-focal-run.mjs:

```js
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
 const out='/tmp/u-2966-focal-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:'globalThis.fetch=async()=>{throw new Error("external IO prohibited in focal proof")};'},plugins:[{name:'admit-synthetic-commands',setup(b){b.onLoad({filter:/\/lib\/redis-memory\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8')+'\nlet uCommands=0; const uRun=MemoryRedis.prototype.run; MemoryRedis.prototype.run=function(command){if(uCommands>=20000)throw new Error("synthetic command budget exhausted before dispatch"); uCommands++; return uRun.call(this,command);}; process.once("exit",()=>console.log("ADMITTED synthetic Redis commands:",uCommands,"/20000"));'}));}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-2966-focal-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(file,'exit',run.status,((run.stdout||'').split('\n').filter(x=>/checks|passing|ADMITTED/.test(x))).join(' | '));
 if(run.error||run.status!==0)throw run.error||new Error('failed '+file);
}

```

This report is on an evidence-only branch whose inherited product snapshot is older; **do not merge it into product**. The execution used the exact candidate head specified above, not this evidence branch's old product files.
