import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=resolve('.'),out=mkdtempSync(join(tmpdir(),'j2934-')),guard=join(out,'guard.cjs');
writeFileSync(guard,"const a=require('node:assert/strict');const no=()=>{throw Error('J2934 network blocked')};globalThis.fetch=no;require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;a.throws(()=>globalThis.fetch('https://example.invalid'),/network blocked/);console.log('NETWORK CONTROL PASS before graph');");
for(const file of process.argv.length>2?process.argv.slice(2):['sz2-physical-legal.test.ts','j-2934-physical-legal.proof.ts']){
 const bundle=join(out,file+'.cjs');await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
 const r=spawnSync(process.execPath,['--require',guard,bundle],{cwd:root,env:testEnvironment(process.env),encoding:'utf8',timeout:120000,maxBuffer:256*1024});
 console.log('FILE',file,'STATUS',r.status);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;if(r.status!==0)process.exitCode=1;
}
