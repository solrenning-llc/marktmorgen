import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const here=join(root,'tests');
const out=mkdtempSync(join(tmpdir(),'j-3035-'));
const guard=join(out,'no-network.cjs');
writeFileSync(guard,`const net=require('node:net'),tls=require('node:tls');
let attempts=0;const no=()=>{attempts++;throw new Error('J3035: external transport forbidden');};
net.Socket.prototype.connect=no;net.connect=no;net.createConnection=no;tls.connect=no;global.fetch=no;
try{global.fetch('https://negative-control.invalid')}catch{};if(attempts!==1)throw Error('Missing network negative control');attempts=0;
process.on('exit',()=>{if(attempts){console.error('J3035 unexpected network attempts',attempts);process.exitCode=1;}});
console.log('J3035 network guard active; negative control passed');`);
let failed=0;
try{
 for(const file of process.argv.slice(2)){
  if(!/^[a-z0-9.-]+\.(test|proof)\.ts$/.test(file))throw Error('Expected a test/proof filename');
  const bundle=join(out,file+'.cjs');
  await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,here)});
  const result=spawnSync(process.execPath,['--require',guard,bundle],{cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:262144});
  console.log('FILE',file);process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  console.log('EXIT',result.status,'SIGNAL',result.signal||'none','ERROR',result.error?.message||'none');
  if(result.status!==0||result.error)failed++;
 }
}finally{rmSync(out,{recursive:true,force:true});}
process.exitCode=failed?1:0;
