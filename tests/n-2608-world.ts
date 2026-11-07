export type Command = (string | number)[];
export const data = new Map<string,string>();
export const trace: Command[][] = [];
let total = 0;
export let afterGet: null | (()=>void) = null;
export let replyOverride: null | ((commands:Command[][][number],real:unknown[])=>unknown[]) = null;
export function reset(){data.clear();trace.length=0;afterGet=null;replyOverride=null;}
export function onRead(fn:()=>void){afterGet=fn;}
export function override(fn:NonNullable<typeof replyOverride>){replyOverride=fn;}
export const isRedisConfigured=()=>true;
export async function redisPipeline(commands:Command[]):Promise<unknown[]>{
 if(total+commands.length>128)throw Error('Synthetic command ceiling exceeded');
 total+=commands.length;trace.push(commands.map(c=>[...c]));
 const out=commands.map(([name,key,...args])=>{
  if(name==='GET')return data.get(String(key))??null;
  if(name==='SET'){data.set(String(key),String(args[0]));return 'OK';}
  if(name==='DEL'){let n=0;for(const k of [key,...args])n+=Number(data.delete(String(k)));return n;}
  throw Error('Unadmitted synthetic command: '+name);
 });
 if(commands.some(c=>c[0]==='GET')&&afterGet){const fn=afterGet;afterGet=null;fn();}
 return replyOverride?replyOverride(commands,out):out;
}
export const normaliseEmail=(s:string)=>s.trim().toLowerCase();
export const EMAIL_PATTERN=/^[^@]+@[^@]+$/;
export const MAX_EMAIL_LENGTH=254;
const unused=()=>{throw Error('Unexercised dependency called');};
export const withinStore=unused,orderWrite=unused,holdsProducts=unused,sendEmail=unused,withinEssentialLimit=unused,withinLimit=unused,coursesWords=unused;
process.on('beforeExit',()=>console.log('SYNTHETIC_COMMANDS',total));
