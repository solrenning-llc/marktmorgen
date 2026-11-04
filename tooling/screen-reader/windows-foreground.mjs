import {ownedRepositoryEnv} from "./owned-repository.mjs";
import {spawn} from "node:child_process";

// One hidden process is prepared BEFORE Chromium. Queries read Win32 state;
// they never activate a window, send a key or start another process.
const SCRIPT=`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::WriteLine('{"stage":"powershell_started"}')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ForegroundSnapshot {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 public static string Read() { var s = new StringBuilder(1024); GetWindowText(GetForegroundWindow(), s, s.Capacity); return s.ToString(); }
}
'@
[Console]::WriteLine('{"stage":"interop_ready"}')
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
 if ($line -notmatch '^[0-9]+$') { throw 'Invalid diagnostic request' }
 $reply = @{id=$line;title=[ForegroundSnapshot]::Read()} | ConvertTo-Json -Compress
 [Console]::WriteLine($reply)
}
`;

export async function startWindowsForegroundProbe(options={}){
 // Real callers get separate finite budgets. A legacy explicit override
 // retains both phases for existing short-lived test fixtures.
 const {env=process.env,platform=process.platform,launch=spawn,timeoutMs=3000,
  startupTimeoutMs=options.timeoutMs===undefined?10000:timeoutMs,
  onDiagnostic=event=>console.error("AX2_NVDA_NATIVE_DIAGNOSTIC:"+JSON.stringify(event))}=options;
 if(platform!=="win32"||env.GITHUB_ACTIONS!=="true"||!ownedRepositoryEnv(env)||env.AX2_PUBLIC_DISPOSABLE_RUNNER!=="true")
  throw Error("Native foreground diagnostics require the owned disposable Windows runner");
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000||
    !Number.isSafeInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>10000)
  throw Error("Invalid native foreground timeout budget");
 let previousClock=null;
 function clockValue(){
  try{
   const value=performance.now();
   if(!Number.isFinite(value)||value<0||previousClock!==null&&value<previousClock)return null;
   previousClock=value;return value;
  }catch{return null;}
 }
 const started=clockValue();
 let stage="launching",readySeen=false,stderrBytes=0,stderrBytesCapped=false,exitCode=null,exitSignal=null,diagnosticCount=0;
 const stderrCategories=new Set();
 function diagnostic(event,reason){
  if(diagnosticCount>=12)return;diagnosticCount++;
  const now=clockValue(),delta=now===null||started===null||now<started?null:now-started;
  const elapsed=delta!==null&&Number.isFinite(delta)?Math.floor(delta):null;
  const entry={event,stage,elapsedMs:elapsed===null?null:Math.min(elapsed,60000),elapsedMsCapped:elapsed!==null&&elapsed>60000,
   elapsedUnknown:elapsed===null,startupBudgetMs:startupTimeoutMs,queryBudgetMs:timeoutMs,
   readySeen,stderrBytes,stderrBytesCapped,stderrCategories:[...stderrCategories].sort(),exitCode,exitSignal};
  if(reason)entry.reason=reason;
  // Never pass raw stdout/stderr, command arguments, environment or errors.
  try{onDiagnostic(entry);}catch{/* Diagnostics cannot replace the reader's primary failure. */}
 }
 diagnostic("launch");
 let child;
 try{child=launch("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(SCRIPT,"utf16le").toString("base64")],
  {windowsHide:true,stdio:["pipe","pipe","pipe"],env});}
 catch{diagnostic("failed","process_launch");throw Error("Native foreground process failed");}
 let next=0,ended=false,closed=false,failure=null;
 const pending=new Map();
 let buffered=Buffer.alloc(0),milestone=0;
 function fail(error,reason,report=true){
  if(!failure&&report)diagnostic("failed",reason);
  failure??=error;
  for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(failure);}
  pending.clear();
  buffered=Buffer.alloc(0);
 }
 function waiting(id){
  return new Promise((resolve,reject)=>{
   const startup=id==="ready",budget=startup?startupTimeoutMs:timeoutMs;
   const timer=setTimeout(()=>fail(Error("Native foreground "+(startup?"startup":"query")+" deadline exceeded"),startup?"startup_deadline":"query_deadline"),budget);
   pending.set(id,{resolve,reject,timer});
  });
 }
 const ready=waiting("ready");
 function lineReceived(line){
  try{
   let value;
   try{value=JSON.parse(line);}catch{throw Error("Malformed native foreground reply");}
   if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Malformed native foreground reply");
   if(value&&Object.hasOwn(value,"stage")){
    const expected=["powershell_started","interop_ready"][milestone];
    if(Object.keys(value).length!==1||readySeen||value.stage!==expected)throw Error("Malformed native foreground startup milestone");
    stage=value.stage;milestone++;diagnostic("startup_stage");return;
   }
   const isReady=Object.hasOwn(value,"ready")&&value.ready===true&&Object.keys(value).length===1;
   const id=isReady?"ready":Object.hasOwn(value,"id")?value.id:undefined;
   if(!isReady&&(!Object.hasOwn(value,"title")||typeof id!=="string"||!/^[0-9]+$/.test(id)||typeof value.title!=="string"||value.title.length>1023||Object.keys(value).length!==2))throw Error("Malformed native foreground reply");
   const entry=pending.get(id);
   if(!entry)throw Error("Uncorrelated native foreground reply");
   if(id==="ready"){readySeen=true;stage="ready";diagnostic("ready");}
   pending.delete(id);clearTimeout(entry.timer);entry.resolve(id==="ready"?null:value.title);
  }catch(error){fail(error,"reply_protocol");}
 }
 function stdoutReceived(chunk){
  if(failure||closed)return; // Keep draining, never retain data after failure.
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  let offset=0;
  while(offset<bytes.length){
   const newline=bytes.indexOf(10,offset),end=newline<0?bytes.length:newline;
   // Check bytes BEFORE concatenation, including an unterminated frame.
   if(buffered.length+end-offset>4096){fail(Error("Native foreground reply budget exceeded"),"stdout_budget");return;}
   if(end>offset)buffered=Buffer.concat([buffered,bytes.subarray(offset,end)]);
   if(newline<0)return;
   const line=buffered.toString("utf8");buffered=Buffer.alloc(0);
   lineReceived(line);if(failure)return;offset=end+1;
  }
 }
 child.stdout.on("data",stdoutReceived);
 child.stderr.on("data",chunk=>{
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  stderrBytesCapped ||= stderrBytes+bytes.length>65536;
  stderrBytes=Math.min(65536,stderrBytes+bytes.length);
  // Inspect a fixed prefix only. Classification is a clue, never root cause.
  const sample=bytes.subarray(0,256).toString("utf8");
  const category=/Add-Type|compiler|CS[0-9]{4}/i.test(sample)?"interop_compile":
   /access.*denied|permission/i.test(sample)?"access_denied":
   /not recognized|command.*not.*found/i.test(sample)?"command_unavailable":"other";
  stderrCategories.add(category);
 });
 child.stdin.on("error",()=>fail(Error("Native foreground query write failed"),"stdin_error"));
 child.stdout.on("error",()=>fail(Error("Native foreground reply stream failed"),"stdout_error"));
 child.on("error",()=>fail(Error("Native foreground process failed"),"process_error"));
 child.on("exit",(code,signal)=>{
  ended=true;
  exitCode=Number.isInteger(code)&&code>=-2147483648&&code<=4294967295?code:null;
  exitSignal=signal==null?null:["SIGTERM","SIGKILL","SIGINT","SIGHUP","SIGBREAK"].includes(signal)?signal:"UNKNOWN";
  diagnostic("exit");fail(Error("Native foreground process exited"),"process_exit");
 });
 async function close(){
  if(closed)return;closed=true;
  diagnostic("closing");
  fail(Error("Native foreground diagnostics closed"),"closed",false);
  child.stdin.end();
  try{
   if(!ended)await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(!ended)child.kill();},250);
    const deadline=setTimeout(()=>reject(Error("Native foreground observer did not exit")),1000);
    child.once("exit",()=>{clearTimeout(timer);clearTimeout(deadline);resolve();});
   });
  }finally{child.stdout.off("data",stdoutReceived);buffered=Buffer.alloc(0);diagnostic("closed");}
 }
 try{await ready;}catch(error){
  try{await close();}catch(cleanup){console.error("AX2_NVDA_NATIVE_FOREGROUND_CLEANUP_ERROR:"+String(cleanup));}
  throw error;
 }
 return {async read(){
  if(closed||ended||failure)throw failure??Error("Native foreground diagnostics unavailable");
  const id=String(next++),answer=waiting(id);
  child.stdin.write(id+"\n",error=>{if(error)fail(Error("Native foreground query write failed"),"stdin_error");});
  return answer;
 },close};
}
