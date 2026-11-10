import {build} from 'esbuild';
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [rootArg,mode,...files]=process.argv.slice(2),root=resolve(rootArg),here=join(root,'tests');
const out=join(root,'.cx1-evidence');mkdirSync(out,{recursive:true});mkdirSync(join(out,'tmp'),{recursive:true});
const {testAliases,testEnvironment}=await import(pathToFileURL(join(here,'test-config.mjs')));
const old=process.env.CX1_OLD_REF;
const sourceFiles=(process.env.CX1_OLD_FILES||'').split(',').filter(Boolean);
mkdirSync(join(out,'before'),{recursive:true});
const ledger={};
for(const file of files){
 const bundle=join(out,file.replaceAll('/','_')+'.cjs');
 const sourceDir=process.env.CX1_SOURCE_DIR;
 const plugins=(true)?[{name:'prior-source',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$/},args=>{const path=relative(root,args.path).replaceAll('\\','/');if(path==='lib/redis-memory.ts'){let source=readFileSync(args.path,'utf8');const tag='  run(';const pos=source.indexOf(tag);if(pos<0)throw new Error('memory run hook missing');const body=source.indexOf('{',pos);source=source.slice(0,body+1)+" (globalThis as any).__cx1spend('redisCommands',1); "+source.slice(body+1);return{contents:source,loader:'ts'};}const overlay=sourceDir?join(root,sourceDir,path):null;if(overlay&&existsSync(overlay))return{contents:readFileSync(overlay,'utf8'),loader:path.endsWith('tsx')?'tsx':'ts'};if(sourceFiles.includes(path))return {contents:execFileSync('git',['show',`${old}:${path}`],{cwd:root,encoding:'utf8'}),loader:path.endsWith('tsx')?'tsx':'ts'};});}}]:[];
 await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,here),nodePaths:[resolve('node_modules')],plugins,
 banner:{js:`const __cx1deny=()=>{throw new Error('CX1 real network denied')};for(const n of ['node:http','node:https']){const m=require(n);m.request=__cx1deny;m.get=__cx1deny;}require('node:net').Socket.prototype.connect=__cx1deny;require('node:tls').connect=__cx1deny;globalThis.fetch=__cx1deny;const __cx1fs=require('node:fs');const __cx1spend=(kind,n)=>{const p=process.env.CX1_LEDGER,v=JSON.parse(__cx1fs.readFileSync(p,'utf8'));if(v[kind]+n>v[kind==='http'?'httpLimit':'redisLimit'])throw new Error('CX1 aggregate '+kind+' cap');v[kind]+=n;__cx1fs.writeFileSync(p,JSON.stringify(v));};globalThis.__cx1spend=__cx1spend;const __cx1als=new(require('node:async_hooks').AsyncLocalStorage)();let __cx1fetch=__cx1deny;Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return __cx1fetch},set(fn){__cx1fetch=(...args)=>{if(__cx1als.getStore())return fn(...args);__cx1spend('http',1);return __cx1als.run(true,()=>fn(...args));}}});`}});
 const env=testEnvironment({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:join(out,'tmp'),TMP:join(out,'tmp')});
 env.CX1_LEDGER=resolve('.git/cx1-3610-ledger.json');
 const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:process.env.CX1_DOC_ABSENT ? join(out,'before') : root,env,encoding:'utf8',timeout:120000,maxBuffer:262144});
 const log=(r.stdout||'')+(r.stderr||'');writeFileSync(join(out,mode+'-'+file.replaceAll('/','_')+'.log'),log);
 ledger[file]={status:r.status,signal:r.signal,error:r.error?.message,summary:log.split('\n').filter(l=>/checks|failing|passing|tests|fail|PASS|FAIL/.test(l)).slice(-6)};
 console.log(JSON.stringify({mode,file,...ledger[file]}));
}
writeFileSync(join(out,mode+'-summary.json'),JSON.stringify(ledger,null,2));
