import { UPLOAD_BUDGET_SCOPES, uploadBudgetSnapshot, uploadLedgerKey, type UploadBudgetPolicy } from '../lib/upload-budget-policy';
export const hashes=new Map<string,Map<string,string>>();
export const opened=new Set<string>();
export const calls:(string|number)[][][]=[];
export let available=true, failing=false, expiring=false, wrongType=false, lostAck=false;
export let reply:unknown[]|null=null;
export function reset(){hashes.clear();opened.clear();calls.length=0;available=true;failing=false;expiring=false;wrongType=false;lostAck=false;reply=null;}
export const isRedisConfigured=()=>available;
export function settings(value:{available?:boolean;failing?:boolean;expiring?:boolean;wrongType?:boolean;lostAck?:boolean;reply?:unknown[]|null}){
 if(value.available!==undefined)available=value.available;if(value.failing!==undefined)failing=value.failing;if(value.expiring!==undefined)expiring=value.expiring;if(value.wrongType!==undefined)wrongType=value.wrongType;if(value.lostAck!==undefined)lostAck=value.lostAck;if(value.reply!==undefined)reply=value.reply;
}
export function seed(policy:UploadBudgetPolicy){
 const row=new Map([['policy',uploadBudgetSnapshot(policy)],['company:opens','0'],['company:bytes','0'],['company:controls','0']]);
 for(const scope of UPLOAD_BUDGET_SCOPES)row.set('slots:'+scope,String(policy.fundedStores[scope]));
 hashes.set(uploadLedgerKey(policy.month),row);return row;
}
const amount=(value:unknown)=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&Number(value)<=9e15?Number(value):null;
/** Atomic contract double. It does not execute or certify the production Lua. */
export async function redisPipeline(commands:(string|number)[][]):Promise<unknown[]>{
 calls.push(commands);if(failing)throw Error('Redis unavailable');if(reply)return reply;
 if(commands.length===1&&commands[0][0]==='EVAL'&&String(commands[0][1]).includes("'company:bytes', -bytes"))return giveBack(commands[0]);
 if(commands.length===2&&commands[0][0]==='EVAL'&&commands[0][2]===2){const first=openLedger(commands[0]);const second=take(commands[1]);return lostAck?[]:[first,second[0]];}
 return take(commands[0],commands.length);
}
/** Contract double of OPEN_UPLOAD_BUDGET; the Lua itself runs against real Redis in CI. */
function openLedger(cmd:(string|number)[]):number{
 const [,, ,key,marker,review,snapshot,...counts]=cmd.map(String);const funded=counts.map(amount);
 if(funded.length!==6||funded.some(n=>n===null)||wrongType||expiring)return 0;
 const row=hashes.get(key);
 if(!row){if(opened.has(marker))return 0;opened.add(marker);const fresh=new Map([['review',review],['policy',snapshot],['company:opens','0'],['company:bytes','0'],['company:controls','0']]);UPLOAD_BUDGET_SCOPES.forEach((scope,i)=>{fresh.set('slots:'+scope,String(funded[i]));fresh.set('funded:'+scope,String(funded[i]));});hashes.set(key,fresh);return 1;}
 if(row.get('review')!==review)return 0;if(row.get('policy')===snapshot)return 1;
 if(['opens','bytes','controls'].some(name=>amount(row.get('company:'+name))===null))return 0;
 const slots:number[]=[];for(const [i,scope] of UPLOAD_BUDGET_SCOPES.entries()){const was=amount(row.get('funded:'+scope)),left=amount(row.get('slots:'+scope));if(was===null||left===null||left>was)return 0;slots.push(Math.max(0,funded[i]!-(was-left)));}
 UPLOAD_BUDGET_SCOPES.forEach((scope,i)=>{row.set('slots:'+scope,String(slots[i]));row.set('funded:'+scope,String(funded[i]));});row.set('policy',snapshot);return 1;
}
function take(cmd:(string|number)[],count=1):unknown[]{
 if(count!==1||cmd[0]!=='EVAL'||cmd[2]!==1)throw Error('Expected one atomic reservation');
 const [snapshot,id,scope,action,bytesRaw,...rest]=cmd.slice(4).map(String);
 const bytes=amount(bytesRaw),limits=rest.slice(0,3).map(amount),companyLimits=rest.slice(3,6).map(amount),funded=amount(rest[6]);
 const row=hashes.get(String(cmd[3]));if(!row||wrongType||expiring||row.get('policy')!==snapshot||funded===null||bytes===null||!['open','control'].includes(action)||action==='open'&&bytes<=0||action==='control'&&bytes!==0)return[0];
 const names=['opens','bytes','controls'],prefix='store:'+id+':',currentScope=row.get(prefix+'scope');
 const company=names.map(name=>amount(row.get('company:'+name)));
 const used=names.map(name=>currentScope===undefined?(row.has(prefix+name)?null:0):amount(row.get(prefix+name)));
 if(currentScope!==undefined&&currentScope!==scope)return[0];
 if([...limits,...companyLimits,...company,...used].some(n=>n===null))return[0];
 for(let i=0;i<3;i++)if(company[i]!>companyLimits[i]!||used[i]!>limits[i]!||used[i]!>company[i]!)return[0];
 let slots:number|null=null;if(currentScope===undefined){slots=amount(row.get('slots:'+scope));if(slots===null||slots<=0||slots>funded)return[0];}
 const charge=[action==='open'?1:0,bytes,1];
 if(charge.some((value,i)=>value>limits[i]!-used[i]!||value>companyLimits[i]!-company[i]!))return[0];
 if(currentScope===undefined){row.set('slots:'+scope,String(slots!-1));row.set(prefix+'scope',scope);}
 for(let i=0;i<3;i++){row.set(prefix+names[i],String(used[i]!+charge[i]));row.set('company:'+names[i],String(company[i]!+charge[i]));}
 return lostAck?[]:[1];
}
/** Contract double of RETURN_UPLOAD_BYTES: same ledger, policy and scope, never below zero. */
function giveBack(cmd:(string|number)[]):unknown[]{
 const [snapshot,id,scope,bytesRaw]=cmd.slice(4).map(String);const row=hashes.get(String(cmd[3]));const prefix='store:'+id+':';
 const bytes=amount(bytesRaw),store=amount(row?.get(prefix+'bytes')),company=amount(row?.get('company:bytes'));
 if(!row||wrongType||expiring||row.get('policy')!==snapshot||row.get(prefix+'scope')!==scope||bytes===null||bytes<=0||store===null||company===null||store<bytes||company<bytes)return[0];
 row.set(prefix+'bytes',String(store-bytes));row.set('company:bytes',String(company-bytes));return[1];
}
