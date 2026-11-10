/**
 * Webhook counts read only in their exact shape (audit SG2, batch L4, CX-123
 * rule 24).
 *
 *   - sendTest and resendDelivery (lib/webhooks.ts) read the minute's INCR of
 *     tests with Number(): null, a missing reply or a negative was "under the
 *     limit", and the endpoint was called. An unknown count is now "limited",
 *     and no address is even looked up.
 *   - markGivenUp read the SADD/SCARD of the endpoints told of a passed-over
 *     Stripe event, and the ZCARD/ZREVRANK of the day's place, with Number():
 *     a null rank was place 0 and wrote a line of its own; text past the cap
 *     put the endpoint "over" and the event was passed over with nobody told.
 *     Now an unknown reply throws before anything is written or marked, as an
 *     unreadable numbering already did: the visit fails, the wait is kept, and
 *     the next visit gives the event up again and writes its line.
 *
 * The exact replies keep working as before. Synthetic Stripe answers only;
 * every name lookup is refused, so nothing leaves this machine.
 */
import { randomBytes } from "node:crypto";
import { MESSAGE_TEXT_MAX, STRIPE_WAIT_RUNS, TOO_LARGE_WORDS, addEndpoint, emitEvent, resendDelivery, sendTest, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sg2_l4_webhooks_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_Sg2L4Hooks01";
const HANDLE = "sg2-l4-hooks";
const OWNER = "sg2-l4-hooks@example.com";

/** Every endpoint address the code looked up, which is the first step of calling it; refused, so nothing is sent. */
const lookedUp: string[] = [];
setSendHooksForTests({ fetch: { resolve: async (host: string) => { lookedUp.push(host); throw new Error("a stand-in that answers nothing"); } } as never });

/** The account's events, oldest first; the list honors ending_before as Stripe does. */
let timeline: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || headers.get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  if (url.pathname === "/v1/events") {
    const before = url.searchParams.get("ending_before");
    const at = before ? timeline.findIndex((e) => e.id === before) : -1;
    return Response.json({ data: (at >= 0 ? timeline.slice(at + 1) : timeline).slice().reverse(), has_more: false });
  }
  // The one-off payment carries the store; the stuck one always fails on Stripe's end.
  if (url.pathname === "/v1/payment_intents/pi_Once") return Response.json({ id: "pi_Once", object: "payment_intent", metadata: { store: HANDLE, product: "p_course" } });
  if (url.pathname === "/v1/payment_intents/pi_Stuck") return Response.json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, { status: 500 });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
const logged = console.error;
console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("a webhook delivery failed") || line.startsWith("WEBHOOK EVENT GIVEN UP") || line.startsWith("reading a store's Stripe events failed") || line.startsWith("telling whose a payment is failed at Stripe")) return;
  logged(...args);
};

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

const tests = (commands: (string | number)[][]) => commands.length === 2 && commands[1]?.[0] === "INCR" && String(commands[1]?.[1]).startsWith("nl:rl:hooks:test:");
const endpointsTold = (commands: (string | number)[][]) => commands[0]?.[0] === "SADD" && String(commands[0]?.[1]).includes(":eps:");
const dayPlace = (commands: (string | number)[][]) => commands[0]?.[0] === "ZADD" && String(commands[0]?.[1]).includes(":day:");
const skippedDay = (commands: (string | number)[][]) => commands[0]?.[0] === "INCR" && String(commands[0]?.[1]).includes(":skip:");
const dayNumber = (commands: (string | number)[][]) => commands[0]?.[0] === "INCR" && String(commands[0]?.[1]).includes(":seq:");

/** Replies the minute's [SET NX, INCR] of tests must never be read from. */
const BAD_COUNTERS: [string, unknown][] = [
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a fractional count", ["OK", 0.5]],
  ["a negative count", ["OK", -1]],
  ["a count that is an object", ["OK", { result: 1 }]],
  ["a count that is true", ["OK", true]],
  ["a reply missing the count", ["OK"]],
  ["a third, unasked-for reply", ["OK", 1, 1]],
  ["a reply that is not a list", { result: 1 }],
  ["a Redis that cannot be asked", "throw"],
];

async function paidStore(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  return (await storeForEmail(email))!;
}

/** A delivery that failed for good, written as the queue leaves one. */
async function failedDelivery(store: Store, endpoint: string): Promise<string> {
  const id = `dlv_${randomBytes(12).toString("hex")}`;
  const now = Date.now();
  await pipeline([["SET", `nl:hooks:d:${id}`, JSON.stringify({ id, statsId: store.statsId, endpoint, eventId: `evt_${id}`, type: "sale.completed", body: "{\"id\":\"x\"}", attempts: 6, state: "failed", next: 0, lastStatus: 500, lastError: "", lastAt: now, createdAt: now }), "EX", 86400]]);
  return id;
}

/** A store waiting one visit before the cap on a Stripe event whose lookup keeps failing. */
async function stuckStore(): Promise<{ store: Store; statsId: string }> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "SG2 L4 Hooks", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, account);
  await setSubscription(OWNER, { customerId: "cus_Sg2L4Hooks", subscriptionId: "sub_Sg2L4Hooks", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  if (!(await addEndpoint(store, "https://hooks.example.net/in", ["dispute.opened"])).ok) throw new Error("the endpoint was not added");
  const dispute = (id: string, intent: string) => ({ id, object: "dispute", charge: `ch_${id}`, payment_intent: intent, amount: 2900, currency: "usd", reason: "product_not_received", status: "needs_response", evidence_details: { due_by: 1_791_000_000 }, metadata: {} });
  timeline = [
    { id: "evt_Before", type: "charge.dispute.created", created: 1_790_090_000, data: { object: dispute("dp_before", "pi_Once") } },
    { id: "evt_Stuck", type: "charge.dispute.created", created: 1_790_090_100, data: { object: dispute("dp_stuck", "pi_Stuck") } },
  ];
  await watchStripe(Date.now() + 10_000);
  await pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Stuck|${STRIPE_WAIT_RUNS - 1}|${Math.floor(Date.now() / 1000)}`, "EX", 30 * 86400]]);
  return { store, statsId };
}

async function main(): Promise<void> {
  redis.clear();

  part("sendTest: an endpoint is called only on a whole count under the minute's limit");
  const shop = await paidStore("sg2-l4-test@example.com", "sg2-l4-test");
  const added = await addEndpoint(shop, "https://hooks.example.com/tests", ["sale.completed"]);
  if (!added.ok) throw new Error("the endpoint was not added");
  const endpoint = (await webhooksView(shop)).endpoints[0]!.id;
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: tests, reply };
    const before = lookedUp.length;
    const got = await outcome(() => sendTest(shop, endpoint));
    is(`sendTest, ${label}: refused, the endpoint not called`, [got === "rejected" ? got : got.ok ? "sent" : got.reason, lookedUp.length - before], [reply === "throw" ? "rejected" : "limited", 0]);
  }
  rule = { when: tests, reply: ["OK", 11] };
  is("sendTest: one past the minute's limit is limited, as before", await outcome(() => sendTest(shop, endpoint)), { ok: false, reason: "limited" });
  for (const [label, reply] of [["the minute's last one (10)", ["OK", 10]], ["the real counter", null]] as [string, unknown][]) {
    rule = reply ? { when: tests, reply } : null;
    const before = lookedUp.length;
    const got = await sendTest(shop, endpoint);
    is(`sendTest: ${label} still calls the endpoint`, [got.ok, lookedUp.length - before], [true, 1]);
  }

  part("resendDelivery: a failed delivery is sent again only on a whole count under the minute's limit");
  const failed = await failedDelivery(shop, endpoint);
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: tests, reply };
    const before = lookedUp.length;
    const got = await outcome(() => resendDelivery(shop, failed));
    is(`resendDelivery, ${label}: refused, the endpoint not called`, [got === "rejected" ? got : got.ok ? "sent" : got.reason, lookedUp.length - before], [reply === "throw" ? "rejected" : "limited", 0]);
  }
  rule = { when: tests, reply: ["OK", 11] };
  is("resendDelivery: one past the minute's limit is limited, as before", await outcome(() => resendDelivery(shop, failed)), { ok: false, reason: "limited" });
  rule = { when: tests, reply: ["OK", 10] };
  {
    const before = lookedUp.length;
    const got = await resendDelivery(shop, failed);
    is("resendDelivery: the minute's last one (10) still calls the endpoint", [got.ok, lookedUp.length - before], [true, 1]);
  }
  rule = null;
  {
    const again = await failedDelivery(shop, endpoint);
    const before = lookedUp.length;
    const got = await resendDelivery(shop, again);
    is("resendDelivery: the real counter still calls the endpoint", [got.ok, lookedUp.length - before], [true, 1]);
  }

  part("skippedLines: a message too large to keep is said in the log only on a whole count for the day");
  const tooLarge = { notes: Array.from({ length: 300 }, () => "x".repeat(MESSAGE_TEXT_MAX)) };
  const largeLines = async () => (await webhooksView(shop)).log.filter((d) => d.lastError === TOO_LARGE_WORDS).length;
  let large = 0;
  for (const [label, reply] of [
    ["INCR as text", ["3", 1]],
    ["INCR true", [true, 1]],
    ["INCR null", [null, 1]],
    ["INCR zero", [0, 1]],
    ["INCR fractional", [1.5, 1]],
    ["INCR negative", [-1, 1]],
    ["INCR an object", [{ result: 1 }, 1]],
    ["a reply missing the EXPIREAT", [1]],
    ["a third, unasked-for reply", [1, 1, 1]],
    ["a reply that is not a list", { result: 1 }],
  ] as [string, unknown][]) {
    rule = { when: skippedDay, reply };
    const before = await largeLines();
    large += 1;
    // Thrown, so emitEvent takes the event's mark back and it is noticed again (its caller, lib/webhooks.ts emitEvent).
    is(`skippedLines, ${label}: thrown, no line written`, [await outcome(() => emitEvent(shop, "sale.completed", `sg2-l4-large-${large}`, tooLarge)), (await largeLines()) - before], ["rejected", 0]);
  }
  rule = { when: skippedDay, reply: [1, 1] };
  {
    const before = await largeLines();
    is("skippedLines: the day's first one (1) still gets its line", [await emitEvent(shop, "sale.completed", "sg2-l4-large-first", tooLarge), (await largeLines()) - before], [0, 1]);
  }
  rule = null;
  {
    const before = await largeLines();
    is("skippedLines: the real counter still writes its line", [await emitEvent(shop, "sale.completed", "sg2-l4-large-real", tooLarge), (await largeLines()) - before], [0, 1]);
  }

  part("A passed-over Stripe event: the endpoints told are counted only in their exact shape");
  const lines = async (store: Store) => (await webhooksView(store)).log.filter((d) => d.givenUp && d.lastError.includes("dp_stuck")).length;
  const wait = async (statsId: string) => {
    const [raw] = await pipeline([["GET", `nl:hooks:wait:${statsId}`]]);
    return typeof raw === "string" ? raw.split("|").slice(0, 2).join("|") : raw;
  };
  const waiting = `evt_Stuck|${STRIPE_WAIT_RUNS - 1}`;
  for (const [label, reply] of [
    ["SADD and SCARD null", [null, null, 1]],
    ["SADD and SCARD as text, past the cap", ["1", "9", 1]],
    ["SCARD as text", [1, "1", 1]],
    ["SCARD fractional", [1, 0.5, 1]],
    ["SCARD negative", [1, -1, 1]],
    ["SADD true", [true, 1, 1]],
    ["SADD an object", [{ result: 1 }, 1, 1]],
    ["SADD past one member", [2, 1, 1]],
    ["a reply missing the EXPIREAT", [1, 1]],
    ["a fourth, unasked-for reply", [1, 1, 1, 1]],
    ["a reply that is not a list", { result: 1 }],
  ] as [string, unknown][]) {
    const { store, statsId } = await stuckStore();
    rule = { when: endpointsTold, reply };
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: no line written, nothing marked, the event still waits`, [await lines(store), await wait(statsId)], [0, waiting]);
    rule = null;
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: the next visit gives it up and tells the endpoint`, [await lines(store), await wait(statsId)], [1, null]);
  }

  part("A passed-over Stripe event: its place in the day is counted only in its exact shape");
  for (const [label, reply] of [
    ["ZREVRANK null", [1, 1, null, 1]],
    ["ZCARD and ZREVRANK as text", [1, "1", "0", 1]],
    ["ZCARD null", [1, null, 0, 1]],
    ["ZREVRANK fractional", [1, 1, 0.5, 1]],
    ["ZREVRANK negative", [1, 2, -1, 1]],
    ["ZCARD true", [1, true, 0, 1]],
    ["ZREVRANK an object", [1, 1, { result: 0 }, 1]],
    ["a reply missing the EXPIREAT", [1, 1, 0]],
    ["a fifth, unasked-for reply", [1, 1, 0, 1, 1]],
  ] as [string, unknown][]) {
    const { store, statsId } = await stuckStore();
    rule = { when: dayPlace, reply };
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: no line written, nothing marked, the event still waits`, [await lines(store), await wait(statsId)], [0, waiting]);
    rule = null;
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: the next visit gives it up and tells the endpoint`, [await lines(store), await wait(statsId)], [1, null]);
  }

  part("A passed-over Stripe event: its number for the day is read only as a whole number from 1 up");
  for (const [label, reply] of [
    ["INCR as text", ["1", 1]],
    ["INCR true", [true, 1]],
    ["INCR null", [null, 1]],
    ["INCR zero", [0, 1]],
    ["INCR fractional", [1.5, 1]],
    ["INCR negative", [-1, 1]],
    ["INCR an object", [{ result: 1 }, 1]],
    ["a reply missing the EXPIREAT", [1]],
    ["a third, unasked-for reply", [1, 1, 1]],
    ["a reply that is not a list", { result: 1 }],
  ] as [string, unknown][]) {
    const { store, statsId } = await stuckStore();
    rule = { when: dayNumber, reply };
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: no line written, nothing marked, the event still waits`, [await lines(store), await wait(statsId)], [0, waiting]);
    rule = null;
    await watchStripe(Date.now() + 10_000);
    is(`markGivenUp, ${label}: the next visit gives it up and tells the endpoint`, [await lines(store), await wait(statsId)], [1, null]);
  }
  {
    const { store, statsId } = await stuckStore();
    rule = { when: dayNumber, reply: [1, 1] };
    await watchStripe(Date.now() + 10_000);
    is("markGivenUp: the day's first number (1) still gives it up with its line", [await lines(store), await wait(statsId)], [1, null]);
  }

  part("A passed-over Stripe event, exact replies: as before");
  {
    const { store, statsId } = await stuckStore();
    rule = { when: endpointsTold, reply: [1, 1, 1] };
    await watchStripe(Date.now() + 10_000);
    is("the first endpoint told today gets its line", [await lines(store), await wait(statsId)], [1, null]);
  }
  {
    const { store, statsId } = await stuckStore();
    rule = { when: endpointsTold, reply: [1, 6, 1] };
    await watchStripe(Date.now() + 10_000);
    is("one past the day's MAX_ENDPOINTS is said in the server's log only, and the event passed over", [await lines(store), await wait(statsId)], [0, null]);
  }
  {
    const { store, statsId } = await stuckStore();
    rule = null;
    await watchStripe(Date.now() + 10_000);
    is("the real replies still give it up with its line", [await lines(store), await wait(statsId)], [1, null]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
