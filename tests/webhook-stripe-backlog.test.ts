/**
 * A store's Stripe events read without an anchor (its first run, or an anchor Stripe no longer knows, #4285, from
 * Codex P's hidden #3999). The read collected at most FIRST_RUN_PAGES pages newest-first, sent them, and set the
 * anchor to the newest event; nothing ever asked Stripe for the page after the last one read, so the older events
 * still inside Stripe's thirty days were skipped for good. Now a read that has not reached the oldest event keeps a
 * durable cursor (the oldest it read) and walks on next run, sending nothing and moving no anchor; once it reaches the
 * oldest event it sends from there, oldest first, sets the anchor, and later runs read forward as before. Every
 * event is handled once.
 * Synthetic only: an in-memory Redis and a stubbed Stripe /v1/events.
 */
import { addEndpoint, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_webhook_backlog_only";
const account = "acct_Backlog4285";
// 1,100 matching events, newest first, in eleven pages of 100.
const ids = Array.from({ length: 1100 }, (_, i) => `evt_Back${String(1100 - i).padStart(5, "0")}`);
const row = (id: string) => ({ id, type: "payment_intent.succeeded", data: { object: {} } });
const requests: URL[] = [];
let lostAnchor = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) {
    throw new Error("unexpected synthetic operation");
  }
  requests.push(url);
  const one = /^\/v1\/events\/(evt_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (one) return ids.includes(one[1]) ? Response.json(row(one[1])) : Response.json({ error: { message: "No such event" } }, { status: 404 });
  if (url.pathname !== "/v1/events") throw new Error("unexpected synthetic operation");
  const before = url.searchParams.get("ending_before");
  if (before && before === lostAnchor) return Response.json({ error: { message: "No such event" } }, { status: 404 });
  if (before) {
    const at = ids.indexOf(before);
    const newer = at <= 0 ? [] : ids.slice(Math.max(0, at - 100), at);
    return Response.json({ data: newer.map(row), has_more: at - 100 > 0 });
  }
  const after = url.searchParams.get("starting_after");
  if (after && !ids.includes(after)) return Response.json({ error: { message: "No such event" } }, { status: 400 });
  const from = after ? ids.indexOf(after) + 1 : 0;
  const page = ids.slice(from, from + 100);
  return Response.json({ data: page.map(row), has_more: from + 100 < ids.length });
}) as typeof fetch;

async function setup(email: string, anchor: string | null) {
  redis.clear();
  await claimHandle(email, "backlog-shop-4285", "Backlog Shop", "");
  await ensureStatsId(email);
  is("synthetic connected account is saved", (await setStripeAccount(email, account)).ok, true);
  const store = (await storeForEmail(email))!;
  is("endpoint listening to sale.completed", (await addEndpoint(store, "https://hooks.example.net/sales", ["sale.completed"])).ok, true);
  const key = `nl:hooks:anchor:${store.statsId}`;
  if (anchor) await redis.pipeline([["SET", key, anchor]]);
  requests.length = 0;
  return key;
}

/** Runs the five-minute job until a run handles nothing new (at most `most` runs); the events handled in all. */
async function drain(most: number): Promise<{ total: number; runs: number[] }> {
  const runs: number[] = [];
  for (let n = 0; n < most; n += 1) {
    const { events } = await watchStripe(Date.now() + 60_000);
    runs.push(events);
    if (n > 0 && events === 0 && runs[n - 1] === 0) break;
  }
  return { total: runs.reduce((a, b) => a + b, 0), runs };
}

async function main() {
  const page10Last = ids[999];
  const askedPage11 = () => requests.some((u) => u.searchParams.get("starting_after") === page10Last);
  const log = console.error;

  part("A: no anchor, eleven full pages since the configured start");
  let key = await setup("backlog-a@example.com", null);
  console.error = () => {};
  const first = await watchStripe(Date.now() + 60_000);
  console.error = log;
  is("the first run sends nothing yet: the oldest events are still unread", first.events, 0);
  is("and moves no anchor across the unread older events", (await redis.pipeline([["GET", key]]))[0], null);
  console.error = () => {};
  const rest = await drain(12);
  console.error = log;
  is("Stripe is asked for page eleven", askedPage11(), true);
  is("every one of the 1,100 events is handled, once", rest.total, 1100);
  is("the anchor ends at the newest event", (await redis.pipeline([["GET", key]]))[0], ids[0]);

  part("B: an anchor Stripe no longer knows (a pause longer than Stripe keeps it), read again from 29 days back");
  lostAnchor = "evt_GoneLongAgo01";
  key = await setup("backlog-b@example.com", lostAnchor);
  console.error = () => {};
  const resumed = await drain(12);
  console.error = log;
  is("the lost anchor answered 404 and the store was read again (diagnostic)", requests[0].searchParams.get("ending_before"), lostAnchor);
  is("Stripe is asked for page eleven", askedPage11(), true);
  is("every one of the 1,100 events still inside Stripe's 30 days is handled, once", resumed.total, 1100);

  part("C: the walk's cursor is the oldest event of all (Stripe has nothing older): it is read on its own, then forward");
  lostAnchor = "";
  key = await setup("backlog-c@example.com", null);
  const statsId = key.slice("nl:hooks:anchor:".length);
  await redis.pipeline([["SET", `nl:hooks:anchor:${statsId}:back`, ids[1099]]]);
  console.error = () => {};
  const fromOldest = await drain(12);
  console.error = log;
  is("the oldest event is read by itself", requests.some((u) => u.pathname === `/v1/events/${ids[1099]}`), true);
  is("and every event is handled once", fromOldest.total, 1100);

  part("D: a cursor Stripe no longer knows is let go of, and the walk starts again");
  key = await setup("backlog-d@example.com", null);
  await redis.pipeline([["SET", `${key}:back`, "evt_AgedOut0001"]]);
  console.error = () => {};
  const restarted = await drain(12);
  console.error = log;
  is("every event is still handled once", restarted.total, 1100);
  is("the stale cursor is gone", (await redis.pipeline([["GET", `${key}:back`]]))[0], null);

  part("E: the anchor's write refused when the walk ends: the cursor is kept, never both lost (Codex P on #4362)");
  key = await setup("backlog-e@example.com", null);
  const cursor = ids[999];
  await redis.pipeline([["SET", `${key}:back`, cursor]]);
  // Upstash answers a refused command inside a pipeline and runs the rest: the anchor's SET refused, anything else in
  // the same pipeline applied, then the call throws, as lib/redis.ts does on an error reply.
  const plain = redis.pipeline.bind(redis);
  let refused = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && c[1] === key)) {
      refused += 1;
      const rest = commands.filter((c) => !(c[0] === "SET" && c[1] === key));
      if (rest.length) await plain(rest);
      throw new Error("ERR synthetic refusal of the anchor's SET");
    }
    return plain(commands);
  }) as typeof redis.pipeline;
  console.error = () => {};
  await watchStripe(Date.now() + 60_000).catch(() => undefined);
  console.error = log;
  redis.pipeline = plain;
  is("the anchor's write was refused (diagnostic)", refused > 0, true);
  is("the cursor is still there, to walk on from", (await redis.pipeline([["GET", `${key}:back`]]))[0], cursor);

  part("F: the walk's cursor read in an unknown shape stops the round, the cursor untouched (Codex U on #4362)");
  key = await setup("backlog-f@example.com", null);
  const kept = ids[999];
  await redis.pipeline([["SET", `${key}:back`, kept]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = (await plain(commands)) as unknown[];
    return commands.map((c, i) => (c[0] === "GET" && c[1] === `${key}:back` ? undefined : replies[i]));
  }) as typeof redis.pipeline;
  requests.length = 0;
  console.error = () => {};
  const unknown = await watchStripe(Date.now() + 60_000).then(() => "resolved", () => "threw");
  console.error = log;
  redis.pipeline = plain;
  is("no Stripe page is read from the newest end", requests.filter((u) => u.pathname === "/v1/events" && !u.searchParams.has("starting_after") && !u.searchParams.has("ending_before")).length, 0);
  is("the cursor is still where the walk stood", (await redis.pipeline([["GET", `${key}:back`]]))[0], kept);
  console.log(`  (diagnostic: the round ${unknown})`);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
