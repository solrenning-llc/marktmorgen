/** Ephemeral, provider-separated OAuth state. No person or provider token is kept. */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
export const PROVIDER_STATE_SECONDS = 600;
const valid = (state: string) => /^(dsi|asi)\.[A-Za-z0-9_-]{43}$/.test(state);
const keyFor = (state: string) => `nl:auth:link:${createHash("sha256").update(`marktmorgen-provider-signin:${state}`).digest("hex").slice(0,40)}`;
export async function keepProviderSignInState(state: string, value: string): Promise<boolean> {
  if (!isRedisConfigured() || !valid(state) || Buffer.byteLength(value) > 1024) return false;
  try {
    const reply = await redisPipeline([["SET", keyFor(state), value, "EX", PROVIDER_STATE_SECONDS, "NX"]]);
    return Array.isArray(reply) && reply.length === 1 && reply[0] === "OK";
  } catch { return false; }
}
/** GETDEL is atomic. An uncertain reply never triggers a GET/DEL fallback. */
export async function takeProviderSignInState(state: string): Promise<string | null> {
  if (!isRedisConfigured() || !valid(state)) return null;
  try {
    const reply = await redisPipeline([["GETDEL", keyFor(state)]]);
    return Array.isArray(reply) && reply.length === 1 && typeof reply[0] === "string" && Buffer.byteLength(reply[0]) <= 1024 ? reply[0] : null;
  } catch { return null; }
}
