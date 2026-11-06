/** G additional adversaries; the original 3861eefe proof remains unchanged. */
import {parseForm,type FormResponse} from '@/lib/forms';
import {writeForm,addResponse,forgetFormsPerson,readResponses} from '@/lib/form-store';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {done,is} from './check';
async function main(){
 const stats='g'.repeat(16),email='private@example.com';
 const form=parseForm({id:'exactform1',name:'Application',fields:[{id:'email1',type:'email',label:'Email',required:true}],offerList:false})!;
 const answer:FormResponse={at:1,page:'/apply',answers:{email1:email},outcome:'',joined:false};
 const real=redis.pipeline.bind(redis);
 for(const mode of ['extra-envelope','outer-getter','inner-getter','mixed-valid-invalid','row-is-array','row-is-number','row-is-null']){
  redis.clear();await writeForm(stats,form);await addResponse(stats,form.id,answer,ROOM);
  let reads=0,hits=0,refused=false;
  let payload:unknown=[[JSON.stringify(form)]];
  if(mode==='extra-envelope')payload=[[JSON.stringify(form)],0];
  if(mode==='outer-getter'){payload=new Array(1);Object.defineProperty(payload,0,{get(){reads++;return [JSON.stringify(form)];}});}
  if(mode==='inner-getter'){const list=new Array(1);Object.defineProperty(list,0,{get(){reads++;return JSON.stringify(form);}});payload=[list];}
  if(mode==='mixed-valid-invalid')payload=[[JSON.stringify(form),'{broken']];
  if(mode==='row-is-array')payload=[['[]']];
  if(mode==='row-is-number')payload=[[17]];
  if(mode==='row-is-null')payload=[[null]];
  redis.pipeline=async commands=>{
   if(commands.some(c=>c[0]==='HVALS'&&c[1]===`nl:forms:${stats}`)){hits++;return payload as unknown[];}
   return real(commands);
  };
  try{await forgetFormsPerson(stats,email,ROOM);}catch{refused=true;}finally{redis.pipeline=real;}
  is(mode+': actual discovery reached',hits,1);
  is(mode+': unknown discovery refuses',refused,true);
  is(mode+': no getter executes',reads,0);
  is(mode+': actual response preserved until healthy retry',(await readResponses(stats,form.id)).total,1);
  is(mode+': healthy retry erases known response',await forgetFormsPerson(stats,email,ROOM),1);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
