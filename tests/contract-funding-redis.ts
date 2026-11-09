import {createHash} from 'node:crypto';
import type {ContractFundingConfiguration} from '@/lib/contract-funding-rules';
export const ledger=new Map<string,Map<string,string>>();
export const calls:(string|number)[][][]=[];
let available=true,failure=false,lostAck=false;
let response:unknown[]|null=null;
export const isRedisConfigured=()=>available;
export function reset(){ledger.clear();calls.length=0;available=true;failure=false;lostAck=false;response=null;}
export function settings(v:{available?:boolean;failure?:boolean;lostAck?:boolean;response?:unknown[]|null}){if(v.available!==undefined)available=v.available;if(v.failure!==undefined)failure=v.failure;if(v.lostAck!==undefined)lostAck=v.lostAck;if(v.response!==undefined)response=v.response;}
export function seed(c:ContractFundingConfiguration){ledger.set('nl:contract-reserve:v1',new Map([['review',c.reviewId],['policy',createHash('sha256').update(c.binding).digest('hex')],['reserved',String(c.carryForwardCents)],['carried',String(c.carryForwardCents)],...Object.entries(c.fundedGrants).map(([key,n]):[string,string]=>['slots:'+key,String(n)])]));}

function activate(args:(string|number)[],readOnly=false):unknown[]{
 const [key,binding,review,store,choice,nonce,subscription,rawCreated,rawNow,rawMinimum,rawLimit,rawCarry,rawSubmission,rawFunded,phase,rawStart,rawEnd]=args;
 const h=ledger.get(String(key));
 if(!h||h.get('policy')!==binding||h.get('review')!==review)return[0];
 const parse=(n:unknown)=>typeof n==='string'&&/^(0|[1-9][0-9]*)$/.test(n)&&Number(n)<=1e12?Number(n):NaN;
 const receipt=(h.get('grant:'+nonce)??'').split('|');
 if(receipt.length!==9)return[0];
 const [charge,submitted,expires,activation]=receipt.slice(4,8).map(parse);
 const through=/^(0|[1-9][0-9]*)$/.test(receipt[8])?Number(receipt[8]):NaN;
 const [created,now,minimum,limit,carry,submission,funded]=[rawCreated,rawNow,rawMinimum,rawLimit,rawCarry,rawSubmission,rawFunded].map(n=>parse(String(n)));
 const reserved=parse(h.get('reserved')),carried=parse(h.get('carried')),slots=parse(h.get('slots:'+choice));
 if(receipt[0]!==review||receipt[1]!==store||receipt[2]!==choice||receipt[3]!=='checkout'||![charge,submitted,expires,activation,through,created,now,minimum,limit,carry,submission,funded,reserved,carried,slots].every(Number.isSafeInteger)||funded<=0||slots>=funded)return[0];
 if(charge!==minimum||carried!==carry||reserved<carried||reserved>limit||charge>reserved-carried||submitted<submission||created<submitted-submission||created>activation||created>now||through<now*1000)return[0];
 const start=parse(String(rawStart)),finish=parse(String(rawEnd));
 if(!['trial','paid'].includes(String(phase))||!Number.isSafeInteger(start)||!Number.isSafeInteger(finish)||start<created||start>now||finish<=now||finish<=start||finish*1000>through)return[0];
 const proof=[nonce,subscription,choice,rawCreated,phase,rawStart,rawEnd].join('|'),consumed=h.get('activated:'+nonce),active=h.get('active:'+store);
 if(consumed)return consumed===proof&&active===proof?[[2,finish]]:[0];
 // The read-only observation (OBSERVE_CONTRACT) stops here: never a new activation, never a write.
 if(readOnly)return[0];
 if(now>activation)return[0];
 if(h.get('pending:'+store)!==nonce||active)return[0];
 h.set('activated:'+nonce,proof);h.set('active:'+store,proof);h.delete('pending:'+store);
 return lostAck?[]:[[1,activation]];
}


function activateSwitch(args:(string|number)[],readOnly=false):unknown[]{
 const [key,binding,review,store,choice,nonce,sub,rawCreated,rawNow,rawMinimum,rawLimit,rawCarry,rawSubmission,rawFunded,phase,rawStart,rawFinish,rawSpan]=args;
 const h=ledger.get(String(key));if(!h||h.get('policy')!==binding||h.get('review')!==review)return[0];
 const parse=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&Number(v)<=1e12?Number(v):NaN;
 const epoch=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):NaN;
 const receipt=(h.get('grant:'+nonce)??'').split('|');
 if(receipt.length!==10||receipt[0]!==review||receipt[1]!==store||receipt[2]!==choice||receipt[3]!=='switch'||receipt[9].length>84||!/^ctr_[A-Za-z0-9_-]+$/.test(receipt[9])||receipt[9]===nonce)return[0];
 const [charge,submitted,expires,deadline]=receipt.slice(4,8).map(parse),through=epoch(receipt[8]);
 const [created,now,minimum,limit,carry,submission,funded,start,finish,span]=[rawCreated,rawNow,rawMinimum,rawLimit,rawCarry,rawSubmission,rawFunded,rawStart,rawFinish,rawSpan].map(v=>parse(String(v)));
 if(![charge,submitted,expires,deadline,through,created,now,minimum,limit,carry,submission,funded,start,finish,span].every(Number.isSafeInteger)||charge<=0||span<=0||charge!==minimum||submitted<submission||expires<submitted||deadline<expires||now<submitted-submission||created>now||start<created||start>now||finish<=now||finish<=start||finish-start>span||finish>submitted-submission+span||finish*1000>through||!['trial','paid'].includes(String(phase)))return[0];
 const reserved=parse(h.get('reserved')),carried=parse(h.get('carried')),slots=parse(h.get('slots:'+choice));
 if(![reserved,carried,slots].every(Number.isSafeInteger)||carried!==carry||reserved<carried||reserved>limit||funded<=0||slots>=funded)return[0];
 const sourceRaw=h.get('activated:'+receipt[9]),source=(sourceRaw??'').split('|');
 if(!sourceRaw||sourceRaw.length>256||source.length!==7||source[0]!==receipt[9]||source[1]!==sub||source[3]!==String(rawCreated))return[0];
 const sourceStart=parse(source[5]),sourceFinish=parse(source[6]);
 if(![sourceStart,sourceFinish].every(Number.isSafeInteger)||sourceStart<created||sourceStart>submitted-submission||sourceFinish<=submitted-submission||!['trial','paid'].includes(source[4])||phase==='trial'&&(source[4]!=='trial'||finish>sourceFinish))return[0];
 const original=(h.get('grant:'+receipt[9])??'').split('|');
 if(original[0]!==review||original[1]!==store||original[2]!==source[2]||!(original.length===9&&original[3]==='checkout'||original.length===10&&original[3]==='switch'))return[0];
 const oldCharge=parse(original[4]),oldThrough=epoch(original[8]);
 if(!original.slice(5,8).map(parse).every(Number.isSafeInteger)||!Number.isSafeInteger(oldThrough)||sourceFinish*1000>oldThrough||!Number.isSafeInteger(oldCharge)||oldCharge<=0||charge+oldCharge>reserved-carried)return[0];
 const proof=[nonce,sub,choice,rawCreated,phase,rawStart,rawFinish].join('|'),consumed=h.get('activated:'+nonce),active=h.get('active:'+store);
 if(proof.length>256)return[0];
 if(consumed)return consumed===proof&&active===proof?[[2,finish]]:[0];
 if(readOnly)return[0];
 if(now>deadline)return[0];
 if(active!==sourceRaw||h.get('pending:'+store)!==nonce)return[0];
 h.set('activated:'+nonce,proof);h.set('active:'+store,proof);h.delete('pending:'+store);return lostAck?[]:[[1,deadline]];
}

/** Contract double only. CI executes the production Lua against real Redis. */
export async function redisPipeline(commands:(string|number)[][]):Promise<unknown[]>{
 calls.push(commands);if(failure)throw Error('Redis unavailable');if(response!==null)return response;
 if(String(commands[0]?.[1]).includes("local switchSource=redis.call")){
  if(commands.length!==1||commands[0][0]!=='EVAL'||commands[0][2]!==1)throw Error('Expected one switch activation');
  return activateSwitch(commands[0].slice(3),!String(commands[0][1]).includes("redis.call('HSET'"));
 }
 if(String(commands[0]?.[1]).includes("local consumed=redis.call")){
  if(commands.length!==1||commands[0][0]!=='EVAL'||commands[0][2]!==1)throw Error('Expected one activation');
  return activate(commands[0].slice(3),!String(commands[0][1]).includes("redis.call('HSET'"));
 }
 const [op,,keys,key,binding,review,store,choice,rawCharge,rawLimit,rawCarry,rawFunded,nonce,receipt,action,sourceSubscription,rawNow]=commands[0];
 if(op!=='EVAL'||keys!==1||commands.length!==1)throw Error('Expected one contract reservation');
 const h=ledger.get(String(key));
 if(!h||h.get('policy')!==binding||h.get('review')!==review)return[0];
 if(!['checkout','switch'].includes(String(action))||!String(receipt).startsWith([review,store,choice,action,''].join('|'))||action==='checkout'&&h.has('active:'+store))return[0];
 const parse=(n:unknown)=>typeof n==='string'&&/^(0|[1-9][0-9]*)$/.test(n)&&Number(n)<=1e12?Number(n):NaN;
 let sourceGrant:string|undefined,sourceCharge:number|undefined;
 if(action==='checkout'){if(sourceSubscription!=='')return[0];}
 else{
  const active=h.get('active:'+store),source=(active??'').split('|');
  if(!active||active.length>256||source.length!==7||source[1]!==sourceSubscription||source[0].length>84||!/^ctr_[A-Za-z0-9_-]+$/.test(source[0])||!['creator_month','creator_year','pro_month','pro_year','scale_month','scale_year'].includes(source[2]))return[0];
  const [created,start,finish,now]=[source[3],source[5],source[6],String(rawNow)].map(parse);
  if(!['trial','paid'].includes(source[4])||![created,start,finish,now].every(Number.isSafeInteger)||start<created||start>now||finish<=now||finish<=start||h.get('activated:'+source[0])!==active)return[0];
  const raw=h.get('grant:'+source[0])??'';if(raw.length>1024)return[0];const old=raw.split('|');
  if(old[0]!==review||old[1]!==store||old[2]!==source[2]||!(old[3]==='checkout'&&old.length===9||old[3]==='switch'&&old.length===10&&/^ctr_[A-Za-z0-9_-]+$/.test(old[9])))return[0];
  const [submitted,expires,activation]=old.slice(5,8).map(parse);
  if(![submitted,expires,activation].every(Number.isSafeInteger)||old[3]==='checkout'&&(submitted<300||created<submitted-300||created>activation))return[0];
  sourceCharge=parse(old[4]);const through=/^(0|[1-9][0-9]*)$/.test(old[8])?Number(old[8]):NaN;
  if(!Number.isSafeInteger(sourceCharge)||sourceCharge<=0||!Number.isSafeInteger(through)||finish*1000>through)return[0];
  sourceGrant=source[0];
 }
 const reserved=parse(h.get('reserved')),carried=parse(h.get('carried')),charge=parse(String(rawCharge)),limit=parse(String(rawLimit)),carry=parse(String(rawCarry)),funded=parse(String(rawFunded)),slots=parse(h.get('slots:'+choice));
 if(![reserved,carried,charge,limit,carry,funded,slots].every(Number.isSafeInteger)||charge<=0||carried!==carry||reserved<carried||reserved>limit||funded<=0||slots>funded||slots<=0||h.has('pending:'+store)||h.has('grant:'+nonce)||charge>limit-reserved||sourceCharge!==undefined&&sourceCharge>reserved-carried)return[0];
 h.set('slots:'+choice,String(slots-1));h.set('reserved',String(reserved+charge));h.set('pending:'+store,String(nonce));h.set('grant:'+nonce,String(receipt)+(sourceGrant?'|'+sourceGrant:''));
 return lostAck?[]:[1];
}
