import {build,stop} from 'esbuild';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {join} from 'node:path';
const root=process.cwd(),temp=mkdtempSync('/dev/shm/g2894-controls-');let checks=0;
try{
 const scenarios=[
  ['pass',"is('known',1,1);done();",0],
  ['failure',"is('known failure',1,2);done();",1],
  ['open-handle-pass',"setInterval(()=>{},100);is('known',1,1);done();",0],
  ['open-handle-failure',"setInterval(()=>{},100);is('known failure',1,2);done();",1],
  ['late-throw',"setTimeout(()=>{throw Error('synthetic later exception')},20);is('known',1,1);done();",1],
 ];
 for(const [name,body,expected] of scenarios){
  const out=join(temp,name+'.cjs');
  await build({stdin:{contents:"import {is,done} from './tests/check.ts';"+body,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'error'});
  const start=Date.now(),r=spawnSync(process.execPath,[out],{encoding:'utf8',timeout:7000});
  assert.equal(r.status,expected,name);checks++;assert.equal(r.signal,null,name+' no signal');checks++;
  assert.match(r.stdout,expected===1&&name!=='late-throw'?/1 checks, 1 failing\./:/1 checks, all passing\./);checks++;
  if(name.startsWith('open-handle')){assert.ok(Date.now()-start>=1800,name+' uses delayed fallback');checks++;}
  console.log(name,'exit',r.status,'elapsed',Date.now()-start,'ms');
 }
 const run=readFileSync('tests/run.mjs','utf8'),tail=run.slice(run.indexOf('failed += clientBundles.failed;'));
 for(const failed of [0,1]){
  const out=join(temp,'runner-'+failed+'.cjs');writeFileSync(out,'let failed='+failed+'; const clientBundles={failed:0};\n'+tail);
  const r=spawnSync(process.execPath,[out],{encoding:'utf8',timeout:7000});assert.equal(r.status,failed);checks++;assert.equal(r.signal,null);checks++;
  assert.match(r.stdout,failed?/1 test file\(s\) failed\./:/Everything passing\./);checks++;
 }
 console.log(checks+' independent checks, all passing; local child processes only.');
}finally{stop();rmSync(temp,{recursive:true,force:true});}
