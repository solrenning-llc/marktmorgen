/** G independent synthetic local process proof; always kills only the recorded fixture processes in finally. */
import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{runBundle}from'./test-runner.mjs';
const dir=mkdtempSync(join(tmpdir(),'g2826-descendant-'));let checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
const state=pid=>{try{return readFileSync(`/proc/${pid}/status`,'utf8').match(/^State:\s*(.+)$/m)?.[1]??'unknown';}catch{return'proc=unreadable';}};
const running=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const owned=[];
try{
 const simple=join(dir,'simple.cjs'),simplePid=join(dir,'simple.pid');
 writeFileSync(simple,`require('node:fs').writeFileSync(${JSON.stringify(simplePid)},String(process.pid));setInterval(()=>{},1000);`);
 is('single stuck child returns failure',await runBundle(simple,process.env,process.execPath,{timeoutMs:1200,label:'single-stuck.test.ts'}),1);
 const sp=Number(readFileSync(simplePid,'utf8'));owned.push(sp);is('single stuck child is no longer running',running(sp),false);
 const child=join(dir,'grandchild.cjs'),parent=join(dir,'parent.cjs'),pidfile=join(dir,'grandchild.pid'),parentfile=join(dir,'parent.pid');
 writeFileSync(child,`require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);if(process.send)process.send('ready');`);
 writeFileSync(parent,`require('node:fs').writeFileSync(${JSON.stringify(parentfile)},String(process.pid));const c=require('node:child_process').fork(${JSON.stringify(child)},[],{stdio:['inherit','inherit','inherit','ipc']});c.once('message',()=>console.log('G_FIXTURE_DESCENDANT_READY'));`);
 const result=await runBundle(parent,process.env,process.execPath,{timeoutMs:1200,label:'descendant-stuck.test.ts',diagnose:()=>{throw Error('synthetic diagnostic failure');}});
 const pp=Number(readFileSync(parentfile,'utf8')),gp=Number(readFileSync(pidfile,'utf8'));owned.push(pp,gp);
 console.log('G_DESCENDANT_STATE',JSON.stringify({status:result,parent:state(pp),descendant:state(gp)}));
 is('timeout remains a failure if optional diagnose throws',result,1);
 is('the direct worker is no longer running',running(pp),false);
 is('no worker descendant survives the timed-out test',running(gp),false);
 const quick=join(dir,'quick.cjs');writeFileSync(quick,'process.exitCode=0;');
 is('a later healthy test still succeeds',await runBundle(quick,process.env,process.execPath,{timeoutMs:1200,label:'quick-control.test.ts'}),0);
}finally{
 for(const pid of owned){try{process.kill(pid,'SIGKILL');}catch{/* already gone */}}
 for(const pid of owned){const until=Date.now()+3000;while(running(pid)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));}
 console.log('G_OWN_FIXTURE_CLEANUP',JSON.stringify(owned.map(pid=>({pid,running:running(pid),state:state(pid)}))));
 rmSync(dir,{recursive:true,force:true});
}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
