/**
 * A key hold this code does not know, or a team record that does not read, is a refusal, never a key that
 * works; and one key whose state cannot be read holds back only its own endpoint (lib/api-keys.ts keyStates,
 * keyRecords, resolveKey; lib/webhooks.ts emitEvent). Review of #3096 by Claude 2 (comment 6712022526).
 *
 * Before: a hold outside HOLDS (a later version's value after a rollback, say "suspended") let resolveKey
 * accept the key while keyStates, keyRecords, shownKeys, revokeChecked and removeMember threw, so the owner
 * could no longer see or revoke a key that still opened the store, nor take its maker off the team. A team
 * record that did not read was taken as no team, so the two-step rule was off and an unrecorded key worked.
 * One key whose state could not be read failed a webhook event for every endpoint of the store, and the
 * callers that only log (PayPal, calls, free downloads) lost it.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no email or webhook leaves.
 */
import { createHash } from "node:crypto";
import { keyRecords, keyStates, makeKey, resolveKey } from "@/lib/api-keys";
import { makerFor, revokeChecked, shownKeys } from "@/lib/api-key-pause";
import { UnknownReplyError } from "@/lib/redis-reply";
import { putMember, readTeam, removeMember } from "@/lib/team";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { QUEUE_KEY, addEndpoint, emitEvent, eventIdFor, setSendHooksForTests } from "@/lib/webhooks";
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
redis.pipeline = (async (commands: Commands) => {
  const [only] = commands;
  // The webhook queue's lease (lib/webhooks.ts LEASE_SCRIPT), modelled as tests/webhooks-delivery.test.ts does, so
  // emitEvent's first try really runs and the hold below is proven by it (Claude 2 on #3096, comment 6712352850).
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await real([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await real([["ZADD", key, Number(until), member]]);
    return [1];
  }
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  return replies;
}) as typeof redis.pipeline;

/** How a promise ended: its value (a Map as an object), "unknown" for UnknownReplyError, or the other error's message. */
async function outcome<T>(work: Promise<T>): Promise<unknown> {
  try {
    const value = await work;
    return value instanceof Map ? Object.fromEntries(value) : value;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

async function shop(owner: string, handle: string, n: string) {
  await claimHandle(owner, handle, `Shop ${n}`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_HoldTeam00${n}`, subscriptionId: `sub_HoldTeam00${n}`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();

  part("A hold this code does not know refuses the key, and the owner can still see and revoke it");
  const OWNER = "owner-hold@example.com";
  const FAY = "fay-hold@example.com";
  const store = await shop(OWNER, "hold-team-shop", "1");
  const sid = store.sid;
  const live = await makeKey(sid, "Live sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  const odd = await makeKey(sid, "Odd sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  if (!live.ok || !odd.ok) throw new Error("setup: keys not made");
  await real([["HSET", `nl:api:hold:${sid}`, odd.made.id, "suspended"]]);
  is("resolveKey refuses it (paused), never accepts it", (await outcome(resolveKey(odd.key).then((r) => r?.paused))), true);
  is("keyStates reads it as paused and the other key as live, the list does not fail", await outcome(keyStates(sid, [live.made.id, odd.made.id])), { [live.made.id]: "live", [odd.made.id]: "paused" });
  const records = await outcome(keyRecords(sid));
  is("keyRecords lists both keys, the odd one with an unknown hold", Array.isArray(records) ? (records as { id: string; hold: unknown }[]).map((k) => [k.id, k.hold]) : records, [[live.made.id, null], [odd.made.id, "unknown"]]);
  const shown = await outcome(shownKeys(store, OWNER, "owner"));
  const oddShown = Array.isArray(shown) ? (shown as { id: string; paused: boolean; why: unknown; mayTurnOn: boolean; mayRevoke: boolean }[]).find((k) => k.id === odd.made.id) : undefined;
  is("the studio shows it to the owner, paused, not offered to turn on, offered to revoke", oddShown ? [oddShown.paused, oddShown.why, oddShown.mayTurnOn, oddShown.mayRevoke] : shown, [true, "unknown", false, true]);
  is("the owner revokes it", await outcome(revokeChecked(store, "owner", odd.made.id)), "ok");
  is("and it opens nothing any more", await outcome(resolveKey(odd.key)), null);

  part("A teammate whose key has a hold this code does not know can still be taken off the team");
  await putMember(store, FAY, "admin");
  const fays = await makeKey(sid, "Fay's sync", Date.now(), false, "none", makerFor(sid, "admin", FAY, true));
  if (!fays.ok) throw new Error("setup: Fay's key not made");
  await real([["HSET", `nl:api:hold:${sid}`, fays.made.id, "suspended"]]);
  is("her key is refused meanwhile", await outcome(resolveKey(fays.key).then((r) => r?.paused)), true);
  is("the removal goes through", await outcome(removeMember(store, FAY)), true);
  is("she is off the team", (await readTeam(sid)).members.some((m) => m.email === FAY), false);
  await putMember(store, FAY, "admin");
  is("invited back, her old key stays refused", await outcome(resolveKey(fays.key).then((r) => r?.paused)), true);

  part("A team record that does not read never turns the two-step rule off");
  const OWNER2 = "owner-team@example.com";
  const store2 = await shop(OWNER2, "team-read-shop", "2");
  const sid2 = store2.sid;
  // An older key: nobody is recorded as its maker, so the two-step rule pauses it.
  const old = await makeKey(sid2, "Old sync", Date.now(), false, "none");
  if (!old.ok) throw new Error("setup: old key not made");
  const team = `nl:team:${sid2}`;
  await real([["SET", team, JSON.stringify({ members: [], invites: [], requireTwoStep: true })]]);
  is("setup: under the rule the old key is paused", [(await resolveKey(old.key))?.paused, (await keyStates(sid2, [old.made.id])).get(old.made.id)], [true, "paused"]);
  const notLive = async (label: string) => {
    const resolved = await outcome(resolveKey(old.key).then((r) => r?.paused));
    is(`${label}: resolveKey never accepts the key`, resolved === true || resolved === "unknown", true);
    const states = await outcome(keyStates(sid2, [old.made.id]));
    is(`${label}: keyStates never reads it as live`, states === "unknown" || (typeof states === "object" && (states as Record<string, string>)[old.made.id] === "paused"), true);
  };
  await real([["SET", team, "{not json"]]);
  await notLive("broken JSON");
  await real([["SET", team, JSON.stringify({ members: [null], invites: [], requireTwoStep: true })]]);
  await notLive("a member entry that is not an object");
  await real([["SET", team, JSON.stringify({ members: [], invites: [], requireTwoStep: "yes" })]]);
  await notLive("a rule that is not true or false");
  await real([["SET", team, JSON.stringify({ requireTwoStep: true })]]);
  await notLive("a record without its lists");
  await real([["SET", team, JSON.stringify({ members: [], invites: [], requireTwoStep: true })]]);
  bend = (c, reply) => (c[0] === "GET" && c[1] === team ? 42 : reply);
  await notLive("a reply that is not text");
  bend = null;
  await real([["DEL", team]]);
  is("no team record at all (null) is still no team: the key works", [(await resolveKey(old.key))?.paused, (await keyStates(sid2, [old.made.id])).get(old.made.id)], [false, "live"]);

  part("One key whose state cannot be read holds back only its own endpoint; the others are sent the event");
  const OWNER3 = "owner-hooks@example.com";
  const store3 = await shop(OWNER3, "hold-hooks-shop", "3");
  const sid3 = store3.sid;
  const unread = await makeKey(sid3, "Unread sync", Date.now(), false, "none", makerFor(sid3, "owner", OWNER3, true));
  const paused = await makeKey(sid3, "Paused sync", Date.now(), false, "none", makerFor(sid3, "owner", OWNER3, true));
  if (!unread.ok || !paused.ok) throw new Error("setup: keys not made");
  await real([["HSET", `nl:api:hold:${sid3}`, paused.made.id, "paused"]]);
  for (const [url, by] of [["https://hooks.example.com/studio", ""], ["https://hooks.example.com/unread", unread.made.id], ["https://hooks.example.com/paused", paused.made.id]]) {
    const added = await addEndpoint(store3, url, ["sale.completed"], Date.now(), by);
    if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  }
  const [cfg] = await real([["GET", `nl:hooks:cfg:${store3.statsId}`]]);
  const endpoints = (JSON.parse(String(cfg)) as { endpoints: { id: string; url: string }[] }).endpoints;
  const endpointOf = (tail: string) => endpoints.find((e) => e.url.endsWith(tail))!.id;
  const list3 = `nl:api:keys:${sid3}`;
  // Only a read that asks for the unread key's record comes back in another shape.
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === list3 && c.includes(unread.made.id) ? "off-shape" : reply);
  const seed = "PAYPAL-SALE-HOLDTEAM01";
  const emitted = await outcome(emitEvent(store3, "sale.completed", seed, { amount_cents: 6900 }));
  bend = null;
  is("the event is written for the studio endpoint and the unread key's endpoint, not the paused key's", emitted, 2);
  const eventId = eventIdFor(store3.statsId!, "sale.completed", seed);
  const deliveryOf = async (tail: string) => {
    const id = `dlv_${createHash("sha256").update(`${eventId}|${endpointOf(tail)}`).digest("hex").slice(0, 24)}`;
    const [raw, due] = await real([["GET", `nl:hooks:d:${id}`], ["ZSCORE", QUEUE_KEY, `${store3.statsId}|${id}`]]);
    const delivery = typeof raw === "string" ? (JSON.parse(raw) as { state: string; attempts: number; lastError: string }) : null;
    return { delivery, queued: due !== null };
  };
  // Both first tries ran (the lease is modelled). No network here: the studio endpoint's try was made and could not
  // reach it; the unread key's try read the key again first (attempt, heldNow) and never called its endpoint.
  const studio = await deliveryOf("/studio");
  is("the studio endpoint's delivery was tried and waits for its next try", [studio.delivery?.state, studio.delivery?.attempts, studio.queued, /could not be read/.test(studio.delivery?.lastError ?? "")], ["retrying", 1, true, false]);
  const held = await deliveryOf("/unread");
  is("the unread key's endpoint is held back, not dropped: its try counted, the endpoint never called, still on the queue",
    [held.delivery?.state, held.delivery?.attempts, held.queued, /could not be read/.test(held.delivery?.lastError ?? "")], ["retrying", 1, true, true]);
  is("the paused key's endpoint gets nothing, as before", (await deliveryOf("/paused")).delivery, null);

  done();
}
void main();
