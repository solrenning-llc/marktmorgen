import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";

const redis = new MemoryRedis();
const store = { sid: "d".repeat(32), statsId: "e".repeat(32), handle: "test-counter" } as Store;
export const state = { reply: ["OK", 1] as unknown, throws: false, commands: [] as (string | number)[][], helpers: 0, reads: 0, allowances: 0 };
export function reset(reply: unknown, throws = false) { redis.clear(); Object.assign(state, { reply, throws, commands: [], helpers: 0, reads: 0, allowances: 0 }); }
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.throws) throw new Error("Synthetic counter timeout");
  return state.reply as unknown[];
}
/** Explicit synthetic authentication, quota and supplier boundaries; route/guard remain actual. */
export async function guardStoreWrite(request: NextRequest) { return { ok: true as const, store, ref: "synthetic-ref", body: await request.json() as Record<string, unknown> }; }
export const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
export const MAX_QUESTION = 500;
export const NOT_COUNTED = "Not counted";
export const isAiConfigured = () => true;
export async function aiLeft() { return 1; }
export async function countUnits() { state.allowances += 1; return { ok: true as const }; }
export async function readNumbers() { state.reads += 1; return {}; }
export async function askNumbers() { state.helpers += 1; return { ok: true as const, value: { answer: "Synthetic answer" }, left: 0 }; }
export async function makeVoice() { state.helpers += 1; return { ok: true as const, summary: "Synthetic voice", fresh: true, left: 0 }; }
export async function makeReviewSummary() { state.helpers += 1; return { ok: true as const, summary: "Synthetic reviews", fresh: true, left: 0 }; }
