// Codex G's proof on #2576 (codex/g-review-2576-return-184@29774f359, tests/g2576-launch-entry-shape.proof.ts, SHA256 b4d0d347…), kept as a discovered test with its assertions unchanged.
import {addProduct,claimHandle,ensureListId,ensureStatsId,storeForEmail} from '@/lib/store';
import {readListing} from '@/lib/catalog';
import {launch,setSoon,isSoon} from '@/lib/waitlist';
import {store as redis} from './redis-stub';
import {done,is} from './check';
let external=0,totalCommands=0;
globalThis.fetch=async()=>{external++;throw Error('G: no external provider');};
const base=redis.pipeline.bind(redis);
redis.pipeline=async commands=>{totalCommands+=commands.length;if(totalCommands>5000)throw Error('G: finite admitted exercise ceiling');return base(commands);};
const counted=redis.pipeline.bind(redis);
async function fixture(){
 redis.clear();const owner='g-launch-owner@example.test';await claimHandle(owner,'g-launch-shape','Synthetic list','');await ensureStatsId(owner);await ensureListId(owner);
 const made=await addProduct(owner,'Synthetic guide','','39',null);if(!made.ok)throw Error('fixture product');
 const shop=(await storeForEmail(owner))!,product=(await readListing(shop,made.product.id))!;
 await setSoon(shop,product.id,true);const key=`nl:wl:${shop.statsId}:${product.id}`;
 await redis.pipeline([['HSET',key,'g-person-a@example.test',JSON.stringify({at:1,ok:1,c:false,t:'a'.repeat(48)}),'g-person-b@example.test',JSON.stringify({at:1,ok:1,c:false,t:'b'.repeat(48)})]]);
 const before=(await redis.pipeline([['HGETALL',key]]))[0];return{shop,product,key,before};
}
async function main(){
 for(const bad of ['{cut','{}']){
  const f=await fixture();let faults=0;
  redis.pipeline=async commands=>{const values=await counted(commands);if(commands.length===2&&commands[0][0]==='GET'&&commands[1][0]==='HGETALL'&&commands[1][1]===f.key){faults++;const entries=[...(values[1] as unknown[])];for(let i=1;i<entries.length;i+=2)entries[i]=bad;return[values[0],entries];}return values;};
  let outcome;try{outcome=await launch(f.shop,f.product,{note:'Synthetic launch',address:'Synthetic business address'}).then(r=>JSON.stringify(r),e=>e.name);}finally{redis.pipeline=counted;}
  const after=(await redis.pipeline([['HGETALL',f.key]]))[0];
  is(bad+': launch read boundary reached',faults,1);
  is(bad+': undecodable item is unknown before changes',outcome,'UnknownReply');
  is(bad+': live list is preserved byte-identically',after,f.before);
  is(bad+': coming-soon mark is preserved',await isSoon(f.shop,f.product.id),true);
  console.log('G_LAUNCH_ENTRY',JSON.stringify({bad,outcome,before:f.before,after}));
 }
 const healthy=await fixture();is('healthy two confirmed launch',await launch(healthy.shop,healthy.product,{note:'Synthetic launch',address:'Synthetic business address'}),{ok:true,total:2});
 const empty=await fixture();await redis.pipeline([['DEL',empty.key]]);is('confirmed empty launch remains allowed',await launch(empty.shop,empty.product,{note:'Synthetic launch',address:''}),{ok:true,total:0});
 is('no external requests',external,0);is('complete synthetic exercise stayed in ceiling',totalCommands<=5000,true);console.log('G_LAUNCH_COMMANDS',totalCommands);done();
}
void main();
