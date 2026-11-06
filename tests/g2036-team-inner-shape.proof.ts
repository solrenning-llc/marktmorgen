import {putMember,readTeam,setRequireTwoStep,teamTwoStepBlocks} from '@/lib/team';
import {claimHandle,ensureStoreId,storeForEmail} from '@/lib/store';
import {store as redis} from './redis-stub';
import {done,is} from './check';
globalThis.fetch=async()=>{throw Error('G proof blocks external requests');};
const owner='g-team-shape-owner@example.test',amy='g-team-shape-amy@example.test',ben='g-team-shape-ben@example.test',added='g-team-shape-new@example.test';
async function fixture(){
 redis.clear();await claimHandle(owner,'g-team-inner-shape','Synthetic team','');await ensureStoreId(owner);
 const shop=(await storeForEmail(owner))!;await putMember(shop,amy,'admin');await putMember(shop,ben,'support');await setRequireTwoStep(shop,true,owner);
 const pipe=redis.pipeline.bind(redis),key='nl:team:'+shop.sid;
 const kept=(await pipe([['GET',key]]))[0] as string;
 return{shop,pipe,key,kept};
}
async function main(){
 const cases=[
  ['null-member',(v:any)=>{v.members[0]=null;}],
  ['null-invite',(v:any)=>{v.invites=[null];}],
  ['unknown-member-role',(v:any)=>{v.members[0].role={unknown:true};}],
  ['nontext-member-email',(v:any)=>{v.members[0].email=7;}],
 ] as const;
 for(const [label,mutate]of cases){
  const f=await fixture(),value=JSON.parse(f.kept);mutate(value);const bad=JSON.stringify(value);let faults=0,commandsSeen=0;
  redis.pipeline=async commands=>{
   commandsSeen+=commands.length;if(commandsSeen>200)throw Error('admitted synthetic command ceiling');
   const replies=await f.pipe(commands);
   if(commands.length===1&&commands[0][0]==='GET'&&commands[0][1]===f.key){faults++;return[bad];}return replies;
  };
  let reading,gate,result;
  try{
   reading=await readTeam(f.shop.sid!).then(()=> 'accepted',()=> 'unknown');
   gate=await teamTwoStepBlocks(f.shop,amy,'admin').then(b=>b?'asked':'let-in',()=> 'refused');
   result=await putMember(f.shop,added,'support').then(v=>v?'written':'not-written',()=> 'refused');
  }finally{redis.pipeline=f.pipe;}
  const stored=(await f.pipe([['GET',f.key]]))[0] as string;
  is(label+': malformed team is unknown',reading,'unknown');
  is(label+': unknown gate refuses',gate,'refused');
  is(label+': owner change refuses before rewriting',result,'refused');
  is(label+': stored healthy team remains byte-identical',stored,f.kept);
  is(label+': known original members remain',(await readTeam(f.shop.sid!)).members.map(m=>m.email),[amy,ben]);
  is(label+': no second-step flag is lost',(await readTeam(f.shop.sid!)).requireTwoStep,true);
  console.log('G_TEAM_INNER',JSON.stringify({label,faults,commandsSeen,reading,gate,result,original:JSON.parse(f.kept),stored:JSON.parse(stored)}));
 }
 const f=await fixture();is('healthy owner adds',await putMember(f.shop,added,'support'),true);
 const good=await readTeam(f.shop.sid!);is('healthy three members',good.members.map(m=>m.email),[amy,ben,added]);is('healthy rule preserved',good.requireTwoStep,true);
 done();
}
void main();
