/** G review-only actual Node process groups: normal finish, runner interruption and detached descendants. */
import{spawn}from'node:child_process';import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{pathToFileURL}from'node:url';
let checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
async function stillPresent(pid){const until=Date.now()+1500;while(alive(pid)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));return alive(pid);}
async function bounded(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('proof guard: '+label)),ms);})]);}finally{clearTimeout(timer);}}
for(const c of [{name:'ordinary normal completion',mode:'normal',detached:false},{name:'SIGINT stops runner',mode:'SIGINT',detached:false},{name:'SIGTERM stops runner',mode:'SIGTERM',detached:false},{name:'detached descendant timeout',mode:'timeout',detached:true},{name:'detached descendant normal completion',mode:'normal',detached:true}]){
 const dir=mkdtempSync(join(tmpdir(),'g2826-life-')),gpfile=join(dir,'grand.pid'),ppfile=join(dir,'worker.pid');let driver,owned=[],output='';
 try{
  const grand=join(dir,'grand.cjs'),worker=join(dir,'worker.cjs'),entry=join(dir,'driver.mjs');
  writeFileSync(grand,`require('node:fs').writeFileSync(${JSON.stringify(gpfile)},String(process.pid));setInterval(()=>{},1000);process.send('ready');`);
  writeFileSync(worker,`require('node:fs').writeFileSync(${JSON.stringify(ppfile)},String(process.pid));require('node:child_process').fork(${JSON.stringify(grand)},[],{stdio:['inherit','inherit','inherit','ipc'],detached:${c.detached}}).once('message',()=>{console.log('G_LIFECYCLE_READY');${c.mode==='normal'?'process.exit(0);':''}});setInterval(()=>{},1000);`);
  const timeout=c.mode==='timeout'?1200:60_000;
  writeFileSync(entry,`import{runBundle}from${JSON.stringify(pathToFileURL(resolve('tests/test-runner.mjs')).href)};const result=await runBundle(${JSON.stringify(worker)},process.env,process.execPath,{timeoutMs:${timeout},label:'lifecycle.test.ts'});console.log('G_LIFECYCLE_RESULT',result);process.exit(result===${c.mode==='timeout'?1:0}?0:9);`);
  driver=spawn(process.execPath,[entry],{stdio:['ignore','pipe','pipe']});let markReady,closed=false;
  const ready=new Promise(r=>markReady=r),closedPromise=new Promise(r=>driver.once('close',()=>{closed=true;r('closed');})),exitPromise=new Promise(r=>driver.once('exit',(code,signal)=>r({code,signal})));
  driver.stdout.on('data',b=>{output+=b;if(output.includes('G_LIFECYCLE_READY'))markReady();});driver.stderr.on('data',b=>output+=b);
  await bounded(ready,5000,'worker ready');owned=[Number(readFileSync(ppfile,'utf8')),Number(readFileSync(gpfile,'utf8'))];
  if(c.mode==='SIGINT'||c.mode==='SIGTERM')driver.kill(c.mode);
  const exit=await bounded(exitPromise,8000,'driver exit');
  if(c.mode==='normal'||c.mode==='timeout')is(c.name+': executor status preserved',exit,{code:0,signal:null});else is(c.name+': interrupt preserved',exit.signal,c.mode);
  let release='open';try{release=await bounded(closedPromise,1000,'inherited streams close');}catch(e){if(!String(e.message).includes('proof guard: inherited streams close'))throw e;}
  const descendantAlive=await stillPresent(owned[1]);
  console.log('G_LIFECYCLE_STATE',JSON.stringify({name:c.name,exit,closed,descendantAlive,output}));
  is(c.name+': output released after executor exit',release,'closed');
  is(c.name+': no executing descendant remains',descendantAlive,false);
 }finally{
  // Only fixture PIDs read from our own files, never groups that could contain the reviewer.
  for(const f of [ppfile,gpfile]){try{const pid=Number(readFileSync(f,'utf8'));if(!owned.includes(pid))owned.push(pid);}catch{/* absent */}}
  for(const pid of owned){try{process.kill(pid,'SIGKILL');}catch{/* already gone */}}
  for(const pid of owned)await stillPresent(pid);
  console.log('G_LIFECYCLE_CLEANUP',JSON.stringify({name:c.name,owned:owned.map(pid=>({pid,present:alive(pid)}))}));
  if(driver&&driver.exitCode===null&&driver.signalCode===null){try{driver.kill('SIGKILL');}catch{/* already gone */}}
  rmSync(dir,{recursive:true,force:true});
 }
}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
