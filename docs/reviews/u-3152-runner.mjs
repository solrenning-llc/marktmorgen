import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join,relative} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const [root,mode,...files]=process.argv.slice(2);
const req=createRequire(join(root,'package.json'));
const {build}=req('esbuild');
const {testAliases,testEnvironment}=await import(pathToFileURL(join(root,'tests/test-config.mjs')));

const banner=`require('node:net').Socket.prototype.connect=function(){throw new Error('external sockets denied')};let http=0;let fetchImpl=async()=>{throw new Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return (...args)=>{if(http>=100)throw new Error('HTTP budget before dispatch');http++;return fetchImpl(...args)}},set(fn){fetchImpl=fn}});process.once('exit',()=>console.log('ADMITTED synthetic HTTP:',http,'/100'));`;
for(const file of files){
 const out='/tmp/u-3152-'+mode+'-'+file+'.cjs';
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),banner:{js:banner},plugins:[{name:'bounded-review',setup(b){b.onLoad({filter:/\.(?:ts|tsx|js|mjs|cjs)$/},args=>{
 const f=relative(root,args.path);let text;
 if(mode==='coverage-gap'&&['components/block-rewrite.tsx','components/page-coach.tsx','components/translate-page.tsx'].includes(f)){text=execFileSync('git',['show','8e2f71f695c1243e0a930feeefbf9542658fdd91:'+f],{cwd:root,encoding:'utf8'});}
 else if(file==='u-review-3152-remaining.test.ts'&&f==='components/page-coach.tsx'){text=readFileSync(args.path,'utf8'); const before='const [open, setOpen] = useState(false)'; if(!text.includes(before))throw Error('coach opening fixture site absent'); text=text.replace(before,'const [open, setOpen] = useState(true)');}
 else if(f==='lib/redis-memory.ts')text=readFileSync(args.path,'utf8');
 else return;
 if(f==='lib/redis-memory.ts')text+='\nlet uSyntheticRedisAdmissions=0;const uSyntheticRedisRun=MemoryRedis.prototype.run;MemoryRedis.prototype.run=function(cmd){if(uSyntheticRedisAdmissions>=20000)throw new Error("Redis budget before dispatch");uSyntheticRedisAdmissions++;return uSyntheticRedisRun.call(this,cmd)};process.once("exit",()=>console.log("ADMITTED synthetic Redis:",uSyntheticRedisAdmissions,"/20000"));';
 return {contents:text,loader:f.endsWith('.tsx')?'tsx':f.endsWith('.ts')?'ts':'js'};
 });}}]});
 const run=spawnSync(process.execPath,['--max-old-space-size=512',out],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024,encoding:'utf8'});
 writeFileSync('/tmp/u-3152-'+mode+'-'+file+'.log',(run.stdout||'')+(run.stderr||''));
 console.log(mode,file,'exit',run.status,(run.stdout||'').split('\n').filter(x=>/checks|ADMITTED|pass |fail |tests /.test(x)).join(' | '));
 if(run.error||(mode!=='red'&&run.status!==0))throw run.error||new Error('failed '+file);
}
