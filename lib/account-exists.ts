/**
 * Whether an address already has an account here, for taking a team
 * invitation (app/api/auth/join/route.ts): an existing account is only put on
 * the team and logs in the usual way, so a seven-day invitation link is never
 * a key to it.
 */
import { normaliseEmail } from "@/lib/auth";
import { readTeam } from "@/lib/team";
import { STORE_ID_PATTERN, storeForEmail } from "@/lib/store";
import { listPasskeys } from "@/lib/passkeys";
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
 * Whether two-step login is on for the address, read in its exact shape (R29 finding 2, rule 30; review of #3348).
 * The key lib/two-step.ts twoStepOn reads (tests/r29-invite-strict-siblings.test.ts holds them equal), but twoStepOn
 * takes a record in an odd shape as "off", and here that would log an account in without its code. Only a confirmed
 * absent record (null) is "off"; a record with its secret is "on"; anything else throws UnknownReplyError.
 */
async function twoStepRecorded(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["GET", `nl:2fa:${(await sha256Hex(`nimbus-2fa:${normaliseEmail(email)}`)).slice(0, 40)}`]]), 1);
  if (!replies) throw new UnknownReplyError("an address's two-step login");
  const raw = replies[0];
  if (raw === null) return false;
  let record: unknown = null;
  try {
    record = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof (record as { s?: unknown }).s !== "string") throw new UnknownReplyError("an address's two-step login");
  return true;
}

/**
 * Whether the address is on another store's team, read in its exact shape (R29 finding 2, rule 30; review of #3348).
 * The keys and the test lib/team.ts memberStores uses (its index, each team record, each store's id record;
 * tests/r29-invite-strict-siblings.test.ts holds the keys equal), but memberStores leaves out a store whose team or
 * record answers in an odd shape, and here that would log an account in. A team record or a store id record read
 * in an unknown shape, or a store id that names no store with that id, throws UnknownReplyError; a confirmed absent
 * store id is a store that is gone, as in memberStores. Read only: the index is not tidied here.
 */
async function onATeam(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const address = normaliseEmail(email);
  const index = repliesFor(await redisPipeline([["SMEMBERS", `nl:team:of:${(await sha256Hex(`nimbus-team-of:${address}`)).slice(0, 40)}`]]), 1);
  const ids = stringList(index?.[0]);
  if (!ids) throw new UnknownReplyError("a teammate's stores");
  for (const sid of ids.filter((id) => STORE_ID_PATTERN.test(id)).slice(0, 50)) {
    const team = await readTeam(sid);
    if (!team.members.some((m) => m.email === address)) continue;
    const ref = repliesFor(await redisPipeline([["GET", `nl:store:id:${sid}`]]), 1);
    if (!ref) throw new UnknownReplyError("a teammate's store");
    if (ref[0] === null) continue;
    if (typeof ref[0] !== "string" || ref[0] === "") throw new UnknownReplyError("a teammate's store");
    const store = await storeForEmail(ref[0]);
    if (!store || store.sid !== sid) throw new UnknownReplyError("a teammate's store");
    if (normaliseEmail(store.email) !== address) return true;
  }
  return false;
}

/**
 * A store of its own, a place on another store's team, a passkey, or two-step
 * login turned on: an address with an authenticator app is an account whose
 * login asks for its code, so an invitation must not open it without one.
 * Each is read in its exact shape; an unknown reply throws UnknownReplyError,
 * which the join route answers with invite-error before anything is spent.
 */
export async function hasAccount(email: string): Promise<boolean> {
  const [owned, member, passkeys, twoStep] = await Promise.all([ownsStore(email), onATeam(email), listPasskeys(email), twoStepRecorded(email)]);
  return owned || member || passkeys.length > 0 || twoStep;
}
