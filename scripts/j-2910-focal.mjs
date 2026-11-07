import {build} from 'esbuild';
import {readFileSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=resolve(import.meta.dirname,'..'),here=join(root,'tests');
const mode=process.argv[2]??'head',file=process.argv[3]??'embed-library-unknown.test.ts';
if(!['head','old-library','derived'].includes(mode))throw Error('mode');
if(!['embed-library-unknown.test.ts','buyer-library.test.ts','embed.test.ts','platform-us-english.test.ts'].includes(file)||mode!=='head'&&file!=='embed-library-unknown.test.ts')throw Error('file scope');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const target='8619a3ea07ddb4553854d677509e096dc8f6911e';
const own=['scripts/j-2910-focal.mjs','docs/reviews/j-2910-focal-2026-11-07.md','docs/reviews/j-2910-focal-2026-11-07.output.txt'];
const changed=execFileSync('git',['diff','--name-only',target,'--'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
if(changed.some(p=>!own.includes(p)))throw Error('source differs from exact target');
const out=mkdtempSync('/dev/shm/j2910-'),bundle=join(out,'proof.cjs');
const blocked=`const net=require('node:net');net.Socket.prototype.connect=function(){throw Error('REVIEW_SOCKET_BLOCKED')};for(const p of ['node:http','node:https']){const m=require(p);m.request=m.get=function(){throw Error('REVIEW_HTTP_BLOCKED')}};globalThis.__jRun=0;globalThis.__jFetch=0;let mockFetch=async()=>{throw Error('REVIEW_FETCH_BLOCKED')};Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return async(...args)=>{if(++globalThis.__jFetch>500)throw Error('REVIEW_MOCK_LIMIT');return mockFetch(...args)}},set(fn){mockFetch=fn}});process.on('exit',()=>console.log('J_COUNTS',JSON.stringify({run:globalThis.__jRun,fetch:globalThis.__jFetch})));`;
const plugin={name:'j-focal-observer',setup(b){
 b.onLoad({filter:/lib\/redis-memory\.ts$/},args=>{let s=readFileSync(args.path,'utf8');const needle='run(command: (string | number)[]): unknown {';if(!s.includes(needle))throw Error('run signature');s=s.replace(needle,needle+'\n if (++(globalThis as unknown as {__jRun:number}).__jRun > 20000) throw Error("REVIEW_RUN_LIMIT");');return {contents:s,loader:'ts'};});
 if(mode==='old-library')b.onLoad({filter:/lib\/buyer-library\.ts$/},()=>({contents:execFileSync('git',['show','f09a47fff80aa9eeb93732a34f2a9b0e91881258:lib/buyer-library.ts'],{cwd:root,encoding:'utf8'}),loader:'ts'}));
 if(mode==='derived')b.onLoad({filter:/tests\/embed-library-unknown\.test\.ts$/},args=>{
  let s=readFileSync(args.path,'utf8');
  s=s.replace('[["a failed request", failed]] as const','[["a failed request", failed],["J missing member",()=>[null,null]],["J no envelope",()=>[]],["J word member",()=>["QUEUED",null]],["J invalid member",()=>[2,null]]] as const');
  const point='  part("The card: a product that could not be read");';
  s=s.replace(point,`  for(const [name,reply] of [["missing",()=>[]],["number",()=>[7]]] as const){
    inject={when:getOf("nl:store:handle:"),reply};const shown=await card("emblibunknown",fromHead);inject=null;
    is("J store "+name+": no false off-sale",shown.includes("no longer on sale"),false);
    is("J store "+name+": honest unavailable",shown.includes("could not be loaded just now"),true);
  }\n`+point);
  s=s.replace('  delete process.env.RESEND_API_KEY;',`  for(const [name,reply] of [["missing",()=>[]],["number",()=>[7]]] as const){
    inject={when:getOf("nl:store:id:"),reply};const result=await ask(buyer,name==="missing"?"203.0.113.24":"203.0.113.25");inject=null;
    is("J ask "+name+": not falsely sent",result,"error");
    is("J ask "+name+": no token",made.length,1);
  }\n  delete process.env.RESEND_API_KEY;`);
  s=s.replace('  done();',`  inject={when:getOf("nl:store:id:"),reply:()=>[7]};const malformedStore=await library();inject=null;
  is("J library malformed store: not empty",malformedStore.includes("Nothing is listed for this address"),false);
  is("J library malformed store: unavailable",malformedStore.includes("1 store could not be read just now"),true);
  done();`);
  return {contents:s,loader:'ts'};
 });
}};
await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,alias:testAliases(file,root,here),banner:{js:blocked},plugins:[plugin],logLevel:'error'});
console.log('J_MODE',mode,'HEAD',head);
const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment({...process.env,TMPDIR:'/dev/shm'}),encoding:'utf8',timeout:120000,maxBuffer:262144});
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');console.log('J_CHILD_EXIT',r.status);if(r.error)throw r.error;process.exitCode=r.status??2;
