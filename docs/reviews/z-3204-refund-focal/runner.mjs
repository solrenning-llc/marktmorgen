import {build} from 'esbuild';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../../../tests/test-config.mjs';
const root=process.cwd(),old=process.env.Z_OLD,dir=mkdtempSync('/tmp/z3204-'),part=process.env.Z_LINKED_PART;
if(part!==undefined&&!['0','1'].includes(part))throw Error('Invalid linked partition');
const before=new Set(['lib/affiliates.ts']);
let failures=0;
for(const file of process.argv.slice(2)){
 const out=join(dir,file+'.cjs');
 await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error',alias:testAliases(file,root,join(root,'tests')),plugins:[{name:'bounded-focal',setup(b){b.onLoad({filter:/\.[jt]sx?$/},a=>{
  const rel=relative(root,a.path);let s=old&&before.has(rel)?execFileSync('git',['show',old+':'+rel],{encoding:'utf8'}):readFileSync(a.path,'utf8');
  if(part!==undefined&&rel==='tests/paypal-payouts-unknown.test.ts'){
   const needle='["garbled", "empty", "no-id", "dropped", "server"] as const';
   if(s.split(needle).length!==2)throw Error('Unknown-case partition anchor changed');
   s=s.replace(needle,'('+needle+').filter((_value, index) => index % 2 === '+part+')');
   writeFileSync(join(dir,'unknown-part-'+part+'.ts'),s);
  }
  if(part!==undefined&&rel==='tests/paypal-payouts-reconcile.test.ts'){
   const start=s.indexOf('  part("The answer was lost after PayPal made the batch:');
   const cut=s.indexOf('  part("The settling gets the batch back and writing its id fails:');
   const end=s.lastIndexOf('  done();');
   if(!(start>0&&cut>start&&end>cut))throw Error('Reconcile partition anchors changed');
   // The first group keeps the day/seven-day dependent steps together. The
   // second starts at a self-seeded scenario and retains month-count controls.
   s=s.slice(0,start)+(part==='0'?s.slice(start,cut):s.slice(cut,end))+s.slice(end);
   writeFileSync(join(dir,'reconcile-part-'+part+'.ts'),s);
  }
  if(rel==='lib/redis-memory.ts'){const needle='run(command: (string | number)[]): unknown {';if(!s.includes(needle))throw Error('missing budget anchor');s=s.replace(needle,needle+' (globalThis as any).__zRun();');}
  return {contents:s,loader:a.path.endsWith('tsx')?'tsx':a.path.endsWith('jsx')?'jsx':a.path.endsWith('js')?'js':'ts',resolveDir:dirname(a.path)};
 });}}]});
 const guard=`let runs=0,mocks=0,over=false;global.__zRun=()=>{if(++runs>20000){over=true;throw Error('Redis command ceiling before dispatch')}};let current=()=>{throw Error('external fetch denied')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){const target=current;const f=(...args)=>{if(++mocks>100){over=true;throw Error('mock HTTP ceiling before dispatch')}return target(...args)};f.__zRaw=target;return f},set(v){current=v.__zRaw??v}});require('node:net').Socket.prototype.connect=()=>{throw Error('external socket denied before graph')};process.on('exit',()=>{console.log('Z_VOLUME',JSON.stringify({runs,mocks,over}));if(over)process.exitCode=1});\n`;
 const r=spawnSync(process.execPath,['--max-old-space-size=512','-'],{input:'{'+guard+'}\n'+readFileSync(out,'utf8'),cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:262144,killSignal:'SIGKILL'});
 const text=(r.stdout??'')+(r.stderr??'');writeFileSync(join(dir,file+'.log'),text);process.stdout.write('\nFILE '+file+'\n'+text+'\nZ_STATUS '+r.status+' '+r.signal+' '+(r.error?.message??'')+'\n');if(r.status!==0||r.error)failures++;
}
console.log('Z_LOG_DIR',dir);process.exitCode=failures?1:0;
