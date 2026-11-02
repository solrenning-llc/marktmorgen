import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough,Writable} from "node:stream";
import {startWindowsForegroundProbe} from "./windows-foreground.mjs";

const env={GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:"viniciussucupira/marktmorgen",AX2_PUBLIC_DISPOSABLE_RUNNER:"true"};
function fixture({handshake=true,exitOnEnd=true}={}){
 const child=new EventEmitter(),requests=[],launches=[];
 child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.stdin=new Writable({write(chunk,_encoding,done){requests.push(String(chunk).trim());done();},final(done){if(exitOnEnd)queueMicrotask(()=>child.emit("exit",0));done();}});
 child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit("exit",1));return true;};
 const launch=(...args)=>{launches.push(args);if(handshake)queueMicrotask(()=>child.stdout.write('{"ready":true}\n'));return child;};
 return {child,requests,launches,options:{env,platform:"win32",launch,timeoutMs:100},reply:(id,title)=>child.stdout.write(JSON.stringify({id,title})+"\n")};
}
test("one hidden owned process reads correlated titles without keystrokes",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe(f.options);
 const one=probe.read(),two=probe.read();
 assert.deepEqual(f.requests,["0","1"]);f.reply("1","Search");f.reply("0","Synthetic — Chromium");
 assert.equal(await one,"Synthetic — Chromium");assert.equal(await two,"Search");
 assert.equal(f.launches.length,1);assert.equal(f.launches[0][0],"powershell.exe");
 assert.equal(f.launches[0][2].windowsHide,true);
 const script=Buffer.from(f.launches[0][1].at(-1),"base64").toString("utf16le");
 assert.ok(script.includes("GetForegroundWindow"));assert.ok(script.includes("GetWindowText"));
 assert.ok(!/SendKeys|SetForegroundWindow|AppActivate|keybd_event/.test(script));
 await probe.close();await assert.rejects(probe.read());
});
test("unknown or malformed correlation refuses every pending title",async()=>{
 for(const raw of ['{"id":"foreign","title":"Search"}', '{"id":"0","title":null}', 'not JSON']){
  const f=fixture(),probe=await startWindowsForegroundProbe(f.options),read=probe.read();
  f.child.stdout.write(raw+"\n");await assert.rejects(read);await assert.rejects(probe.read());await probe.close();
 }
});
test("query deadline is unknown and a late reply cannot authorize another query",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe({...f.options,timeoutMs:5});
 await assert.rejects(probe.read(),/deadline/);f.reply("0","Late title");
 await assert.rejects(probe.read(),/deadline/);await probe.close();
});
test("startup deadline closes its observer and an exited child refuses pending reads",async()=>{
 const missing=fixture({handshake:false});await assert.rejects(startWindowsForegroundProbe({...missing.options,timeoutMs:5}),/deadline/);
 assert.equal(missing.child.stdin.writableEnded,true);
 const f=fixture(),probe=await startWindowsForegroundProbe(f.options),read=probe.read();
 f.child.emit("exit",1);await assert.rejects(read,/exited/);await probe.close();
});
test("foreign and non-Windows environments never launch a process",async()=>{
 for(const options of [{platform:"linux",env},{platform:"win32",env:{}},{platform:"win32",env:{...env,GITHUB_REPOSITORY:"foreign/repo"}}]){
  let launches=0;await assert.rejects(startWindowsForegroundProbe({...options,launch(){launches++;}}));assert.equal(launches,0);
 }
});
test("an observer that ignores EOF is terminated only through its owned child handle",async()=>{
 const f=fixture({exitOnEnd:false}),probe=await startWindowsForegroundProbe(f.options);
 await probe.close();assert.equal(f.child.killed,true);assert.equal(f.launches.length,1);
});
test("process errors refuse pending snapshots and retain their cause",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe(f.options),read=probe.read();
 f.child.emit("error",Error("synthetic process fault"));await assert.rejects(read,/process failed/);
 await assert.rejects(probe.read(),/process failed/);await probe.close();
});

test("startup milestones are distinct from native window snapshots",async()=>{
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:event=>events.push(event)});
 f.child.stdout.write('{"stage":"powershell_started"}\n');
 f.child.stdout.write('{"stage":"interop_ready"}\n');
 f.child.stdout.write('{"ready":true}\n');
 const probe=await starting;
 assert.deepEqual(events.filter(e=>e.event==="startup_stage").map(e=>e.stage),["powershell_started","interop_ready"]);
 assert.equal(events.find(e=>e.event==="ready")?.readySeen,true);
 assert.ok(events.every(e=>Number.isInteger(e.elapsedMs)&&e.elapsedMs>=0&&e.elapsedMs<=60000));
 assert.ok(events.every(e=>!Object.hasOwn(e,"title")),"Readiness is not a native snapshot");
 await probe.close();
});
test("deadline identifies last startup stage and bounded stderr without exposing content",async()=>{
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,timeoutMs:5,onDiagnostic:event=>events.push(event)});
 f.child.stdout.write('{"stage":"powershell_started"}\n');
 f.child.stderr.write('Add-Type CS1234 SECRET_DIAGNOSTIC_SENTINEL '+"x".repeat(100000));
 await assert.rejects(starting,/deadline/);
 const failure=events.find(e=>e.event==="failed");
 assert.equal(failure?.reason,"deadline");
 assert.equal(failure?.stage,"powershell_started");
 assert.equal(failure?.readySeen,false);
 assert.equal(failure?.stderrBytes,65536);
 assert.equal(failure?.stderrBytesCapped,true);
 assert.ok(failure?.stderrCategories.includes("interop_compile"));
 assert.ok(!JSON.stringify(events).includes("SECRET_DIAGNOSTIC_SENTINEL"));
 assert.ok(!JSON.stringify(events).includes("CS1234"));
 assert.equal(f.child.stdin.writableEnded,true);
});
test("pre-ready process exit retains only allowlisted code and signal",async()=>{
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:event=>events.push(event)});
 f.child.emit("exit",23,"SIGKILL");
 await assert.rejects(starting,/exited/);
 const exit=events.find(e=>e.event==="exit");
 assert.equal(exit?.exitCode,23);assert.equal(exit?.exitSignal,"SIGKILL");
 assert.equal(exit?.readySeen,false);
 assert.equal(events.find(e=>e.event==="failed")?.reason,"process_exit");
});
test("unterminated oversized stdout fails its bounded parser without leaking bytes",async()=>{
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:event=>events.push(event)});
 f.child.stdout.write('SECRET_STDOUT_SENTINEL'+"x".repeat(100000));
 await assert.rejects(starting,/reply budget/);
 assert.equal(events.find(e=>e.event==="failed")?.reason,"stdout_budget");
 assert.ok(!JSON.stringify(events).includes("SECRET_STDOUT_SENTINEL"));
});

test("UTF8 split chunks and CRLF preserve the exact observed title",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{}});
 const answer=probe.read(),title="Janela — 漢字 😀";
 const bytes=Buffer.from(JSON.stringify({id:"0",title})+"\r\n");
 for(const byte of bytes)f.child.stdout.write(Buffer.from([byte]));
 assert.equal(await answer,title);await probe.close();
});
test("4096bytes are accepted and4097bytes fail before frame allocation",async()=>{
 const f=fixture(),events=[],probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
 let title="\0".repeat(670);
 title+="a".repeat(4096-Buffer.byteLength(JSON.stringify({id:"0",title})));
 const exact=JSON.stringify({id:"0",title});assert.equal(Buffer.byteLength(exact),4096);
 const answer=probe.read();f.child.stdout.write(exact+"\n");assert.equal(await answer,title);
 const oversized=probe.read();f.child.stdout.write(JSON.stringify({id:"1",title:title+"a"})+"\n");
 await assert.rejects(oversized,/reply budget/);
 assert.equal(events.find(e=>e.event==="failed")?.reason,"stdout_budget");await probe.close();
});
test("metadata cap never limits native queries or the optional ninth observation",async()=>{
 const f=fixture(),events=[],probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
 for(let n=0;n<20;n++){
  const answer=probe.read();f.reply(String(n),"Window "+n);assert.equal(await answer,"Window "+n);
 }
 assert.equal(f.requests.length,20);await probe.close();assert.ok(events.length<=12);
});
test("multiple correlated frames in one chunk preserve out of order replies",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{}});
 const one=probe.read(),two=probe.read();
 f.child.stdout.write('{"id":"1","title":"Two"}\n{"id":"0","title":"One"}\n');
 assert.equal(await one,"One");assert.equal(await two,"Two");await probe.close();
});
test("duplicate or out of order readiness never renews or authorizes a query",async()=>{
 for(const frame of ['{"ready":true}', '{"stage":"interop_ready"}']){
  const f=fixture({handshake:false}),events=[];
  const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
  if(frame==='{"ready":true}'){f.child.stdout.write(frame+"\n");const probe=await starting;
   f.child.stdout.write(frame+"\n");await assert.rejects(probe.read(),/Uncorrelated/);await probe.close();
  }else{f.child.stdout.write(frame+"\n");await assert.rejects(starting,/milestone/);}
  assert.equal(events.find(e=>e.event==="failed")?.reason,"reply_protocol");
 }
});
test("malformed stdout and unknown exit signals cannot leak arbitrary values",async()=>{
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
 f.child.stdout.write('SECRET_STDOUT_SENTINEL not JSON\n');
 await assert.rejects(starting,error=>error.message==="Malformed native foreground reply");
 f.child.emit("exit",NaN,"SECRET_SIGNAL_SENTINEL");
 const exit=events.find(e=>e.event==="exit"&&e.exitSignal==="UNKNOWN");assert.ok(exit);
 assert.equal(exit.exitCode,null);assert.ok(!JSON.stringify(events).includes("SENTINEL"));
});
test("diagnostic sink failure cannot replace a valid native reply",async()=>{
 const f=fixture(),probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{throw Error("sink unavailable");}});
 const answer=probe.read();f.reply("0","Observed title");assert.equal(await answer,"Observed title");await probe.close();
});

test("inherited readiness is never a process handshake",async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,"ready");
 Object.defineProperty(Object.prototype,"ready",{value:true,configurable:true,writable:true});
 const f=fixture({handshake:false});let probe;
 try{
  const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{}});
  starting.then(value=>{probe=value;},()=>{});
  f.child.stdout.write('{"unrelated":true}\n');await assert.rejects(starting,/Malformed/);
 }finally{if(descriptor)Object.defineProperty(Object.prototype,"ready",descriptor);else delete Object.prototype.ready;await probe?.close();}
});
test("inherited id and title cannot authorize a correlated snapshot",async()=>{
 const descriptors=["id","title"].map(key=>[key,Object.getOwnPropertyDescriptor(Object.prototype,key)]);
 Object.defineProperty(Object.prototype,"id",{value:"0",configurable:true,writable:true});
 Object.defineProperty(Object.prototype,"title",{value:"FORGED_INHERITED_TITLE",configurable:true,writable:true});
 const f=fixture();let probe;
 try{
  probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{}});
  const answer=probe.read();f.child.stdout.write('{"first":1,"second":2}\n');await assert.rejects(answer,/Malformed/);
 }finally{
  for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(Object.prototype,key,descriptor);else delete Object.prototype[key];}
  await probe?.close();
 }
});

test("a reply id called ready cannot impersonate the handshake",async()=>{
 const f=fixture({handshake:false});let probe;
 try{
  const starting=startWindowsForegroundProbe({...f.options,onDiagnostic:()=>{}});
  starting.then(value=>{probe=value;},()=>{});
  f.child.stdout.write('{"id":"ready","title":"NOT_A_HANDSHAKE"}\n');
  await assert.rejects(starting,/Malformed/);
 }finally{await probe?.close();}
});

test("default startup can pass the query budget while each query remains three seconds",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture({handshake:false}),events=[],options={...f.options};delete options.timeoutMs;
 let probe;
 const starting=startWindowsForegroundProbe({...options,onDiagnostic:e=>events.push(e)});
 starting.catch(()=>{});
 try{
  t.mock.timers.tick(2775);f.child.stdout.write('{"stage":"powershell_started"}\n');
  t.mock.timers.tick(725);f.child.stdout.write('{"stage":"interop_ready"}\n{"ready":true}\n');
  probe=await starting;
  assert.equal(events.find(e=>e.event==="ready")?.startupBudgetMs,10000);
  assert.equal(events.find(e=>e.event==="ready")?.queryBudgetMs,3000);
  assert.equal(f.launches.length,1);
  const answer=probe.read(),rejected=assert.rejects(answer,/query.*deadline/);
  t.mock.timers.tick(2999);assert.ok(!events.some(e=>e.reason==="query_deadline"));
  t.mock.timers.tick(1);await rejected;
  assert.equal(events.find(e=>e.event==="failed")?.reason,"query_deadline");
 }finally{await probe?.close();}
});
test("a hung default startup expires at ten seconds and still owns bounded cleanup",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture({handshake:false,exitOnEnd:false}),events=[],options={...f.options};delete options.timeoutMs;
 const starting=startWindowsForegroundProbe({...options,onDiagnostic:e=>events.push(e)});
 const rejected=assert.rejects(starting,/startup.*deadline/);
 try{
  t.mock.timers.tick(9999);assert.ok(!events.some(e=>e.event==="failed"));
  t.mock.timers.tick(1);await Promise.resolve();
  assert.equal(events.find(e=>e.event==="failed")?.reason,"startup_deadline");
  assert.equal(f.child.stdin.writableEnded,true);
  t.mock.timers.tick(249);assert.ok(!f.child.killed);
  t.mock.timers.tick(1);await rejected;assert.equal(f.child.killed,true);
 }finally{f.child.emit("exit",0);await starting.catch(()=>{});}
});
test("the existing explicit timeout override remains usable by both mock phases",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture({handshake:false}),events=[];
 const starting=startWindowsForegroundProbe({...f.options,timeoutMs:25,onDiagnostic:e=>events.push(e)});
 const rejected=assert.rejects(starting,/startup.*deadline/);
 t.mock.timers.tick(24);assert.ok(!events.some(e=>e.event==="failed"));
 t.mock.timers.tick(1);await rejected;
 assert.equal(events.find(e=>e.event==="launch")?.startupBudgetMs,25);
 assert.equal(events.find(e=>e.event==="launch")?.queryBudgetMs,25);
});
test("invalid or excessive timeout budgets refuse before launching any process",async()=>{
 for(const budget of [
  {timeoutMs:0},{timeoutMs:-1},{timeoutMs:1.5},{timeoutMs:NaN},{timeoutMs:Infinity},{timeoutMs:3001},{timeoutMs:"3000"},{timeoutMs:null},
  {startupTimeoutMs:0},{startupTimeoutMs:-1},{startupTimeoutMs:1.5},{startupTimeoutMs:NaN},{startupTimeoutMs:Infinity},{startupTimeoutMs:10001},{startupTimeoutMs:"10000"},{startupTimeoutMs:null},
 ]){
  const f=fixture();await assert.rejects(startWindowsForegroundProbe({...f.options,...budget,onDiagnostic:()=>{}}),/Invalid native foreground timeout budget/);
  assert.equal(f.launches.length,0);
 }
});
test("nonfinite diagnostic clocks are unknown while finite query timers still expire",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const now=t.mock.method(performance,"now",()=>NaN),f=fixture(),events=[];let probe;
 try{
  probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
  const accepted=probe.read();f.reply("0","Window");assert.equal(await accepted,"Window");
  const answer=probe.read(),rejected=assert.rejects(answer,/query.*deadline/);
  t.mock.timers.tick(100);await rejected;
  assert.ok(events.every(e=>e.elapsedUnknown===true&&e.elapsedMs===null));
 }finally{await probe?.close();now.mock.restore();}
});
test("a regressing diagnostic clock is not reported as elapsed zero",async t=>{
 let value=100;const now=t.mock.method(performance,"now",()=>value),f=fixture(),events=[];let probe;
 try{
  probe=await startWindowsForegroundProbe({...f.options,onDiagnostic:e=>events.push(e)});
  value=99;await probe.close();
  const closing=events.find(e=>e.event==="closing");assert.equal(closing?.elapsedMs,null);assert.equal(closing?.elapsedUnknown,true);
 }finally{await probe?.close();now.mock.restore();}
});
