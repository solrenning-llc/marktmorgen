import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { prepareTeamsAuthorization, openConsumedTeamsAuthorization, TEAMS_STATE_TTL_SECONDS, type TeamsBinding } from "./microsoft-teams-authorization-state";

export const TEAMS_PENDING_BYTES = 2048;

type Permission = (storeId: string, actor: string) => Promise<boolean>;
const key = (state: string) => "nl:teams:state:" + createHash("sha256").update(state).digest("hex");

/** A one-command receipt must contain one own data slot and no extra results. */
function onlyReply(replies: unknown): unknown {
  if (!Array.isArray(replies) || replies.length !== 1 || Reflect.ownKeys(replies).length !== 2) return undefined;
  const slot = Object.getOwnPropertyDescriptor(replies, "0");
  return slot && "value" in slot ? slot.value : undefined;
}
/**
 * Unconnected server helper. Future start route must first enforce approval,
 * signed-in identity, origin, settings permission and existing rate/cost gates.
 * reserve pays for this pending write before it happens; unknown refuses.
 */
export async function keepTeamsAuthorization(binding: TeamsBinding, mayManage: Permission, reserve: () => Promise<boolean>, now = Date.now()) {
  if (!isRedisConfigured()) return null;
  const prepared = prepareTeamsAuthorization(binding, now);
  if (!prepared) return null;
  try {
    if ((await mayManage(binding.storeId, binding.actor)) !== true || (await reserve()) !== true) return null;
    if (Buffer.byteLength(prepared.sealed, "utf8") > TEAMS_PENDING_BYTES) return null;
    const written = onlyReply(await redisPipeline([["SET", key(prepared.state), prepared.sealed, "NX", "EX", TEAMS_STATE_TTL_SECONDS]]));
    if (written !== "OK") return null;
    return { state: prepared.state, nonce: prepared.nonce, challenge: prepared.challenge, expires: prepared.expires };
  } catch { return null; }
}

/** GETDEL consumes once even when a wrong session/actor/permission is presented. */
export async function takeTeamsAuthorization(state: string, binding: TeamsBinding, mayManage: Permission, now = Date.now()): Promise<{ verifier: string; nonce: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(state) || !isRedisConfigured()) return null;
  try {
    const sealed = onlyReply(await redisPipeline([["GETDEL", key(state)]]));
    if (typeof sealed !== "string") return null;
    const opened = openConsumedTeamsAuthorization(state, sealed, binding, now);
    if (!opened || (await mayManage(binding.storeId, binding.actor)) !== true) return null;
    return opened;
  } catch { return null; }
}
