import {build} from 'esbuild';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../../../tests/test-config.mjs';
const root=process.cwd(),old=process.env.Z_OLD,dir=mkdtempSync('/tmp/z3321-');
const before=new Set(['lib/retained-revenue.ts','lib/share-settle.ts','lib/stats.ts']);
let failures=0;
for(const file of process.argv.slice(2)){
 const own=file.startsWith('z-3321-');const entry=own?join(root,'docs/reviews/z-3321-focal',file):join(root,'tests',file);const out=join(dir,file+'.cjs');
 await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(own?'prevented-dispute-siblings.test.ts':file,root,join(root,'tests')),plugins:[{name:'bounded-focal',setup(b){b.onLoad({filter:/\.[jt]sx?$/},a=>{
  const rel=relative(root,a.path);let s=old&&before.has(rel)?execFileSync('git',['show',old+':'+rel],{encoding:'utf8'}):readFileSync(a.path,'utf8');
  if(rel==='lib/redis-memory.ts'){const needle='run(command: (string | number)[]): unknown {';if(!s.includes(needle))throw Error('missing budget anchor');s=s.replace(needle,needle+' (globalThis as any).__zRun();');}
  return {contents:s,loader:a.path.endsWith('tsx')?'tsx':a.path.endsWith('jsx')?'jsx':a.path.endsWith('js')?'js':'ts',resolveDir:dirname(a.path)};
 });}}]});
 const guard=`let runs=0,mocks=0,over=false;global.__zRun=()=>{if(++runs>20000){over=true;throw Error('Redis command ceiling before dispatch')}};global.__zCounts=()=>({runs,mocks,over});let current=()=>{throw Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){const target=current;const f=(...args)=>{if(++mocks>100){over=true;throw Error('mock HTTP ceiling before dispatch')}return target(...args)};f.__zRaw=target;return f},set(v){current=v.__zRaw??v}});require('node:net').Socket.prototype.connect=()=>{throw Error('external socket denied before graph')};process.on('exit',()=>{console.log('Z_VOLUME',JSON.stringify({runs,mocks,over}));if(over)process.exitCode=1});\n`;
 const r=spawnSync(process.execPath,['--max-old-space-size=512','-'],{input:'{'+guard+'}\n'+readFileSync(out,'utf8'),cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:262144,killSignal:'SIGKILL'});
 const text=(r.stdout??'')+(r.stderr??'');writeFileSync(join(dir,file+'.log'),text);process.stdout.write('\nFILE '+file+'\n'+text+'\nZ_STATUS '+r.status+' '+r.signal+' '+(r.error?.message??'')+'\n');if(r.status!==0||r.error)failures++;
}
console.log('Z_LOG_DIR',dir);process.exitCode=failures?1:0;
