import { build } from 'esbuild';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
const root=resolve(import.meta.dirname,'..'),target='00248858bc0a6064b308a5e0e6987a91bd2ddd5f',old='3b6a5cd32d8dfbdff7425f026d8a8de48329fd3c';
const mode=process.argv[2]??'head',file=process.argv[3]??'r24-inbox-exact.test.ts';
if(!['head','old-modules'].includes(mode)||!['r24-inbox-exact.test.ts','r24-inbox-erase-order.test.ts','j-3113-return.proof.ts','j-3113-partial-erase.proof.ts','inbox.test.ts','inbox-checked.test.ts','person-erasure.test.ts','person-copy.test.ts'].includes(file))throw Error('scope');
const priorOwn=['scripts/j-3113-focal.mjs','scripts/j-3113-types.mjs','tests/j-3113-partial-erase.proof.ts','docs/reviews/j-3113-inbox.md','docs/reviews/j-3113-inbox.output.txt'];
const own=[...priorOwn,'scripts/j-3113-return.mjs','scripts/j-3113-return-types.mjs','tests/j-3113-return.proof.ts','docs/reviews/j-3113-return.md','docs/reviews/j-3113-return.output.txt'];
const changed=execFileSync('git',['diff','--name-only',target,'--'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
if(changed.some(p=>!own.includes(p)))throw Error('not exact final graph');
const oldPaths=['lib/inbox.ts'];
const plugin={name:'j-3113-return',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$/},args=>{
 const relative=args.path.startsWith(root+'/')?args.path.slice(root.length+1):'';let contents;
 if(mode==='old-modules'&&oldPaths.includes(relative))contents=execFileSync('git',['show',old+':'+relative],{cwd:root,encoding:'utf8'});
 else if(relative==='lib/redis-memory.ts'||relative==='tests/'+file)contents=readFileSync(args.path,'utf8');else return;
 if(relative==='tests/'+file&&contents.includes('globalThis.fetch = (async'))contents=contents.replace('globalThis.fetch = (async','let __mock=0;globalThis.fetch = (async').replace('const url = new URL(String(input));','if(++__mock>100)throw Error("REVIEW_MOCK_LIMIT_BEFORE_DISPATCH"); const url = new URL(String(input));');
 if(relative==='lib/redis-memory.ts'){const anchor='run(command: (string | number)[]): unknown {';if(!contents.includes(anchor))throw Error('run anchor');contents=contents.replace(anchor,anchor+'\n if (++(globalThis as unknown as {__jRun:number}).__jRun > 20000) throw Error("REVIEW_RUN_LIMIT_BEFORE_DISPATCH");');}
 return{contents,loader:'ts'};
});}};
const guard=`const a=require('node:assert/strict');const no=()=>{throw Error('REVIEW_NETWORK_BLOCKED')};require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;for(const p of ['node:http','node:https'])require(p).request=require(p).get=no;globalThis.fetch=no;a.throws(()=>fetch('https://example.invalid'),/REVIEW_NETWORK_BLOCKED/);a.throws(()=>require('node:net').connect(443,'example.invalid'),/REVIEW_NETWORK_BLOCKED/);globalThis.__jMock=0;let fixture=no;Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return(...args)=>{if(++globalThis.__jMock>100)throw Error('REVIEW_HTTP_LIMIT_BEFORE_DISPATCH');return fixture(...args)}},set(v){fixture=v}});process.on('exit',()=>console.log('HTTP_MOCK_CALLS',globalThis.__jMock));console.log('NETWORK_NEGATIVE_CONTROLS_PASS_BEFORE_GRAPH');globalThis.__jRun=0;process.on('exit',()=>console.log('MEMORY_REDIS_RUN',globalThis.__jRun));`;
const out=mkdtempSync('/dev/shm/j3113-focal-'),bundle=join(out,'proof.cjs');
const built=await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,alias:testAliases(['j-3113-partial-erase.proof.ts','j-3113-return.proof.ts','r24-inbox-erase-order.test.ts'].includes(file)?'r24-inbox-exact.test.ts':file,root,join(root,'tests')),plugins:[plugin],banner:{js:guard},metafile:true,logLevel:'error'});
writeFileSync('/tmp/j3113-return-002-'+mode+'-'+file+'.meta.json',JSON.stringify(built.metafile));
console.log('J_3113_FOCAL',mode,file,'TARGET',target);
const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment({...process.env,TMPDIR:'/dev/shm'}),encoding:'utf8',timeout:120000,maxBuffer:262144});
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');console.log('J_CHILD_EXIT',r.status);if(r.error)throw r.error;process.exitCode=r.status??2;
