/**
 * Whether an address already has an account here, for taking a team
 * invitation (app/api/auth/join/route.ts): an existing account is only put on
 * the team and logs in the usual way, so a seven-day invitation link is never
 * a key to it.
 */
import { memberStores } from "@/lib/team";
import { STORE_ID_PATTERN } from "@/lib/store";
import { listPasskeys } from "@/lib/passkeys";
import { twoStepOn } from "@/lib/two-step";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether the address owns a store, read in its exact shape (R29 finding 2, CX-123 rule 24). The same two keys
 * lib/store.ts accountStores reads (its owner record and its account set; tests/r29-invite-unknown-account.test.ts
 * holds them equal), but accountStores takes a reply in another shape as "no store", and here that would log an
 * existing account in. Only a confirmed absent record (null) with a confirmed empty set (a list) is "no store"; a
 * record or a store id there is a store; any other reply throws UnknownReplyError, which the join route answers
 * with invite-error before the invitation is spent.
 */
async function ownsStore(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const address = email.toLowerCase();
  const replies = repliesFor(await redisPipeline([
    ["GET", `nl:store:owner:${(await sha256Hex(`nimbus-store:${address}`)).slice(0, 40)}`],
    ["SMEMBERS", `nl:account:stores:${(await sha256Hex(`nimbus-account-stores:${address}`)).slice(0, 40)}`],
  ]), 2);
  if (!replies) throw new UnknownReplyError("an address's own stores");
  const [owner, set] = replies;
  const ids = stringList(set);
  if ((owner !== null && (typeof owner !== "string" || owner === "")) || !ids) throw new UnknownReplyError("an address's own stores");
  return owner !== null || ids.some((id) => STORE_ID_PATTERN.test(id));
}

/**
 * A store of its own, a place on another store's team, a passkey, or two-step
 * login turned on: an address with an authenticator app is an account whose
 * login asks for its code, so an invitation must not open it without one.
 */
export async function hasAccount(email: string): Promise<boolean> {
  const [owned, member, passkeys, twoStep] = await Promise.all([ownsStore(email), memberStores(email), listPasskeys(email), twoStepOn(email)]);
  return owned || member.length > 0 || passkeys.length > 0 || twoStep;
}
