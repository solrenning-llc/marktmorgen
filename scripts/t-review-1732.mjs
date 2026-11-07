// Codex T focal replay. Product/test files remain unchanged.
import {build} from 'esbuild';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=process.cwd(),here=join(root,'tests'),mode=process.argv[2]??'head';
if(!['head','red'].includes(mode))throw Error('Expected head or red');
if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='cd9ccd48799057b4937c154a0f2d224fdd05ab84')throw Error('Copy this runner to the exact reviewed head first');
const files=process.argv.slice(3);
if(!files.length)files.push('stock-recount-stripe-wait.test.ts');
const out=mkdtempSync(join(tmpdir(),'t1732-'));
const old=execFileSync('git',['show','796026ca:lib/stock.ts'],{encoding:'utf8'});
const banner=`globalThis.__tRedis=0;globalThis.__tHttp=0;let mock=async()=>{throw Error('No live network allowed')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...a)=>{if(++globalThis.__tHttp>100)throw Error('HTTP mock budget');return mock(...a)}},set(v){mock=v}});for(const m of ['node:http','node:https']){const a=require(m);a.request=a.get=()=>{throw Error('No live network allowed')}}process.on('exit',()=>console.log('T_BUDGET '+JSON.stringify({redis:globalThis.__tRedis,httpMock:globalThis.__tHttp})));`;
let failed=0;
try{
 for(const file of files){
  const bundle=join(out,file+'.cjs');
  const result=await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',metafile:true,alias:testAliases(file,root,here),banner:{js:banner},plugins:[{name:'bounded-focal',setup(b){
   b.onLoad({filter:/\/lib\/redis-memory\.ts$/},args=>{const s=readFileSync(args.path,'utf8');const needle='run(command: (string | number)[]): unknown {';if(!s.includes(needle))throw Error('Observer point missing');return {contents:s.replace(needle,needle+' if(++(globalThis as any).__tRedis>20000)throw Error("Redis budget");'),loader:'ts'};});
   if(mode==='red')b.onLoad({filter:/\/lib\/stock\.ts$/},()=>({contents:old,loader:'ts'}));
  }}]});
  if(Object.keys(result.metafile.inputs).some(p=>p.endsWith('lib/redis.ts')))throw Error('Live Redis graph');
  const p=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:262144});
  const output=(p.stdout??'')+(p.stderr??'');
  writeFileSync(join(root,`t-1732-${mode}-${file}.log`),output);
  console.log(JSON.stringify({file,mode,exit:p.status,signal:p.signal,error:p.error?.message,summary:output.match(/\d+\/\d+[^\n]*/g),budget:output.match(/T_BUDGET .*/g)}));
  if(p.status!==0)failed++;
 }
}finally{rmSync(out,{recursive:true,force:true});}
process.exitCode=failed?1:0;
