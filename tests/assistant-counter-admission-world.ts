import { MemoryRedis } from "@/lib/redis-memory";
import type { Store } from "@/lib/store";
export const redis = new MemoryRedis();
const store = {sid:"c".repeat(32),statsId:"d".repeat(32),handle:"test-assistant"} as Store;
export const state={scope:"",reply:undefined as unknown,throws:false,commit:false,commands:[] as (string|number)[][],models:0,publics:0,lookups:0,reads:0,deletes:0,handoffs:0,found:true,shown:true};
export function reset(){redis.clear();Object.assign(state,{scope:"",reply:undefined,throws:false,commit:false,commands:[],models:0,publics:0,lookups:0,reads:0,deletes:0,handoffs:0,found:true,shown:true});}
export const isRedisConfigured=()=>true;
export async function redisPipeline(commands:(string|number)[][]):Promise<unknown[]>{
 state.commands.push(...commands);
 const selected=state.scope && String(commands[0][1]).startsWith(`nl:rl:${state.scope}:`);
 if(selected){if(state.commit)await redis.pipeline(commands);if(state.throws)throw new Error("Synthetic counter timeout");return state.reply as unknown[];}
 return redis.pipeline(commands);
}
/** Controlled store/provider boundaries; route, body/origin checks and counters are actual. */
export const normaliseHandle=(value:string)=>value;
export async function storeForHandle(){state.lookups++;return state.found?store:null;}
export const assistantShown=()=>state.shown;
export async function askAssistant(){state.models++;return {ok:true as const,thread:{token:"synthetic-token"},reply:"Synthetic answer"};}
export async function withinStore(){state.publics++;return true;}
export async function readThread(){state.reads++;return {token:"synthetic-token"};}
export async function deleteThread(){state.deletes++;}
export async function handToCreator(){state.handoffs++;return {ok:true as const,thread:{token:"synthetic-token"}};}
