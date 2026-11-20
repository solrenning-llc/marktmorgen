import {saveLanding} from '@/lib/campaign-landing-store';
import {claimHandle,ensureStatsId,ensureStoreId,storeForEmail,storeRef,storeIdCommand,ownerKey,erasingField,ERASING_KEY} from '@/lib/store';
import {dataKey} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {is,done} from './check';
async function main(){
 for(const kind of ['primary','extra','legacy'])for(const state of ['live','gone','erasing'])for(const update of [false,true]){
  redis.clear();const email='x4-landings@example.invalid';await claimHandle(email,'x4-landings','Synthetic','');await ensureStatsId(email);await ensureStoreId(email);
  const real=(await storeForEmail(email))!;
  const room={...real,...(kind==='extra'?{extra:true}:kind==='legacy'?{sid:''}:{}),tier:'scale' as const,subscriptionActive:true,subscriptionId:'sub_synthetic'};
  const ref=storeRef(room);const live=room.sid?storeIdCommand(room.sid)[1]:await ownerKey(ref);
  redis.run(['SET',live,ref]);
  const key=`nl:product:landing:${room.statsId}:p1`,dk=dataKey(room)!;
  if(update)await saveLanding(room.statsId!,'p1',{campaign:'before',headline:'Before erasure',sub:'Synthetic draft',button:''},room);
  const original=redis.pipeline;let reached=false;
  redis.pipeline=async(commands)=>{
   if(!reached&&commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:landings-write:'))){
    reached=true;
    if(state==='gone'){redis.run(['DEL',live]);redis.run(['DEL',key]);redis.run(['DEL',dk]);}
    if(state==='erasing'){redis.run(['HSET',ERASING_KEY,await erasingField(ref),'']);redis.run(['DEL',key]);redis.run(['DEL',dk]);}
   }
   return original.call(redis,commands);
  };
  let result:unknown;try{result=await saveLanding(room.statsId!,'p1',{campaign:'late',headline:'Private synthetic person',sub:'Late campaign draft',button:''},room);}catch(e){result=e;}finally{redis.pipeline=original;}
  const label=`${kind}/${state}/${update?'update':'create'}`;
  is(label+' reached the actual writer',reached,true);
  if(state==='live')is(label+' live saves still work',result,'saved');
  else{
   is(label+' refuses the save',result==='saved',false);
   is(label+' does not restore deleted campaign text',redis.run(['GET',key]),null);
   is(label+' does not restore its data room',redis.run(['EXISTS',dk]),0);
  }
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
