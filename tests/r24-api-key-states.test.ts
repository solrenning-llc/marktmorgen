/**
 * An API key's state read in another shape is unknown (lib/api-keys.ts keyStates, keyRecords, rewriteMakers;
 * CX-123 rule 24).
 *
 * Before: keyStates read a key record list in another shape as "gone" (revoked), so lib/webhooks.ts skipped
 * the endpoint that key added (a paid sale.completed never queued) or failed its delivery for good; and it read a
 * hold list in another shape, or a hold it does not know, as no hold, so a paused key's endpoint was sent to.
 * keyRecords, which every pass of lib/api-key-pause.ts reads (a teammate leaving, a role change, the two-step
 * rule), read a list in another shape as no keys and an unknown hold as none: a teammate taken off the team
 * while the list read so kept a key that worked again once they were invited back. Now each of these throws
 * UnknownReplyError: the delivery stays queued, the endpoint's event is queued and held until the key reads, and
 * the removal is refused (the person stays on the team) until the list reads. A hold this code does not know is
 * read as a refusing hold, "unknown", never no hold and never a failed list (tests/r24-api-key-hold-team.test.ts).
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no email or webhook leaves.
 */
import { keyRecords, keyStates, makeKey, resolveKey, rewriteMakers, swapHolds } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { UnknownReplyError } from "@/lib/redis-reply";
import { putMember, readTeam, removeMember } from "@/lib/team";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { addEndpoint, emitEvent, setSendHooksForTests } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** While set, the reply to each command it matches is replaced by what it returns. */
let bend: ((command: (string | number)[], reply: unknown) => unknown) | null = null;
/** While set, a pipeline that starts with this command and key answers one reply short. */
let short: [string, string] | null = null;
redis.pipeline = (async (commands: Commands) => {
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  if (short && commands[0]?.[0] === short[0] && commands[0]?.[1] === short[1]) return replies.slice(0, -1);
  return replies;
}) as typeof redis.pipeline;

/** How a promise ended: its value (a Map as an object, to be read in a failure), or "unknown" for UnknownReplyError, or the other error's message. */
async function outcome<T>(work: Promise<T>): Promise<unknown> {
  try {
    const value = await work;
    return value instanceof Map ? Object.fromEntries(value) : value;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner-states@example.com";
  const FAY = "fay-states@example.com";
  await claimHandle(OWNER, "key-states-shop", "Key States Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_KeyStates001", subscriptionId: "sub_KeyStates001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const sid = store.sid;
  const list = `nl:api:keys:${sid}`;
  const holds = `nl:api:hold:${sid}`;

  const live = await makeKey(sid, "Live sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  const held = await makeKey(sid, "Held sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  if (!live.ok || !held.ok) throw new Error("setup: keys not made");
  await swapHolds(sid, [held.made.id], "paused", [null]);
  const gone = "0123456789ab";

  part("Known replies read as before");
  const known = await keyStates(sid, [live.made.id, held.made.id, gone]);
  is("live, paused and gone", [known.get(live.made.id), known.get(held.made.id), known.get(gone)], ["live", "paused", "gone"]);

  part("A key list read in another shape is unknown, never every key revoked");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list ? "off-shape" : reply);
  is("a list that is not a list", await outcome(keyStates(sid, [live.made.id])), "unknown");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list ? (reply as unknown[]).slice(0, 1) : reply);
  is("a list one slot short", await outcome(keyStates(sid, [live.made.id, held.made.id])), "unknown");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list ? [42] : reply);
  is("a slot that is neither a record nor nothing", await outcome(keyStates(sid, [live.made.id])), "unknown");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list ? ["{not json"] : reply);
  is("a record that does not read", await outcome(keyStates(sid, [live.made.id])), "unknown");
  bend = null;
  short = ["HMGET", list];
  is("a pipeline missing a reply", await outcome(keyStates(sid, [live.made.id])), "unknown");
  short = null;

  part("A hold read in another shape is unknown; one this code does not know refuses the key; never no hold");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === holds ? "off-shape" : reply);
  is("a paused key's hold list in another shape is not live", await outcome(keyStates(sid, [held.made.id])), "unknown");
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === holds ? ["suspended"] : reply);
  is("a hold this code does not know is not live: paused", await outcome(keyStates(sid, [held.made.id])), { [held.made.id]: "paused" });
  bend = null;

  part("A webhook event for an endpoint an API key added is not dropped on an unknown key state");
  const added = await addEndpoint(store, "https://hooks.example.com/key-states", ["sale.completed"], Date.now(), live.made.id);
  if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list ? "off-shape" : reply);
  const emitted = await outcome(emitEvent(store, "sale.completed", "cs_test_keystates01", { amount_cents: 6900 }));
  bend = null;
  // The event is written for that endpoint and held by its try until the key reads (lib/webhooks.ts liveEndpoints
  // keepUnread): the callers that only log (PayPal, calls, free downloads) no longer lose it (Claude 2 on #3096).
  is("the event is queued for the endpoint, never sent to nobody", emitted, 1);
  is("and it is marked written, so it is not written twice", await outcome(emitEvent(store, "sale.completed", "cs_test_keystates01", { amount_cents: 6900 })), 0);

  part("keyRecords, as every pass of lib/api-key-pause.ts reads it, never reads unknown as no keys or no hold");
  bend = (c, reply) => (c[0] === "HGETALL" && c[1] === list ? "off-shape" : reply);
  is("a list in another shape", await outcome(keyRecords(sid)), "unknown");
  bend = (c, reply) => (c[0] === "HGETALL" && c[1] === holds ? "off-shape" : reply);
  is("a hold list in another shape", await outcome(keyRecords(sid)), "unknown");
  bend = (c, reply) => (c[0] === "HGETALL" && c[1] === holds ? [held.made.id, "suspended"] : reply);
  const odd = await outcome(keyRecords(sid));
  is("a hold this code does not know is read as unknown (refusing), the list still reads", Array.isArray(odd) ? (odd as { id: string; hold: unknown }[]).find((k) => k.id === held.made.id)?.hold : odd, "unknown");
  bend = (c, reply) => (c[0] === "HGETALL" && c[1] === list ? "off-shape" : reply);
  is("rewriteMakers on a list in another shape is not done, never nothing to rewrite", await outcome(rewriteMakers(sid, () => null)), "unknown");
  bend = null;

  part("A teammate taken off while the key list reads in another shape");
  await putMember(store, FAY, "admin");
  const fays = await makeKey(sid, "Fay's sync", Date.now(), false, "none", makerFor(sid, "admin", FAY, true));
  if (!fays.ok) throw new Error("setup: Fay's key not made");
  is("setup: Fay's key works while she is on the team", (await resolveKey(fays.key))?.paused, false);
  bend = (c, reply) => (c[0] === "HGETALL" && c[1] === list ? "off-shape" : reply);
  const removed = await outcome(removeMember(store, FAY));
  bend = null;
  is("the removal is refused while the keys cannot be read", removed, "unknown");
  is("so she is still on the team, nothing half done", (await readTeam(sid)).members.some((m) => m.email === FAY), true);
  is("once the list reads, she is taken off", await removeMember(store, FAY), true);
  is("her key is held for good", (await keyRecords(sid)).find((k) => k.id === fays.made.id)?.hold, "left");
  await putMember(store, FAY, "admin");
  is("invited back, her old key stays refused", (await resolveKey(fays.key))?.paused, true);

  done();
}
void main();
