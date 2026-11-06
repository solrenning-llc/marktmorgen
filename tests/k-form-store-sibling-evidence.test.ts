/** C4-1910 rule30: actual sibling helpers, synthetic Redis reply only. */
import {readForms,readForm,responseCounts,addResponse,dropForm,writeForm} from '@/lib/form-store';
import {UnknownReply} from '@/lib/redis-exact';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {form,responses} from './form-response-fixture';
import {done,is,part} from './check';
async function main(){
 const pipeline=redis.pipeline.bind(redis),stats='sibling-fixture',key=`nl:form:r:${stats}:${form.id}`;
 const helpers=[
  {name:'readForms',call:()=>readForms(stats),match:(b:(string|number)[][])=>b[0][0]==='HVALS',reply:[null]},
  {name:'readForm',call:()=>readForm(stats,form.id),match:(b:(string|number)[][])=>b[0][0]==='HGET',reply:[false]},
  {name:'responseCounts',call:()=>responseCounts(stats,[form.id]),match:(b:(string|number)[][])=>b[0][0]==='LLEN',reply:[null]},
  {name:'addResponse',call:()=>addResponse(stats,form.id,responses[0],ROOM),match:(b:(string|number)[][])=>b[0][0]==='EVAL'&&String(b[0][1]).startsWith('-- marktmorgen:form-keep:'),reply:[null]},
  {name:'dropForm',call:()=>dropForm(stats,form.id,ROOM),match:(b:(string|number)[][])=>b[0][0]==='HDEL',reply:[null,0]},
 ];
 part('Unknown receipts are not confirmed absence, zero, or a completed write');
 try{
  for(const helper of helpers)for(const unknown of [false,true]){
   redis.pipeline=pipeline;redis.clear();await writeForm(stats,form);await pipeline([['LPUSH',key,JSON.stringify(responses[0])]]);
   let commands=0,injected=0;redis.pipeline=async batch=>{
    if(commands+batch.length>20)throw Error('Twenty application Redis commands per scenario is the ceiling');commands+=batch.length;
    if(unknown&&helper.match(batch)){injected++;return helper.reply;}
    return pipeline(batch);
   };
   let outcome='known',value:unknown;
   try{value=await helper.call();}catch(error){outcome=error instanceof UnknownReply?'unknown':'unexpected error';}
   console.log('FORM_SIBLING_OBSERVATION',JSON.stringify({helper:helper.name,unknown,outcome,value,commands,injected}));
   is(helper.name+(unknown?' unknown':' healthy')+': explicit evidence',outcome,unknown?'unknown':'known');
   is(helper.name+': exactly the intended reply injected',injected,unknown?1:0);
   if(!unknown){
    const confirmed=helper.name==='readForms'?Array.isArray(value)&&value.length===1&&value[0].id===form.id:
     helper.name==='readForm'?(value as {id:string}).id===form.id:
     helper.name==='responseCounts'?(value as Record<string,number>)[form.id]===1:
     helper.name==='addResponse'?value===undefined&&(await pipeline([['LLEN',key]]))[0]===2:
     value===true&&(await pipeline([['HGET',`nl:forms:${stats}`,form.id]]))[0]===null;
    // Direct fixture inspection above is outside the application's command count.
    is(helper.name+': healthy stored result confirmed',confirmed,true);
   }
  }

  redis.pipeline=pipeline;redis.clear();let absenceCommands=0;
  redis.pipeline=async batch=>{if(absenceCommands+batch.length>20)throw Error('Known-absence control ceiling');absenceCommands+=batch.length;return pipeline(batch);};
  is('confirmed empty form inventory stays empty',await readForms(stats),[]);
  is('confirmed absent form stays absent',await readForm(stats,form.id),null);
  is('confirmed zero responses stays zero',await responseCounts(stats,[form.id]),{[form.id]:0});
  is('confirmed missing deletion stays false',await dropForm(stats,form.id,ROOM),false);
 }finally{redis.pipeline=pipeline;}
 done();
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
