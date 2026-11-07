import assert from "node:assert/strict";
import test from "node:test";
import {resetVoiceOverRunner} from "./reset-voiceover.mjs";
function fixture(){
 const signals=[],requests=[],state={running:true,foreign:false,unknown:false,changed:false,zombie:false,keepAlive:false,postKillZombie:false,disappearAfterTerm:false,psMissing:false};
 const options={platform:"darwin",uid:501,env:{GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:"viniciussucupira/marktmorgen",AX2_PUBLIC_DISPOSABLE_RUNNER:"true"},
  now:()=>1,wait:async()=>{},
  run:(file,args)=>{
   if(file.endsWith("osascript")){requests.push(args[1]);if(args[1].startsWith("return"))return state.running?"true":"false";if(state.gracefulStop)state.running=false;return "";}
   if(file.endsWith("pgrep")){
    if(state.unknown)throw Object.assign(Error("inventory unavailable"),{status:2});
    if(!state.running)throw Object.assign(Error("no process"),{status:1});
    return state.changed?"43\n":"42\n";
   }
   if(state.psMissing)throw Object.assign(Error("process disappeared"),{status:1,signal:null});
   return (state.foreign?"0":"501")+(state.zombie?" Z ":" S ")+"/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver\n";
  },
  kill:(pid,signal)=>{signals.push([pid,signal]);if(signal==="SIGTERM"&&state.disappearAfterTerm)state.psMissing=true;if(signal==="SIGKILL"){if(state.postKillZombie)state.zombie=true;else if(!state.keepAlive)state.running=false;}},
 };
 return {options,signals,state,requests};
}
test("stuck exact owned runner process must stop before real reader startup",async()=>{
 const f=fixture();assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:1,forcedProcesses:1});
 assert.deepEqual(f.signals,[[42,"SIGTERM"],[42,"SIGKILL"]]);
});
test("an explicit empty inventory needs no signal",async()=>{
 const f=fixture();f.state.running=false;assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:0,forcedProcesses:0});assert.deepEqual(f.signals,[]);
});
test("foreign user, unmarked host, unknown inventory and changed process refuse",async()=>{
 for(const mode of ["foreign","host","inventory","path","missing","changed"]){
  const f=fixture();
  if(mode==="foreign")f.state.foreign=true;
  if(mode==="host")f.options.env.AX2_PUBLIC_DISPOSABLE_RUNNER="false";
  if(mode==="inventory")f.state.unknown=true;
  if(mode==="path"){const original=f.options.run;f.options.run=(file)=>file.endsWith("ps")?"501 S /tmp/VoiceOver\n":original(file);}
  if(mode==="missing")f.state.psMissing=true;
  if(mode==="changed")f.options.wait=async()=>{f.state.changed=true;};
  await assert.rejects(resetVoiceOverRunner(f.options),undefined,mode);
  if(mode!=="changed")assert.deepEqual(f.signals,[],mode);
  else assert.deepEqual(f.signals,[[42,"SIGTERM"]]);
 }
});

test("verified owned zombie is exited evidence and receives no signal",async()=>{
 const f=fixture();f.state.zombie=true;
 assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:1,forcedProcesses:0});
 assert.deepEqual(f.signals,[]);
});
test("post-kill zombie is distinguished from a persistent live reader",async()=>{
 const f=fixture();f.state.postKillZombie=true;
 assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:1,forcedProcesses:1});
 assert.deepEqual(f.signals,[[42,"SIGTERM"],[42,"SIGKILL"]]);
 const live=fixture();live.state.keepAlive=true;
 await assert.rejects(resetVoiceOverRunner(live.options),/did not prove a stopped reader.*"state":"S"/);
 assert.equal(live.signals.length,2,"no retry or additional signal after the existing kill ceiling");
});
test("a verified process disappearing after SIGTERM is stopped evidence",async()=>{
 const f=fixture();f.state.disappearAfterTerm=true;
 assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:1,forcedProcesses:0});
 assert.deepEqual(f.signals,[[42,"SIGTERM"]]);
});
test("a never-verified process cannot disappear from the initial inventory",async()=>{
 const f=fixture(),run=f.options.run;let inventories=0;
 f.state.running=false;
 f.options.run=(file,args)=>{
  if(file.endsWith("pgrep")){
   inventories++;
   if(inventories===1)return "42\n43\n";
   if(inventories===2)return "42\n";
   throw Object.assign(Error("no process"),{status:1,signal:null});
  }
  if(file.endsWith("ps")&&args[1]==="43")throw Object.assign(Error("process disappeared"),{status:1,signal:null});
  return run(file,args);
 };
 let error;
 try{await resetVoiceOverRunner(f.options);}catch(caught){error=caught;}
 assert.deepEqual({message:error?.message??null,signals:f.signals},
  {message:"process disappeared",signals:[]});
});
test("foreign or replacement zombie cannot bypass ownership and identity checks",async()=>{
 const foreign=fixture();foreign.state.zombie=true;foreign.state.foreign=true;
 await assert.rejects(resetVoiceOverRunner(foreign.options),/exact Apple executable/);assert.deepEqual(foreign.signals,[]);
 const changed=fixture();changed.options.wait=async()=>{changed.state.changed=true;changed.state.zombie=true;};
 await assert.rejects(resetVoiceOverRunner(changed.options),/process changed/);assert.deepEqual(changed.signals,[[42,"SIGTERM"]]);
});

test("graceful quit ends the owned session before signals and never repeats",async()=>{
 const f=fixture();f.state.gracefulStop=true;
 assert.deepEqual(await resetVoiceOverRunner(f.options),{initialProcesses:1,forcedProcesses:0});
 assert.deepEqual(f.signals,[]);
 assert.deepEqual(f.requests,['return application id "com.apple.VoiceOver" is running','tell application id "com.apple.VoiceOver" to quit']);
});
test("empty, zombie and foreign inventories never request an application quit",async()=>{
 for(const mode of ["empty","zombie","foreign"]){
  const f=fixture();if(mode==="empty")f.state.running=false;if(mode==="zombie")f.state.zombie=true;if(mode==="foreign")f.state.foreign=true;
  if(mode==="foreign")await assert.rejects(resetVoiceOverRunner(f.options),/exact Apple executable/);else await resetVoiceOverRunner(f.options);
  assert.deepEqual(f.requests,[],mode);
 }
});
test("a failed graceful quit retains the exact bounded signal fallback",async()=>{
 const f=fixture(),run=f.options.run;
 f.options.run=(file,args)=>{if(file.endsWith("osascript")&&args[1].startsWith("tell"))throw Error("AppleEvent timeout");return run(file,args);};
 await resetVoiceOverRunner(f.options);
 assert.deepEqual(f.signals,[[42,"SIGTERM"],[42,"SIGKILL"]]);
});
test("replacement during graceful quit is refused without any signal",async()=>{
 const f=fixture(),run=f.options.run;
 f.options.run=(file,args)=>{const result=run(file,args);if(file.endsWith("osascript")&&args[1].startsWith("tell"))f.state.changed=true;return result;};
 await assert.rejects(resetVoiceOverRunner(f.options),/process changed/);assert.deepEqual(f.signals,[]);
});
