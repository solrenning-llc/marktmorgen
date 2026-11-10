import {build} from 'esbuild';
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [rootArg,mode,...files]=process.argv.slice(2),root=resolve(rootArg),here=join(root,'tests');
const out=join(root,'.cx1-evidence');mkdirSync(out,{recursive:true});mkdirSync(join(out,'tmp'),{recursive:true});
const {testAliases,testEnvironment}=await import(pathToFileURL(join(here,'test-config.mjs')));
const old=process.env.CX1_OLD_REF;
const sourceFiles=(process.env.CX1_OLD_FILES||'').split(',').filter(Boolean);
const ledger={};
for(const file of files){
 const bundle=join(out,file.replaceAll('/','_')+'.cjs');
 const plugins=old?[{name:'prior-source',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$/},args=>{const path=relative(root,args.path).replaceAll('\\','/');if(sourceFiles.includes(path))return {contents:execFileSync('git',['show',`${old}:${path}`],{cwd:root,encoding:'utf8'}),loader:path.endsWith('tsx')?'tsx':'ts'};});}}]:[];
 await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,here),nodePaths:[resolve('node_modules')],plugins,
 banner:{js:`const __cx1deny=()=>{throw new Error('CX1 real network denied')};for(const n of ['node:http','node:https']){const m=require(n);m.request=__cx1deny;m.get=__cx1deny;}require('node:net').Socket.prototype.connect=__cx1deny;require('node:tls').connect=__cx1deny;globalThis.fetch=__cx1deny;`}});
 const env=testEnvironment({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:join(out,'tmp'),TMP:join(out,'tmp')});
 const r=spawnSync(process.execPath,['--max-old-space-size=512',bundle],{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:262144});
 const log=(r.stdout||'')+(r.stderr||'');writeFileSync(join(out,mode+'-'+file.replaceAll('/','_')+'.log'),log);
 ledger[file]={status:r.status,signal:r.signal,error:r.error?.message,summary:log.split('\n').filter(l=>/checks|failing|passing|tests|fail|PASS|FAIL/.test(l)).slice(-6)};
 console.log(JSON.stringify({mode,file,...ledger[file]}));
}
writeFileSync(join(out,mode+'-summary.json'),JSON.stringify(ledger,null,2));
