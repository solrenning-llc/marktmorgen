// Codex G's proof on #2036 (reviews 5808621078 and 5809812665, tests/g2036-missing-team-fields.proof.ts at bebced2c, SHA256 2938e375…), transcribed from the review's code block with its assertions unchanged; the transcription's SHA256 (b69fba02…) differs, likely whitespace.
/** Production inviteMember writer; initial demo-only putMember probe remains separate and unchanged. */
import {putMember,inviteMember,readTeam,setRequireTwoStep,teamTwoStepBlocks} from '@/lib/team';
import {claimHandle,ensureStoreId,storeForEmail} from '@/lib/store';
import {store as redis} from './redis-stub';
import {done,is} from './check';
process.env.RESEND_API_KEY='';
let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('G proof blocks external requests');};
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
  ['missing-members',(v:{members:unknown[];invites:unknown[]})=>{delete (v as {members?:unknown[]}).members;}],
  ['empty-object',(v:{members:unknown[];invites:unknown[]})=>{for(const k of Object.keys(v))delete (v as unknown as Record<string,unknown>)[k];}],
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
   result=await inviteMember(f.shop,added,'support','https://synthetic.example.test').then(v=>JSON.stringify(v),()=> 'refused');
  }finally{redis.pipeline=f.pipe;}
  const stored=(await f.pipe([['GET',f.key]]))[0] as string;
  is(label+': malformed team is unknown',reading,'unknown');
  // Main's reading (0dd864a79): an unknown team asks for the second step, never lets anyone past it.
  is(label+': unknown gate asks for the second step',gate,'asked');
  is(label+': owner change refuses before rewriting',result,'refused');
  is(label+': stored healthy team remains byte-identical',stored,f.kept);
  is(label+': known original members remain',(await readTeam(f.shop.sid!)).members.map(m=>m.email),[amy,ben]);
  is(label+': no second-step flag is lost',(await readTeam(f.shop.sid!)).requireTwoStep,true);
  console.log('G_TEAM_INNER',JSON.stringify({label,faults,commandsSeen,reading,gate,result,original:JSON.parse(f.kept),stored:JSON.parse(stored)}));
 }
 const f=await fixture();const control=await inviteMember(f.shop,added,'support','https://synthetic.example.test');is('healthy refusal is the explicit mail refusal',control.ok?null:control.reason,'unsent');
 const good=await readTeam(f.shop.sid!);is('healthy original members intact',good.members.map(m=>m.email),[amy,ben]);is('healthy rule preserved',good.requireTwoStep,true);is('no provider calls',fetches,0);
 done();
}
void main();

