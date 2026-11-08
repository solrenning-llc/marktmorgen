import { build } from 'esbuild';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { testAliases, testEnvironment } from '../../../tests/test-config.mjs';
const root=process.cwd(),file=process.argv[2];
const dir=mkdtempSync('/tmp/s-3234-'),out=join(dir,'test.cjs');
await build({entryPoints:[resolve(file)],outfile:out,bundle:true,platform:'node',format:'cjs',alias:testAliases(file.split('/').at(-1),root,join(root,'tests')),plugins:[{name:'bounded-source',setup(b){b.onLoad({filter:/\.[jt]sx?$/},a=>{
 let source=readFileSync(a.path,'utf8');const rel=relative(root,a.path); if(process.env.S_REVIEW_OLD && ['lib/closing-plan-guard.ts','lib/plan-closing.ts'].includes(rel)) source=execFileSync('git',['show',process.env.S_REVIEW_OLD+':'+rel],{encoding:'utf8'});
 if(process.env.S_REVIEW_GUARD && rel==='lib/closing-plan-guard.ts'){
 const a='if (typeof status !== "string") return false;';if(!source.includes(a))throw Error('invoice causal anchor');
 source=source.replace(a,'if (typeof status !== "string" || !["draft","open","paid","uncollectible","void"].includes(status)) return false;');
 const b='textField(row, "status") && Number.isSafeInteger(ownField(row, "amount"))';if(!source.includes(b))throw Error('refund causal anchor');
 source=source.replace(b,'textField(row, "status") && ["pending","requires_action","succeeded","failed","canceled"].includes(String(ownField(row, "status"))) && wholeAtLeast(ownField(row, "amount"), 0)');
 }
 if(rel==='lib/redis-memory.ts'){const anchor='run(command: (string | number)[]): unknown {';if(!source.includes(anchor))throw Error('missing Redis guard anchor');source=source.replace(anchor,anchor+' if (++(globalThis as any).__sRuns > 20000) throw Error("Redis ceiling");');}
 return {contents:source,loader:a.path.endsWith('tsx')?'tsx':'ts',resolveDir:resolve(a.path,'..')};
});}}]});
const guard=`(()=>{global.__sRuns=0;let attempts=0,forwarded=0;let current=()=>{throw Error('external fetch forbidden')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){const target=current;const wrapped=(...args)=>{if(++attempts>100)throw Error('mock ceiling');forwarded++;return target(...args)};wrapped.__sRaw=target;return wrapped},set(value){current=value.__sRaw??value}});for(const m of ['node:net','node:tls','node:http','node:https'])for(const k of ['connect','createConnection','request','get'])if(typeof require(m)[k]==='function')require(m)[k]=()=>{throw Error('external socket forbidden')};process.on('exit',()=>console.log('S_VOLUME',JSON.stringify({runs:global.__sRuns,attempts,forwarded})));})();\n`;
const r=spawnSync(process.execPath,['--max-old-space-size=512','-'],{input:guard+readFileSync(out,'utf8'),cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:262144,killSignal:'SIGKILL'});
const result={file,oldSource:process.env.S_REVIEW_OLD??null,mode:process.env.S_REVIEW_GUARD ? 'causal-guard-only' : process.env.S_REVIEW_OLD ? 'old-module-overlay' : 'exact-head',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),stdout:r.stdout??'',stderr:r.stderr??'',status:r.status,signal:r.signal,error:r.error?.message??null};
const path=`proofs/s/3234/${file.split('/').at(-1)}.${process.env.S_REVIEW_GUARD ? 'causal-guard' : process.env.S_REVIEW_OLD ? 'old' : 'head'}.json`;
writeFileSync(path,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({path,status:r.status,signal:r.signal,summary:result.stdout.split('\n').filter(x=>/checks,|S_VOLUME|NEW_S_CURSOR/.test(x))}));process.exitCode=r.status??1;
