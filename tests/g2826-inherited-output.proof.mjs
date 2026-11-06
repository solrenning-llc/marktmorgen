/** Real subprocesses; proves inherited output stays open after a timed-out worker's parent exits. No external IO. */
import{spawn}from'node:child_process';import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{pathToFileURL}from'node:url';import{setImmediate as nextTurn}from'node:timers/promises';
const root=mkdtempSync(join(tmpdir(),'g2826-output-')),pidfile=join(root,'descendant.pid');let executor,ownedPid,checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
let guard;
try{
 const grand=join(root,'grand.cjs'),worker=join(root,'worker.cjs'),driver=join(root,'driver.mjs');
 writeFileSync(grand,`require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);process.send('ready');`);
 writeFileSync(worker,`require('node:child_process').fork(${JSON.stringify(grand)},[],{stdio:['inherit','inherit','inherit','ipc']}).once('message',()=>console.log('DESCENDANT_READY'));`);
 writeFileSync(driver,`import{runBundle}from${JSON.stringify(pathToFileURL(resolve('tests/test-runner.mjs')).href)};const status=await runBundle(${JSON.stringify(worker)},process.env,process.execPath,{timeoutMs:1200,label:'worker.test.ts'});console.log('DRIVER_FINISHED',status);process.exit(status===1?0:2);`);
 executor=spawn(process.execPath,[driver],{stdio:['ignore','pipe','pipe']});let output='',closed=false;
 executor.stdout.on('data',d=>output+=d);executor.stderr.on('data',d=>output+=d);
 const closedPromise=new Promise(r=>executor.once('close',()=>{closed=true;r();}));
 const exit=await Promise.race([new Promise(r=>executor.once('exit',(code,signal)=>r({code,signal}))),new Promise(r=>{guard=setTimeout(()=>r('guard expired'),5000);})]);clearTimeout(guard);
 is('outer executor itself finished normally after counting timeout',exit,{code:0,signal:null});
 ownedPid=Number(readFileSync(pidfile,'utf8'));await nextTurn();
 console.log('G_OUTPUT_BEFORE_CLEANUP',JSON.stringify({exit,descendantAlive:alive(ownedPid),closed,output}));
 is('no descendant survives when the executor has finished',alive(ownedPid),false);
 is('the finished executor releases its inherited stdout/stderr',closed,true);
 process.kill(ownedPid,'SIGKILL');
 await Promise.race([closedPromise,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('output did not close after own cleanup')),3000);})]);clearTimeout(guard);
 is('killing the recorded synthetic descendant releases close',closed,true);
}finally{
 clearTimeout(guard);if(ownedPid&&alive(ownedPid)){try{process.kill(ownedPid,'SIGKILL');}catch{/* already gone */}}
 if(executor&&executor.exitCode===null){try{executor.kill('SIGKILL');}catch{/* already gone */}}
 rmSync(root,{recursive:true,force:true});
}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
