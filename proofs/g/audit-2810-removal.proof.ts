/** Own evidence only: real POST, assignment, course, store-data + MemoryRedis; auth/provider boundaries synthetic. */
import {POST} from '@/app/api/store/course/route';
import {saveCourse,emptyCourse,editCourse,readCourse} from '@/lib/course';
import {saveTask,handIn,takeRoom,noteTaskUpload,takeTaskUpload,staleTaskUploads,dropTask} from '@/lib/assignment';
import {dataUsed} from '@/lib/store-data';
import {ROOM} from '../../tests/data-room';
import {store as redis} from '../../tests/redis-stub';
import {is,part,done} from '../../tests/check';
const COURSE='a'.repeat(32),WHO='b'.repeat(32),ROOMKEY=ROOM.sid!,PATH='g2810-local-student-work.pdf',BYTES=150;
const task={prompt:'Local synthetic work',review:true,gate:true,file:true};
let provider=new Set<string>(),providerCalls=0,failProvider=false,lessonId='';
const original=redis.pipeline.bind(redis);
(globalThis as unknown as {__g2810:unknown}).__g2810={
 guardStoreWrite:async(request:Request)=>({ok:true,ref:'fixture@example.test',body:await request.json()}),
 text:(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'',
 storeForEmail:async()=>ROOM,
 readListing:async()=>({id:'product-fixture',course:{id:COURSE,lessons:1}}),
 communityOf:()=>null,
 withLock:async(_k:string,_s:number,_w:number,fn:()=>unknown)=>fn(),
 storeKey:()=>ROOMKEY,
 deleteFile:async(paths:string|string[])=>{providerCalls++;if(failProvider)throw Error('synthetic provider unavailable BEFORE deletion');for(const p of [paths].flat())provider.delete(p);},
};
globalThis.fetch=async()=>{throw Error('NO external network permitted');};
async function seed(){
 redis.pipeline=original;redis.clear();provider=new Set([PATH]);providerCalls=0;failProvider=false;
 const base=emptyCourse(COURSE),added=editCourse(base,{op:'lesson-add',moduleId:base.modules[0].id,title:'Local lesson'});
 if(!added.ok)throw Error('seed lesson');lessonId=added.course.modules[0].lessons[0].id;
 const on=editCourse(added.course,{op:'task',lessonId,task});if(!on.ok)throw Error('seed task');
 await saveCourse(on.course,ROOM);await saveTask(COURSE,lessonId,task,ROOM);
 await noteTaskUpload(PATH);is('seed door consumed',await takeTaskUpload(PATH),true);
 is('seed 150 bytes charged before hand-in',await takeRoom(ROOMKEY,BYTES,10000,PATH),true);
 await handIn({courseId:COURSE,lessonId,who:WHO,email:'fixture@example.test',task,text:'local',file:{path:PATH,name:'local.pdf',bytes:BYTES,type:'application/pdf'},data:ROOM});
}
async function request(){const response=await POST(new Request('http://localhost/api/store/course',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'task',id:'product-fixture',lessonId,task:null})}) as never);return{status:response.status,body:await response.json()};}
const files=()=>`nl:course:${COURSE}:task:${lessonId}:files`;
const sub=()=>`nl:course:${COURSE}:task:${lessonId}:sub:${WHO}`;
const room=()=>Number(redis.run(['GET',`nl:tasks:bytes:${ROOMKEY}`])??0);
const logged=console.error;console.error=(...args)=>console.log('EXPECTED SYNTHETIC FAILURE:',String(args[0]),String(args[1]));
try{
 part('Healthy control: real course POST, actual removal and metering');await seed();
 let result=await request();is('HTTP success',result.status,200);is('payload ok',result.body.ok,true);is('provider deletion invoked once',providerCalls,1);is('provider file absent',provider.has(PATH),false);is('file inventory removed',redis.run(['HLEN',files()]),0);is('meter released after actual healthy deletion',room(),0);
 part('Provider rejects BEFORE deletion: preserved paid bytes or durable recovery required');await seed();failProvider=true;
 result=await request();console.log('OBSERVATION provider failure',JSON.stringify({result,providerStillHas:provider.has(PATH),providerCalls,room:room(),files:redis.run(['HGETALL',files()]),sub:redis.run(['GET',sub()]),stale:await staleTaskUploads(Date.now()+48*3600000)}));
 is('failed deletion keeps charge while file is retained',room(),BYTES);
 is('failed deletion preserves file inventory for retry',redis.run(['HGET',files(),PATH]),String(BYTES));
 is('failed deletion does not say complete success',result.body.ok===true,false);
 is('retry keeps ability to invoke provider',await request().then(()=>providerCalls>1),true);
 part('Redis destructive batch applied, response LOST: preserve disposal path before throwing');await seed();let lost=false;
 redis.pipeline=(async(batch:(string|number)[][])=>{const reply=await original(batch);if(!lost&&batch.some(c=>c[0]==='HDEL'&&c[1]===files())){lost=true;throw Error('synthetic Redis response LOST after batch application');}return reply;}) as typeof redis.pipeline;
 result=await request();redis.pipeline=original;
 console.log('OBSERVATION applied-lost',JSON.stringify({result,lost,providerStillHas:provider.has(PATH),providerCalls,room:room(),files:redis.run(['HGETALL',files()]),taskInCourse:!!(await readCourse(COURSE))?.modules[0].lessons[0].task,data:await dataUsed(ROOM)}));
 is('lost-response reaches server_error control',result.status,500);is('provider still retains file control',provider.has(PATH),true);
 is('lost-response preserves file inventory or disposal work',redis.run(['HGET',files(),PATH]),String(BYTES));
 await request();is('healthy retry reaches orphan provider file',provider.has(PATH),false);
 part('Destructive write ACK absent and NOT applied: no release on unknown write');await seed();let missing=false;
 redis.pipeline=(async(batch:(string|number)[][])=>{if(!missing&&batch.some(c=>c[0]==='HDEL'&&c[1]===files())){missing=true;return [];}return original(batch);}) as typeof redis.pipeline;
 result=await request();redis.pipeline=original;
 console.log('OBSERVATION no-apply/missing-ACK',JSON.stringify({result,missing,providerCalls,subKept:redis.run(['GET',sub()])!==null,room:room(),data:await dataUsed(ROOM)}));
 is('unknown write does not report success',result.body.ok===true,false);
 is('unknown write does not release room for retained data',room(),BYTES);
 part('Healthy read fault control: no mutation on malformed preflight');await seed();
 redis.pipeline=(async(batch:(string|number)[][])=>batch[0]?.[0]==='HGETALL'?[null]:original(batch)) as typeof redis.pipeline;
 const unknown=await dropTask(COURSE,lessonId,ROOMKEY,ROOM).then(()=>false,()=>true);redis.pipeline=original;
 is('unknown files throws',unknown,true);is('unknown preflight keeps provider bytes charged',room(),BYTES);is('unknown preflight keeps file inventory',redis.run(['HGET',files(),PATH]),String(BYTES));is('unknown preflight never calls provider',providerCalls,0);
}finally{redis.pipeline=original;console.error=logged;}
done();
