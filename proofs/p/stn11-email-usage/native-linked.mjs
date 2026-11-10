import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports, createRequire, isBuiltin } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { testAliases } from '../../../tests/test-config.mjs';
const root=process.cwd(), file=process.argv[2];
const cacheRequire=createRequire('/workspace/scratch/77662bfb9bc5/marktmorgen/package.json');
const aliases=testAliases(basename(file),root,resolve(root,'tests'));
const metrics={fetch:0,run:0,pipeline:0,network:0,sourceBytes:Number(process.env.P_STN_PRIOR_SOURCE_BYTES??0),capped:false};
globalThis.__P_STN_METRICS=metrics;
const cap=(key,n,max)=>{metrics[key]+=n;if(metrics[key]>max){metrics.capped=true;throw Error('P whole-graph ceiling '+key);}};
const deny=()=>{metrics.network++;throw Error('P real network denied');};
net.Socket.prototype.connect=deny;net.connect=deny;net.createConnection=deny;tls.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;syncBuiltinESMExports();
let mocked=deny;
Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return mocked;},set(fn){mocked=(...args)=>{cap('fetch',1,100);return fn(...args);};}});
process.on('exit',()=>{console.log('P_STN_METRICS',JSON.stringify(metrics));if(metrics.capped||metrics.network)process.exitCode=1;});
function located(path){for(const p of [path,path+'.ts',path+'.tsx',path+'.mjs',path+'.js',resolve(path,'index.ts')])if(existsSync(p)&&statSync(p).isFile())return p;throw Error('Unresolved local path '+path);}
registerHooks({
 resolve(spec,context,next){
  if(isBuiltin(spec))return next(spec,context);
  if(aliases[spec])return {url:pathToFileURL(located(aliases[spec])).href,shortCircuit:true};
  if(spec.startsWith('@/'))return {url:pathToFileURL(located(resolve(root,spec.slice(2)))).href,shortCircuit:true};
  if(spec.startsWith('.')&&context.parentURL?.includes('/node_modules/'))return next(spec,context);
  if(spec.startsWith('.')&&context.parentURL?.startsWith('file:'))return {url:pathToFileURL(located(resolve(dirname(fileURLToPath(context.parentURL)),spec))).href,shortCircuit:true};
  if(spec.startsWith('next'))throw Error('Exact locked Next 16.4.5 unavailable; no fallback');
  if(spec==='typescript')return {url:pathToFileURL('/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/typescript/lib/typescript.js').href,shortCircuit:true};
  if(spec==='react')return {url:pathToFileURL('/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/react/index.js').href,shortCircuit:true};
  if(!spec.startsWith('node:')){try{return {url:pathToFileURL(cacheRequire.resolve(spec)).href,shortCircuit:true};}catch{}}
  return next(spec,context);
 },
 load(url,context,next){
  if(!url.endsWith('.ts'))return next(url,context);
  const path=fileURLToPath(url);cap('sourceBytes',statSync(path).size,16777216);let source=readFileSync(path,'utf8');
  if(path===resolve(root,'lib/redis-memory.ts'))source+=`\nconst __pRun=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(...a){const m=globalThis.__P_STN_METRICS;if(++m.run>20000){m.capped=true;throw Error('P nested Redis ceiling');}return __pRun.apply(this,a);};const __pPipe=MemoryRedis.prototype.pipeline;MemoryRedis.prototype.pipeline=function(c){const m=globalThis.__P_STN_METRICS;m.pipeline+=c.length;if(m.pipeline>20000){m.capped=true;throw Error('P pipeline ceiling');}return __pPipe.call(this,c);};`;
  return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceMap:false}),shortCircuit:true};
 }
});
await import(pathToFileURL(resolve(root,file)).href);
