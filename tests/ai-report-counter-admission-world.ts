import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";
const redis = new MemoryRedis();
const store = { sid: "a".repeat(32), statsId: "b".repeat(32), handle: "test-ai-reports" } as Store;
export const state = { authorized: true, override: false, reply: undefined as unknown, throws: false, commands: [] as (string | number)[][], models: 0, reads: 0, allowances: 0, left: 1, counted: true };
export function reset() { redis.clear(); Object.assign(state, { authorized: true, override: false, reply: undefined, throws: false, commands: [], models: 0, reads: 0, allowances: 0, left: 1, counted: true }); }
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
 state.commands.push(...commands); if(state.throws) throw new Error("Synthetic counter timeout");
 return state.override ? state.reply as unknown[] : redis.pipeline(commands);
}
/** Controlled authorization, data/quota and supplier boundaries; handlers/counter are actual. */
export async function guardStoreWrite(request: NextRequest) { return state.authorized ? { ok: true as const, store, body: await request.json() as Record<string, unknown> } : { ok: false as const, response: Response.json({ok:false,error:"role"},{status:403}) }; }
export const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0,max) : "";
export const MAX_QUESTION = 500;
export const NOT_COUNTED = "Synthetic quota refusal";
export const isAiConfigured = () => true;
export async function aiLeft() { return state.left; }
export async function countUnits() { state.allowances += 1; return state.counted ? {ok:true as const} : {ok:false as const,message:NOT_COUNTED}; }
export async function readNumbers() { state.reads += 1; return {}; }
export async function askNumbers() { state.models += 1; return {ok:true as const,value:{answer:"Synthetic answer"},left:0}; }
export async function makeReviewSummary() { state.models += 1; return {ok:true as const,summary:"Synthetic summary",fresh:true,left:0}; }
